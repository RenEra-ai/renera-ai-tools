// The DETACHED CLI path: `start` re-spawns bin/codex-drive.mjs as `__daemon`, so nothing a test
// constructs in-process reaches that daemon. These drive the real binary end-to-end, offline, via
// the gated test seam (which the __daemon branch honours precisely so this file can exist).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { git, makeRepo, seamEnv, rmDir } from './fixtures/helpers.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/codex-drive.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

// These spawn REAL detached, unref'd daemons. The per-test `stop` runs only after the assertions,
// so one failure used to strand a daemon (plus its mock app-server child) on the developer's
// machine indefinitely and leave a socket behind in the real ~/.codex-drive.
const SPAWNED = [];   // { socket, mode }
const DIRS = [];
after(async () => {
  for (const s of SPAWNED) {
    try { await cli(['stop', '--socket', s], { env: env() }); } catch { /* best effort */ }
  }
  SPAWNED.length = 0;
  for (const d of DIRS) rmDir(d);
  DIRS.length = 0;
});

function repo() {
  const { dir } = makeRepo({ prefix: 'cdx-dcli-' });
  DIRS.push(dir);
  return dir;
}

const env = (mode = 'ok', extra = {}) => seamEnv(FIXTURE, mode, extra);

async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], opts);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// --private keeps every one of these off ~/.codex-drive/state.json, so the suite can never disturb
// (or be disturbed by) a real session on this machine.
async function startPrivate(dir, mode = 'ok', extra = []) {
  const r = await cli(['start', '--private', '--cwd', dir, '--sandbox', 'read-only',
    '--approval-policy', 'never', '--ephemeral', ...extra], { env: env(mode) });
  // Register BEFORE asserting or parsing: both can throw, and by then the daemon is already
  // running — which is precisely when the trailing `stop` never runs and it outlives the suite.
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { /* asserted below */ }
  if (out && out.socket) SPAWNED.push(out.socket);
  assert.equal(r.code, 0, `start failed: ${r.stderr}`);
  assert.ok(out && out.socket, `start produced no socket: ${r.stdout}`);
  return out;
}

test('profile survives the __daemon handoff: review is ACCEPTED on a --private review session', async () => {
  // The detached payload carries {socketPath, resume, model, cwd, profile}. Without the profile the
  // detached daemon records none and every review is refused wrong_thread_profile.
  const dir = repo();
  const { socket } = await startPrivate(dir);
  const r = await cli(['review', '--socket', socket], { env: env() });
  assert.equal(r.code, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true);
  assert.match(res.scope, /working tree/);
  await cli(['wait', '--socket', socket, '--timeout-ms', '15000'], { env: env() });
  await cli(['stop', '--socket', socket], { env: env() });
  rmSync(dir, { recursive: true, force: true });
});

test('start WITHOUT profile flags -> review refused wrong_thread_profile', async () => {
  const dir = repo();
  const r0 = await cli(['start', '--private', '--cwd', dir], { env: env() });
  const { socket } = JSON.parse(r0.stdout);
  SPAWNED.push(socket);          // tracked like every other start, or a failure here orphans it
  const r = await cli(['review', '--socket', socket], { env: env() });
  assert.equal(r.code, 2);                       // {error} -> exit 2
  assert.match(r.stdout, /wrong_thread_profile/);
  await cli(['stop', '--socket', socket], { env: env() });
  rmSync(dir, { recursive: true, force: true });
});

test('--private writes NO global state (a concurrent session cannot be clobbered or hijacked)', async () => {
  const dir = repo();
  const statePath = join(process.env.HOME, '.codex-drive', 'state.json');
  const before = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null;
  const { socket, private: isPrivate } = await startPrivate(dir);
  assert.equal(isPrivate, true);
  const after = existsSync(statePath) ? readFileSync(statePath, 'utf8') : null;
  assert.equal(after, before, '--private must not touch ~/.codex-drive/state.json');
  await cli(['stop', '--socket', socket], { env: env() });
  rmSync(dir, { recursive: true, force: true });
});

