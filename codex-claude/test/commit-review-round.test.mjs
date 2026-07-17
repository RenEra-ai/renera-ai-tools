import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/commit-review-round.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function repo({ dirty = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-crr-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'T');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'first');
  const first = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'commit', '-aqm', 'second');
  if (dirty) writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nDIRTY\n');
  return { dir, first };
}

// Every path is exercised offline through the gated seam — no live Codex, no network. This is what
// review-round.test.mjs:10 documents it CANNOT do (its happy path is live-only).
function env(mode, extra = {}) {
  return {
    ...process.env,
    CODEX_DRIVE_TEST_MODE: '1',
    CODEX_DRIVE_TEST_APPSERVER: JSON.stringify([process.execPath, FIXTURE, '--review-mode', mode]),
    ...extra,
  };
}

async function script(args, opts = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], opts);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const lastTwo = (stdout) => stdout.trimEnd().split('\n').slice(-2);

test('happy path: review text, then the trailers, exit 0', async () => {
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('ok') });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /\[P2\] something to fix/);
  const [status, scope] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: completed');
  assert.match(scope, /^SCOPE: working tree diff head=[0-9a-f]{40}$/);   // attests what was reviewed
  rmSync(dir, { recursive: true, force: true });
});

test('trailers are the LAST TWO LINES even when the review body contains a "STATUS:" line', async () => {
  // A bare /^STATUS: failed$/m would match inside the review body and mis-read a clean review as
  // failed. Position, not pattern, is the contract.
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('statusinbody') });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^STATUS: failed$/m, 'the body really does contain the decoy');
  assert.deepEqual(lastTwo(r.stdout)[0], 'STATUS: completed');
  rmSync(dir, { recursive: true, force: true });
});

test('same-burst response+completion still yields an honest completed review', async () => {
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('burst') });
  assert.equal(r.code, 0);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: completed');
  rmSync(dir, { recursive: true, force: true });
});

test('a blank review is exit 2 / STATUS: failed — never presentable as a clean pass', async () => {
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('blank') });
  assert.equal(r.code, 2);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  rmSync(dir, { recursive: true, force: true });
});

test('a rejected review/start is exit 2', async () => {
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('reject') });
  assert.equal(r.code, 2);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  rmSync(dir, { recursive: true, force: true });
});

test('a foreign reviewThreadId is exit 2', async () => {
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('wrongthread') });
  assert.equal(r.code, 2);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  rmSync(dir, { recursive: true, force: true });
});

test('the wait cap expiring interrupts and reports timeout (exit 2)', async () => {
  // Reachable in ~2s only because CODEX_DRIVE_TEST_WAIT_MS can shorten the 540s constant; without
  // that seam this path would be a ~9-minute test, and "all paths tested offline" would be a lie.
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('noresponse', { CODEX_DRIVE_TEST_WAIT_MS: '2000' }) });
  assert.equal(r.code, 2);
  const [status] = lastTwo(r.stdout);
  assert.ok(status === 'STATUS: timeout' || status === 'STATUS: failed', `got ${status}`);
  rmSync(dir, { recursive: true, force: true });
});

test('a parked approval is denied and the review still completes', async () => {
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('approve') });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /denying approval/);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: completed');
  rmSync(dir, { recursive: true, force: true });
});

test('a parked question is auto-answered with the first option', async () => {
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('ask') });
  assert.equal(r.code, 0);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: completed');
  rmSync(dir, { recursive: true, force: true });
});

// --- preflight: exit 1, and no daemon is booted at all ---

test('preflight rejects bad usage with exit 1', async () => {
  const { dir, first } = repo();
  assert.equal((await script(['--cwd', dir, '--scope', 'bogus'], { env: env('ok') })).code, 1);
  assert.equal((await script(['--cwd', dir, '--base', first, '--scope', 'branch'], { env: env('ok') })).code, 1);
  assert.equal((await script(['--cwd', dir, '--base'], { env: env('ok') })).code, 1);
  // --base=value must not be silently downgraded to auto scope
  const eq = await script(['--cwd', dir, `--base=${first}`], { env: env('ok') });
  assert.equal(eq.code, 1);
  assert.match(eq.stderr, /not supported/);
  rmSync(dir, { recursive: true, force: true });
});

test('outside a git repo -> exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-nogit-'));
  const r = await script(['--cwd', dir], { env: env('ok') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);
  rmSync(dir, { recursive: true, force: true });
});

test('a --base with no delta is refused (exit 1) rather than reviewed as clean', async () => {
  const { dir } = repo({ dirty: false });
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = await script(['--cwd', dir, '--base', head], { env: env('ok') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /empty delta/);
  rmSync(dir, { recursive: true, force: true });
});

test('the test seam is refused outside test mode (exit 1), never silently ignored', async () => {
  const { dir } = repo();
  const e = { ...process.env, CODEX_DRIVE_TEST_APPSERVER: JSON.stringify([process.execPath, FIXTURE]) };
  delete e.CODEX_DRIVE_TEST_MODE;
  const r = await script(['--cwd', dir], { env: e });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CODEX_DRIVE_TEST_MODE=1 is not/);
  rmSync(dir, { recursive: true, force: true });
});

test('temp dirs are cleaned up on every exit path', async () => {
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith('cdx-creview-')).length;
  const { dir } = repo();
  await script(['--cwd', dir], { env: env('ok') });        // success
  await script(['--cwd', dir], { env: env('reject') });    // failure after boot
  await script(['--cwd', dir, '--scope', 'bogus'], { env: env('ok') });  // preflight, no boot
  const after = readdirSync(tmpdir()).filter((f) => f.startsWith('cdx-creview-')).length;
  assert.equal(after, before, 'no cdx-creview- temp dir may survive');
  rmSync(dir, { recursive: true, force: true });
});
