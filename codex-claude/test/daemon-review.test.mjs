import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Daemon } from '../lib/daemon.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));
const REVIEW_PROFILE = { sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true };

function rpcCall(socketPath, cmdObj) {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(cmdObj) + '\n'));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { sock.end(); resolve(JSON.parse(buf.slice(0, i))); }
    });
    sock.on('error', reject);
  });
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A real repo: git-scope shells out for real, so the daemon needs a genuine dirty tree to resolve.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-dr-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  const first = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');   // dirty -> auto resolves to working-tree
  return { dir, first };
}

async function startDaemon({ mode = 'ok', profile = REVIEW_PROFILE, cwd, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-ds-'));
  const socketPath = join(dir, 't.sock');
  const daemon = new Daemon({
    socketPath,
    appServerOpts: { command: process.execPath, args: [FIXTURE, '--review-mode', mode] },
    clientInfo: { name: 'codex-drive', version: '0.1.0' },
    cwd, profile,
    ...extra,
  });
  await daemon.start();
  return { daemon, socketPath };
}

test('review happy path returns the review text', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  const started = await rpcCall(socketPath, { cmd: 'review' });
  assert.equal(started.ok, true);
  assert.match(started.scope, /working tree/);          // dirty tree -> auto -> working-tree
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.match(res.message, /\[P2\] something to fix/);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('turn.id comes from the response, NOT from turn/started (which disagrees on a review)', async () => {
  // Live reality on codex-cli 0.144.5: review/start's response.turn.id is the id that turn/completed
  // and every item/completed carry, while turn/started announces an unrelated one. The fixture
  // reproduces that disagreement, so this pins WHICH id we adopt — assert it directly rather than
  // only observing that the turn completed (buffering alone would make that pass either way).
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.match(daemon.turn.id, /^turn-/, 'adopted the response id');
  assert.ok(!/^started-/.test(daemon.turn.id), 'must NOT have adopted turn/started\'s id');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('REGRESSION: a same-burst response+completion cannot report a review the daemon never validated', async () => {
  // The reproduced race: JsonRpc.feed() drains a coalesced chunk synchronously while the response
  // promise resolves on a later microtask. Previously `wait` returned completed+text while the
  // turn's true status was failed. Buffering until the response makes wire order irrelevant.
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'burst' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'completed');
  assert.match(res.message, /\[P2\] something to fix/);
  assert.equal(daemon.turn.status, 'completed', 'reported status must match the daemon truth');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a rejected review/start surfaces as failed and does not hang', { timeout: 5000 }, async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'reject' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /review\/start failed/);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a foreign reviewThreadId fails the turn instead of attributing someone else\'s review', { timeout: 5000 }, async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'wrongthread' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /foreign reviewThreadId/);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a blank review fails — never completed-with-empty (the gate reads clean as ship-it)', { timeout: 5000 }, async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'blank' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /without any review text/);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a completed turn whose start response never arrives fails via the daemon backstop', { timeout: 15000 }, async () => {
  // There is no daemon-side wait cap (_wait parks a bare resolver), so without this backstop the
  // buffered completion would sit forever, the busy guard would block every later turn, and `wait`
  // would hang. The buffered review must NEVER be released as completed.
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'noresponse' });
  await rpcCall(socketPath, { cmd: 'review' });
  const res = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(res.status, 'failed');
  assert.match(res.message, /never arrived/);
  assert.ok(!/\[P2\]/.test(res.message || ''), 'the unvalidated review text must not leak out');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('review is refused on a session without the review thread profile', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, profile: null });
  const res = await rpcCall(socketPath, { cmd: 'review' });
  assert.equal(res.error, 'wrong_thread_profile');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('review is refused on a writable sandbox and on a resumed thread', async () => {
  const { dir } = repo();
  const a = await startDaemon({ cwd: dir, profile: { ...REVIEW_PROFILE, sandbox: 'workspace-write' } });
  assert.equal((await rpcCall(a.socketPath, { cmd: 'review' })).error, 'wrong_thread_profile');
  await a.daemon.stop();
  // A resumed thread keeps whatever profile it was born with; we cannot re-profile it, so it is
  // never eligible however the flags look.
  const b = await startDaemon({ cwd: dir, resume: 'thread-1' });
  assert.equal((await rpcCall(b.socketPath, { cmd: 'review' })).error, 'wrong_thread_profile');
  await b.daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('review refuses a second concurrent turn (busy guard) and validates scope synchronously', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  await rpcCall(socketPath, { cmd: 'review' });
  assert.equal((await rpcCall(socketPath, { cmd: 'review' })).error, 'busy');
  await rpcCall(socketPath, { cmd: 'wait' });
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a bad scope is a synchronous error that leaves the turn state untouched', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  assert.match((await rpcCall(socketPath, { cmd: 'review', scope: 'bogus' })).error, /invalid --scope/);
  assert.match((await rpcCall(socketPath, { cmd: 'review', base: true })).error, /non-blank/);
  assert.match((await rpcCall(socketPath, { cmd: 'review', base: 'x', scope: 'branch' })).error, /mutually exclusive/);
  assert.match((await rpcCall(socketPath, { cmd: 'review', base: 'nosuchref' })).error, /does not resolve/);
  const st = await rpcCall(socketPath, { cmd: 'status' });
  assert.equal(st.turnStatus, 'idle');    // no turn was ever started
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('review --base resolves against the DAEMON cwd, not the caller cwd', async () => {
  // The daemon's cwd is the single anchor for git-scope, the app-server spawn and thread/start.
  // Here the test process's cwd is deliberately somewhere else entirely.
  const { dir, first } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  const res = await rpcCall(socketPath, { cmd: 'review', base: first.slice(0, 7) });
  assert.equal(res.ok, true);
  assert.match(res.scope, /branch diff against/);
  assert.notEqual(daemon.cwd, process.cwd());
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('status and read report the daemon cwd (so a --socket caller can resolve a relative --out)', async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir });
  assert.equal((await rpcCall(socketPath, { cmd: 'status' })).cwd, daemon.cwd);
  assert.equal((await rpcCall(socketPath, { cmd: 'read' })).cwd, daemon.cwd);
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a parked question during a review is surfaced and answering lets it finish', { timeout: 8000 }, async () => {
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'ask' });
  await rpcCall(socketPath, { cmd: 'review' });
  const q = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(q.status, 'question');
  await rpcCall(socketPath, { cmd: 'answer', id: 'q1', answers: ['A'] });
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(done.status, 'completed');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a parked approval during a review can be denied and the review still finishes', { timeout: 8000 }, async () => {
  // Live reviews never prompt under approvalPolicy:'never' — this path is belt-and-braces.
  const { dir } = repo();
  const { daemon, socketPath } = await startDaemon({ cwd: dir, mode: 'approve' });
  await rpcCall(socketPath, { cmd: 'review' });
  const p = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(p.status, 'approval');
  await rpcCall(socketPath, { cmd: 'approve', decision: 'deny' });
  const done = await rpcCall(socketPath, { cmd: 'wait' });
  assert.equal(done.status, 'completed');
  await daemon.stop(); rmSync(dir, { recursive: true, force: true });
});

test('a server request from a foreign thread is never parked, and is still answered', () => {
  const responded = [];
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = 'T-mine';
  d.turn = { ...d.turn, id: 'turn-1', status: 'running' };
  d.app = {
    respond: (id, result) => responded.push({ id, result }),
    respondError: (id, code, message) => responded.push({ id, code, message }),
  };
  // Foreign thread, approval shape -> declined in its own shape, not parked.
  d._onServerRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: 'T-other', turnId: 'x' } });
  assert.equal(d.turn.parked, null, 'a foreign request must not park our turn');
  assert.deepEqual(responded[0], { id: 1, result: { decision: 'decline' } });
  // Foreign thread, unknown shape -> a JSON-RPC error, never left unanswered (that wedges the turn).
  d._onServerRequest({ id: 2, method: 'some/unknown/request', params: { threadId: 'T-other' } });
  assert.equal(d.turn.parked, null);
  assert.equal(responded[1].id, 2);
  assert.equal(responded[1].code, -32600);
  // Stale turn on OUR thread -> also filtered.
  d._onServerRequest({ id: 3, method: 'item/tool/requestUserInput', params: { threadId: 'T-mine', turnId: 'turn-STALE' } });
  assert.equal(d.turn.parked, null);
  assert.equal(responded[2].id, 3);
  // A legitimate request for our current turn still parks.
  d._onServerRequest({ id: 4, method: 'item/tool/requestUserInput', params: { threadId: 'T-mine', turnId: 'turn-1' } });
  assert.equal(d.turn.parked.id, 4);
});

test('foreign-thread notifications never touch the active turn', () => {
  const d = new Daemon({ socketPath: '/tmp/cdx-unit-none.sock', clientInfo: {}, cwd: process.cwd() });
  d.threadId = 'T-mine';
  d.turn = { ...d.turn, id: 'turn-1', status: 'running', awaitingResponse: false, buffer: '' };
  d._onNotification('item/agentMessage/delta', { threadId: 'T-other', turnId: 'turn-1', delta: 'FOREIGN' });
  assert.equal(d.turn.buffer, '');
  d._onNotification('item/agentMessage/delta', { threadId: 'T-mine', turnId: 'turn-1', delta: 'MINE' });
  assert.equal(d.turn.buffer, 'MINE');
  // A foreign thread's completion must not finish our turn.
  d._onNotification('turn/completed', { threadId: 'T-other', turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(d.turn.status, 'running');
});