test('read --out resolves a relative path against the SOCKET-selected daemon cwd', async () => {
  // --socket deliberately bypasses state.json, and therefore state.cwd — the thing a relative --out
  // used to resolve against. The daemon reports its own cwd on read/status instead.
  const dir = repo();
  const { socket } = await startPrivate(dir);
  await cli(['review', '--socket', socket], { env: env() });
  await cli(['wait', '--socket', socket, '--timeout-ms', '15000'], { env: env() });
  const r = await cli(['read', '--out', 'artifacts/review.md', '--socket', socket], { env: env() });
  assert.equal(r.code, 0, r.stderr);
  const landed = join(dir, 'artifacts', 'review.md');
  assert.ok(existsSync(landed), 'artifact must land in the daemon repo, not the caller cwd');
  assert.match(readFileSync(landed, 'utf8'), /\[P2\] something to fix/);
  await cli(['stop', '--socket', socket], { env: env() });
  rmSync(dir, { recursive: true, force: true });
});

test('a valueless --out fails instead of writing a file literally named "true"', async () => {
  const dir = repo();
  const { socket } = await startPrivate(dir);
  await cli(['review', '--socket', socket], { env: env() });
  await cli(['wait', '--socket', socket, '--timeout-ms', '15000'], { env: env() });
  const r = await cli(['read', '--out', '--socket', socket], { env: env() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--out requires a path/);
  assert.ok(!existsSync(join(dir, 'true')), 'must not create a file named "true"');
  await cli(['stop', '--socket', socket], { env: env() });
  rmSync(dir, { recursive: true, force: true });
});

test('a valueless --timeout-ms fails instead of becoming a 1ms cap (Number(true) === 1)', async () => {
  const dir = repo();
  const { socket } = await startPrivate(dir);
  const r = await cli(['wait', '--timeout-ms', '--socket', socket], { env: env() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--timeout-ms requires a value/);
  await cli(['stop', '--socket', socket], { env: env() });
  rmSync(dir, { recursive: true, force: true });
});

test('invalid start flags error BEFORE any session is probed, stopped or spawned', async () => {
  // The ordering is the point: --force stops an existing session, so validating later would destroy
  // an unrelated live daemon and only then report the typo.
  const dir = repo();
  const r = await cli(['start', '--private', '--force', '--cwd', dir, '--sandbox', 'bogus'], { env: env() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid --sandbox/);
  const r2 = await cli(['start', '--private', '--cwd', dir, '--ephemeral', '--resume', 'abc'], { env: env() });
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /cannot be combined with --resume/);
  rmSync(dir, { recursive: true, force: true });
});

test('start --help errors loudly instead of booting a daemon and clobbering global state', async () => {
  // The regression this closes: `start --help` printed no help, spawned a REAL detached daemon,
  // overwrote ~/.codex-drive/state.json and exited 0 — the same `--help` hazard 1.8.1 removed from
  // the one-shot. `--record` doubles as the sentinel: if the app-server were ever spawned, the file
  // would exist. HOME is redirected so a state write would land somewhere observable, not on the
  // developer's real session.
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), 'cdx-home-'));
  DIRS.push(home);
  const sentinel = join(home, 'spawned.json');
  const seam = {
    ...env('ok'),
    HOME: home,
    CODEX_DRIVE_TEST_APPSERVER: JSON.stringify([process.execPath, FIXTURE, '--review-mode', 'ok', '--record', sentinel]),
  };
  const cases = [
    [['start', '--help'], /unknown flag --help/],
    [['start', '--bogus', 'x'], /unknown flag --bogus/],
    [['start', dir], /takes no positional/],              // a forgotten --cwd, not an argument
    [['start', '--private', 'no'], /--private is a boolean flag/],   // 'no' is truthy: looked private, wrote global state
    [['start', '--force', 'no'], /--force is a boolean flag/],       // 'no' is truthy: force-stopped a live session
  ];
  for (const [args, re] of cases) {
    const r = await cli([...args, '--cwd', dir], { env: seam });
    assert.equal(r.code, 1, `${args.join(' ')} should exit 1, got ${r.code}: ${r.stdout}`);
    assert.match(r.stderr, re);
  }
  assert.equal(existsSync(sentinel), false, 'no app-server may be spawned for a rejected start');
  assert.equal(existsSync(join(home, '.codex-drive', 'state.json')), false, 'no global state may be written');
});

