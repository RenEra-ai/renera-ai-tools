// The DETACHED CLI path: `start` re-spawns bin/codex-drive.mjs as `__daemon`, so nothing a test
// constructs in-process reaches that daemon. These drive the real binary end-to-end, offline, via
// the gated test seam (which the __daemon branch honours precisely so this file can exist).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/codex-drive.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-dcli-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');   // dirty
  return dir;
}

function env(mode = 'ok') {
  return {
    ...process.env,
    CODEX_DRIVE_TEST_MODE: '1',
    CODEX_DRIVE_TEST_APPSERVER: JSON.stringify([process.execPath, FIXTURE, '--review-mode', mode]),
  };
}

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
  assert.equal(r.code, 0, `start failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
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

test('a non-start verb with neither --socket nor an active session fails cleanly', async () => {
  const r = await cli(['status', '--socket', '/nonexistent/nope.sock'], { env: env() });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr + r.stdout, /no daemon at/);
});
