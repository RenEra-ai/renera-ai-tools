import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVersion, latestThreadIdFromIndex, listLiveDaemons, doctorReport } from '../lib/doctor.mjs';

const DIRS = [];
const SERVERS = [];
after(() => {
  for (const s of SERVERS) { try { s.close(); } catch { /* best effort */ } }
  SERVERS.length = 0;
  for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  DIRS.length = 0;
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'cdx-doctor-'));
  DIRS.push(d);
  return d;
}

/** A daemon stand-in that answers `status` like lib/daemon.mjs does. */
function statusServer(baseDir, name, reply) {
  const socket = join(baseDir, name);
  const server = createServer((sock) => {
    sock.setEncoding('utf8');
    sock.on('data', () => { if (reply) sock.write(`${JSON.stringify(reply)}\n`); });
    sock.on('error', () => {});
  });
  server.listen(socket);
  SERVERS.push(server);
  return { socket, server };
}

test('parseVersion extracts a semver from `codex --version` output', () => {
  assert.equal(parseVersion('codex-cli 0.130.0'), '0.130.0');
  assert.equal(parseVersion('codex 1.2.3\n'), '1.2.3');
});

test('latestThreadIdFromIndex picks the newest non-archived thread for a cwd', () => {
  const rows = [
    { id: 'old', cwd: '/repo', archived: 0, updated_at_ms: 100 },
    { id: 'new', cwd: '/repo', archived: 0, updated_at_ms: 300 },
    { id: 'newer-archived', cwd: '/repo', archived: 1, updated_at_ms: 400 },
    { id: 'other', cwd: '/elsewhere', archived: 0, updated_at_ms: 500 },
  ];
  assert.equal(latestThreadIdFromIndex(rows, '/repo'), 'new');
});

test('listLiveDaemons reports a live responder with its status fields', async () => {
  // The case the incident needed: a finished-but-unstopped orphan whose socket file is its only
  // on-disk trace. Doctor must surface it, turnStatus and all, instead of leaving the dispatcher to
  // tell the user "no turn was ever sent".
  const baseDir = tmp();
  const st = { pid: 4242, threadId: 'thread-live', turnStatus: 'completed', parked: null,
    cwd: '/some/repo', lastEventAgoMs: 1682526, eventCount: 5712, restartRequired: false };
  const { socket } = statusServer(baseDir, 'd-1-live.sock', st);
  const daemons = await listLiveDaemons({ baseDir, timeoutMs: 2000 });
  assert.deepEqual(daemons, [{ socket, pid: 4242, threadId: 'thread-live', turnStatus: 'completed',
    cwd: '/some/repo', lastEventAgoMs: 1682526 }]);
});

test('a pre-1.8.21 daemon (no pid in status) is reported without one, not dropped', async () => {
  const baseDir = tmp();
  const { socket } = statusServer(baseDir, 'd-1-old.sock',
    { threadId: 't-old', turnStatus: 'running', cwd: '/r', lastEventAgoMs: 5 });
  const daemons = await listLiveDaemons({ baseDir, timeoutMs: 2000 });
  assert.equal(daemons.length, 1);
  assert.equal(daemons[0].socket, socket);
  assert.equal('pid' in daemons[0], false);
  assert.equal(daemons[0].turnStatus, 'running');
});

test('a socket file whose daemon was killed is PRUNED; everything less provable is not', async () => {
  // The killed-daemon shape is the one that leaves a socket file behind FOREVER: a graceful close
  // unlinks it, so only a SIGKILLed (or crashed) listener produces the orphan. ECONNREFUSED/ENOENT
  // is the same provably-dead rule `start` uses before replacing a recorded session.
  const baseDir = tmp();
  const dead = join(baseDir, 'd-2-dead.sock');
  const child = spawn(process.execPath, ['-e',
    'const s=require("node:net").createServer(()=>{});s.listen(process.argv[1],()=>console.log("ready"));setInterval(()=>{},1000);',
    dead]);
  await new Promise((resolve) => child.stdout.on('data', resolve));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(existsSync(dead), true, 'a killed listener must leave its socket file behind');

  // A `.sock`-NAMED regular file is not a dead daemon (connect says ENOTSOCK, not ECONNREFUSED):
  // reported as an error, never deleted — prune only what is PROVABLY a dead daemon's socket.
  const notASocket = join(baseDir, 'd-3-file.sock');
  writeFileSync(notASocket, '');
  writeFileSync(join(baseDir, 'state.json'), '{}');
  writeFileSync(join(baseDir, 'd-4-old.sock.err'), 'boot failed');

  const daemons = await listLiveDaemons({ baseDir, timeoutMs: 2000 });
  assert.equal(daemons.length, 1);
  assert.equal(daemons[0].socket, notASocket);
  assert.match(daemons[0].error, /not a socket/);
  assert.equal(existsSync(dead), false, 'the dead socket file must be pruned');
  assert.equal(existsSync(notASocket), true, 'a non-socket file is never pruned');
  assert.equal(existsSync(join(baseDir, 'state.json')), true);
  assert.equal(existsSync(join(baseDir, 'd-4-old.sock.err')), true);
});

test('a wedged daemon (accepts, never replies) is reported with an error and NOT pruned', async () => {
  // A busy daemon is a live daemon: mid-ultra-turn silence is normal, so a probe timeout must never
  // cost the socket. Same reason there is no TTL/reaper at all.
  const baseDir = tmp();
  const { socket } = statusServer(baseDir, 'd-4-wedged.sock', null);
  const daemons = await listLiveDaemons({ baseDir, timeoutMs: 200 });
  assert.equal(daemons.length, 1);
  assert.equal(daemons[0].socket, socket);
  assert.match(daemons[0].error, /timeout/);
  assert.equal(existsSync(socket), true, 'a wedged socket must never be pruned');
});

test('a missing base dir is an empty list, and doctorReport carries the daemons alongside health', async () => {
  assert.deepEqual(await listLiveDaemons({ baseDir: join(tmp(), 'no-such-dir') }), []);
  const baseDir = tmp();
  statusServer(baseDir, 'd-5-live.sock', { pid: 7, threadId: 't', turnStatus: 'idle', cwd: '/r', lastEventAgoMs: null });
  const report = await doctorReport({ baseDir, timeoutMs: 2000 });
  assert.ok('codexVersion' in report && 'authPresent' in report && 'threads' in report);
  assert.equal(report.daemons.length, 1);
  assert.equal(report.daemons[0].turnStatus, 'idle');
});