test('doctor rejects unknown flags instead of silently ignoring them', async () => {
  const r = await cli(['doctor', '--sockt', '/tmp/s'], { env: env() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag --sockt/);
});

test('a bad test seam fails LOUDLY in the parent, not silently in the stdio-ignored child', async () => {
  // Without the parent-side preflight the child threw the real reason into /dev/null and the caller
  // saw only 'daemon did not come up' five seconds later.
  const dir = repo();
  const bad = { ...env('ok') };
  delete bad.CODEX_DRIVE_TEST_MODE;                     // seam set, gate not
  const r = await cli(['start', '--private', '--cwd', dir], { env: bad });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /refusing to substitute/);
  assert.doesNotMatch(r.stderr, /did not come up/);
});

test('a non-start verb with neither --socket nor an active session fails cleanly', async () => {
  const r = await cli(['status', '--socket', '/nonexistent/nope.sock'], { env: env() });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /no daemon at/);
});

// 25s: the probe deliberately waits its full 10s cap before deciding, since a busy daemon is a live
// daemon — so this test costs that cap plus process startup.
test('start FAILS CLOSED when the recorded session probes as busy rather than absent', { timeout: 25000 }, async () => {
  // A probe TIMEOUT is not proof of death: the daemon resolves review scope with a chain of
  // synchronous git calls, so a big repo can block it for seconds. Treating that as "stale" let
  // `start` overwrite state.json and orphan a live daemon plus its codex app-server. Only definite
  // absence (nothing listening) may replace the record.
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), 'cdx-home-'));
  DIRS.push(home);
  // A socket that accepts connections but never answers — indistinguishable from a busy daemon.
  const sockPath = join(home, 'busy.sock');
  const conns = [];
  const server = createServer((c) => { conns.push(c); /* accept, then deliberately never answer */ });
  await new Promise((r) => server.listen(sockPath, r));
  try {
    mkdirSync(join(home, '.codex-drive'), { recursive: true });
    writeFileSync(join(home, '.codex-drive', 'state.json'),
      JSON.stringify({ threadId: 'T-old', pid: 1, socket: sockPath, cwd: dir, model: null }));
    const r = await cli(['start', '--cwd', dir], { env: { ...env('ok'), HOME: home } });
    assert.equal(r.code, 1, 'must refuse rather than clobber a possibly-live session');
    assert.match(r.stderr, /may still be live/);
    // The record must survive untouched — clobbering it is what orphans the daemon.
    const state = JSON.parse(readFileSync(join(home, '.codex-drive', 'state.json'), 'utf8'));
    assert.equal(state.threadId, 'T-old', 'state.json must not be overwritten');
  } finally {
    // Destroy the accepted sockets first: server.close() waits on open connections, and the probe's
    // connection is still there — closing without this hangs the test forever.
    for (const c of conns) { try { c.destroy(); } catch { /* already gone */ } }
    await new Promise((r) => server.close(r));
  }
});

