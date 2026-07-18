import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { git, makeRepo, seamEnv, pidAlive, pollUntil } from './fixtures/helpers.mjs';

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('../scripts/commit-review-round.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

const repo = (opts = {}) => makeRepo({ prefix: 'cdx-crr-', ...opts });

// Every path is exercised offline through the gated seam — no live Codex, no network. This is what
// review-round.test.mjs:10 documents it CANNOT do (its happy path is live-only).
const env = (mode, extra = {}, fixtureArgs = []) => seamEnv(FIXTURE, mode, extra, fixtureArgs);

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
  // Wording comes from the shared drive-loop now ("declining"), so all three drivers log alike.
  assert.match(r.stderr, /declining approval/);
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

test('--help prints usage and exits 0 — it must NOT run a live review', async () => {
  // Found the hard way: with no --help handling and unknown flags ignored, `--help` fell through to
  // a full unscoped review of the cwd and hung for minutes against real Codex.
  const r = await script(['--help'], { env: env('ok') });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^usage: commit-review-round/);
  assert.ok(!/STATUS:/.test(r.stdout), 'must not have run a review');
});

test('an UNKNOWN flag is a hard error, never silently ignored into a full unscoped review', async () => {
  const { dir } = repo();
  const r = await script(['--cwd', dir, '--bogus', 'x'], { env: env('ok') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown flag --bogus/);
  assert.ok(!/STATUS:/.test(r.stdout), 'must not have run a review');
  // A bare positional is equally suspicious (a forgotten flag name).
  const p = await script(['--cwd', dir, 'stray'], { env: env('ok') });
  assert.equal(p.code, 1);
  assert.match(p.stderr, /unexpected argument 'stray'/);
  rmSync(dir, { recursive: true, force: true });
});

test('outside a git repo -> exit 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cdx-nogit-'));
  const r = await script(['--cwd', dir], { env: env('ok') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a git repository/);
  rmSync(dir, { recursive: true, force: true });
});

test('a --base pointing at HEAD is refused (exit 1) rather than reviewed as clean', async () => {
  const { dir } = repo({ dirty: false });
  const head = git(dir, 'rev-parse', 'HEAD');
  const r = await script(['--cwd', dir, '--base', head], { env: env('ok') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is HEAD itself/);
  rmSync(dir, { recursive: true, force: true });
});

test('a blank --cwd is refused, never silently swapped for the process cwd', async () => {
  // `--cwd ""` passed the old guard, then lost to `flag('cwd') || process.cwd()` — reviewing
  // whatever directory the gate happened to run from, and still exiting 0.
  const r = await script(['--cwd', ''], { env: env('ok') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--cwd requires a non-blank value/);
  const b = await script(['--base', '   '], { env: env('ok') });
  assert.equal(b.code, 1);
  assert.match(b.stderr, /--base requires a non-blank value/);
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

test('a bad --base fails in the preflight, before any app-server is spawned', async () => {
  // The spec promises a git-scope error "before any daemon boot" for this — the single most likely
  // gate mistake. It used to pay for a full codex app-server boot and an ephemeral thread first,
  // only to be rejected daemon-side. The --record sentinel is the proof: it exists only if the mock
  // app-server was actually started.
  const { dir } = repo();
  const sentinel = join(dir, 'spawned.json');
  const seam = {
    ...process.env,
    CODEX_DRIVE_TEST_MODE: '1',
    CODEX_DRIVE_TEST_APPSERVER: JSON.stringify([process.execPath, FIXTURE, '--review-mode', 'ok', '--record', sentinel]),
  };
  const r = await script(['--cwd', dir, '--base', 'deadbeefdeadbeef'], { env: seam });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--base ref does not resolve/);
  assert.match(r.stderr, /usage:/, 'usage errors must still print USAGE (spec error table)');
  assert.equal(existsSync(sentinel), false, 'no app-server may be spawned for a rejected --base');
  rmSync(dir, { recursive: true, force: true });
});

test('a repeated flag is LAST-wins, matching the CLI parser (it used to be first-wins here)', async () => {
  // The same command line reviewed a different range depending on whether it entered through the
  // CLI verb or this script. Now there is one parser, so `--scope bogus` last must lose the race.
  const { dir } = repo();
  const r = await script(['--cwd', dir, '--scope', 'working-tree', '--scope', 'bogus'], { env: env('ok') });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /invalid --scope 'bogus'/);
  rmSync(dir, { recursive: true, force: true });
});

test('a permissions-shaped approval interrupts at once, not 20 futile deny rounds', async () => {
  // protocol.mjs refuses to fake this response shape, so denying it only errors. The spec maps it
  // straight to interrupt + STATUS: failed; previously the script deny-looped until the drain guard
  // gave up, emitting 20 misleading "denying approval" lines on the way.
  const { dir } = repo();
  const r = await script(['--cwd', dir], { env: env('permissions') });
  assert.equal(r.code, 2);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  assert.match(r.stderr, /interrupting/);
  assert.doesNotMatch(r.stderr, /declining approval/, 'it must not try to answer this shape at all');
  assert.equal((r.stderr.match(/interrupting/g) || []).length, 1, 'exactly one interrupt, no deny loop');
  rmSync(dir, { recursive: true, force: true });
});

test('SIGTERM tears down instead of orphaning the app-server mid-review', async () => {
  const { dir } = repo();
  const before = readdirSync(tmpdir()).filter((f) => f.startsWith('cdx-creview-')).length;
  // The lifecycle file names the EXACT app-server child, so this test proves that child died —
  // exit 143 + the cleanup log only prove the handler ran, which stays green with daemon.stop()
  // deleted (the very orphan bug this test exists to guard).
  const lifePath = join(dir, 'mock.pid');
  const child = execFile(process.execPath, [SCRIPT, '--cwd', dir], {
    env: env('noresponse', { CODEX_DRIVE_TEST_WAIT_MS: '60000' }, ['--lifecycle-file', lifePath]),
  });
  let mockPid = null;
  try {
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    await new Promise((r) => setTimeout(r, 1200));
    await pollUntil(() => existsSync(lifePath), { label: 'mock pid file' });
    mockPid = Number(readFileSync(lifePath, 'utf8'));
    assert.ok(pidAlive(mockPid), 'the mock app-server must be alive before the SIGTERM');
    child.kill('SIGTERM');
    const { code, signal } = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: 'HUNG' }), 8000))]);
    assert.notEqual(code, 'HUNG', 'did not exit on SIGTERM');
    // EXACTLY 143 from our handler: an unhandled SIGTERM also kills the process but skips teardown,
    // so accepting signal-death would let the orphan bug pass.
    assert.equal(code, 143, `expected 143 via teardown, got code=${code} signal=${signal}`);
    assert.match(err, /SIGTERM — cleaning up/);
    await pollUntil(() => !pidAlive(mockPid), { label: 'app-server death' });
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith('cdx-creview-')).length;
    assert.equal(after, before, 'the temp dir must not survive a signal');
  } finally {
    // A failed assertion must not let the TEST become the orphaner it guards against.
    if (mockPid && pidAlive(mockPid)) { try { process.kill(mockPid, 'SIGKILL'); } catch { /* best effort */ } }
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