// spec:763 — the `read --out` precedence cases. These were impossible to write until the socket
// name was shortened: a redirected HOME pushed the path past the OS's 104-byte cap, bind() failed
// inside the stdio-ignored child, and `start` could only say "daemon did not come up".
test('read --out prefers the DAEMON cwd over a STALE global state.cwd', { timeout: 40000 }, async () => {
  // Deliberately NOT --socket: bin sets `state = socketFlag ? null : store.readState()`, so a
  // --socket variant never reads state.json at all and cannot tell the two precedences apart (an
  // earlier attempt at this test passed with the precedence reversed — vacuous by construction).
  // Going through the state path means starting NON-private, then corrupting only state.cwd while
  // leaving state.socket valid, so the daemon is still reachable but the record lies about where.
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), 'cdx-h-'));
  DIRS.push(home);
  const decoy = mkdtempSync(join(tmpdir(), 'cdx-decoy-'));
  DIRS.push(decoy);
  const e = { ...env('ok'), HOME: home };
  const r0 = await cli(['start', '--cwd', dir, '--sandbox', 'read-only',
    '--approval-policy', 'never', '--ephemeral'], { env: e });
  assert.equal(r0.code, 0, `start failed: ${r0.stderr}`);
  const { socket } = JSON.parse(r0.stdout);
  SPAWNED.push(socket);

  const statePath = join(home, '.codex-drive', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.cwd, dir, 'a non-private start must record the real cwd');
  writeFileSync(statePath, JSON.stringify({ ...state, cwd: decoy }));   // socket stays valid

  await cli(['review'], { env: e });
  await cli(['wait', '--timeout-ms', '15000'], { env: e });
  const r = await cli(['read', '--out', 'artifacts/review.md'], { env: e });
  assert.equal(r.code, 0, `read failed: ${r.stderr}`);
  assert.ok(existsSync(join(dir, 'artifacts', 'review.md')),
    'the artifact must follow the DAEMON-reported cwd');
  assert.ok(!existsSync(join(decoy, 'artifacts')),
    'and must NOT follow the stale state.cwd');
  await cli(['stop'], { env: e });
});

test('read --out still resolves with NO global state at all (--socket path)', { timeout: 30000 }, async () => {
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), 'cdx-h-'));
  DIRS.push(home);
  const e = { ...env('ok'), HOME: home };
  // Start with the SAME redirected HOME the assertion inspects — startPrivate()'s own env() does not
  // carry it, so asserting against `home` after that call proved nothing at all.
  const r0 = await cli(['start', '--private', '--cwd', dir, '--sandbox', 'read-only',
    '--approval-policy', 'never', '--ephemeral'], { env: e });
  assert.equal(r0.code, 0, `start failed: ${r0.stderr}`);
  const { socket } = JSON.parse(r0.stdout);
  SPAWNED.push(socket);
  assert.equal(existsSync(join(home, '.codex-drive', 'state.json')), false,
    '--private must not write state.json into the HOME it actually ran under');
  await cli(['review', '--socket', socket], { env: e });
  await cli(['wait', '--socket', socket, '--timeout-ms', '15000'], { env: e });
  const r = await cli(['read', '--out', 'artifacts/review.md', '--socket', socket], { env: e });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(dir, 'artifacts', 'review.md')), 'artifact lands in the daemon repo');
  await cli(['stop', '--socket', socket], { env: e });
});

test('an over-long socket path fails LOUDLY, not as "daemon did not come up"', { timeout: 30000 }, async () => {
  // The bug class this closes: the child boots with stdio:'ignore', so EVERY failure looked the
  // same. A HOME deep enough to blow the OS's ~104-byte socket cap must now say exactly that.
  const dir = repo();
  let home = mkdtempSync(join(tmpdir(), 'cdx-h-'));
  DIRS.push(home);
  for (let i = 0; i < 4; i++) { home = join(home, 'nested-directory-padding'); }
  mkdirSync(home, { recursive: true });
  const r = await cli(['start', '--private', '--cwd', dir, '--sandbox', 'read-only',
    '--approval-policy', 'never', '--ephemeral'], { env: { ...env('ok'), HOME: home } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /socket path too long/, `expected a named cause, got: ${r.stderr}`);
});
