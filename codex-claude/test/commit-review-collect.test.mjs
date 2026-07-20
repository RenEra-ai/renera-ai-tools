// scripts/commit-review-collect.mjs — the terminal step of the detached Stage-2 review.
//
// These drive the REAL detached CLI end-to-end, offline through the gated seam: `start --private`
// with the review profile, a native `review`, polls, then the collector. Nothing here mocks the
// collector's own dependencies, because the bugs worth catching live in the seams between them
// (ownership, teardown confirmation, trailer position) rather than inside any one call.
//
// The positional trailer assertions are the point of the file: the enforcement hook keys on
// `^STATUS: …$` AND `^SCOPE: ` being present, and a prose recipe already lost that contract once by
// ending in `read --out`. Independent per-line `assert.match` calls stay green under reordered,
// duplicated, or interleaved output — so every contract assertion here is POSITIONAL.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo, seamEnv, rmDir, pidAlive, git } from './fixtures/helpers.mjs';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../bin/codex-drive.mjs', import.meta.url));
const COLLECT = fileURLToPath(new URL('../scripts/commit-review-collect.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/mock-appserver.mjs', import.meta.url));

// These spawn REAL detached, unref'd daemons. A failed assertion must not strand one (plus its mock
// app-server) on the developer's machine, so registration happens BEFORE any assertion can throw.
const SPAWNED = [];
const DIRS = [];
after(async () => {
  for (const s of SPAWNED) {
    try { await cli(['stop', '--socket', s], { env: env() }); } catch { /* best effort */ }
  }
  SPAWNED.length = 0;
  for (const d of DIRS) rmDir(d);
  DIRS.length = 0;
});

const env = (mode = 'ok', extra = {}) => seamEnv(FIXTURE, mode, extra);

async function cli(args, opts = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], opts);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function collect(runDir, outcome, extra = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath,
      [COLLECT, '--state-dir', runDir, '--outcome', outcome], { env: { ...process.env, ...extra } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const lastTwo = (stdout) => stdout.trimEnd().split('\n').slice(-2);

/** Poll `wait` until it stops reporting `timeout`. A timeout is a POLL RESULT, never a verdict. */
async function driveToTerminal(socket, e, { capMs = 25000 } = {}) {
  const deadline = Date.now() + capMs;
  for (;;) {
    const r = await cli(['wait', '--timeout-ms', '1000', '--socket', socket], { env: e });
    let out = {};
    try { out = JSON.parse(r.stdout); } catch { /* non-JSON is not terminal */ }
    if (out.status && out.status !== 'timeout') return out;
    if (Date.now() > deadline) throw new Error(`driveToTerminal: no terminal state within ${capMs}ms`);
  }
}

/**
 * A live detached review plus the state directory the prose recipe persists. Mirrors the documented
 * recipe exactly — including starting the daemon with the PERSISTED repo toplevel rather than the
 * caller's cwd, which the collector's ownership check compares against.
 */
async function liveSession(mode = 'ok', { dirty = false, drive = true } = {}) {
  const { dir, first } = makeRepo({ dirty, prefix: 'cdx-crc-' });
  DIRS.push(dir);
  const runDir = mkdtempSync(join(tmpdir(), 'cdx-crcs-'));
  DIRS.push(runDir);
  const e = env(mode);

  writeFileSync(join(runDir, 'cwd'), `${dir}\n`);
  writeFileSync(join(runDir, 'baseline'), `${first}\n`);
  writeFileSync(join(runDir, 'start-head'), `${git(dir, 'rev-parse', 'HEAD')}\n`);
  writeFileSync(join(runDir, 'dirty'), `${dirty ? 'true' : 'false'}\n`);

  const started = await cli(['start', '--private', '--cwd', dir,
    '--sandbox', 'read-only', '--approval-policy', 'never', '--ephemeral'], { env: e });
  let out = null;
  try { out = JSON.parse(started.stdout); } catch { /* asserted below */ }
  if (out && out.socket) SPAWNED.push(out.socket);
  assert.equal(started.code, 0, `start failed: ${started.stderr}`);
  assert.ok(out && out.socket, `start produced no socket: ${started.stdout}`);
  writeFileSync(join(runDir, 'start.json'), started.stdout);
  writeFileSync(join(runDir, 'socket'), `${out.socket}\n`);
  writeFileSync(join(runDir, 'pid'), `${out.pid}\n`);

  const rev = await cli(['review', '--base', first, '--socket', out.socket], { env: e });
  assert.equal(rev.code, 0, `review failed: ${rev.stderr}`);
  const revOut = JSON.parse(rev.stdout);
  writeFileSync(join(runDir, 'scope'), `${revOut.scope || ''}\n`);

  if (drive) await driveToTerminal(out.socket, e);
  return { repo: dir, runDir, socket: out.socket, pid: out.pid, head: git(dir, 'rev-parse', 'HEAD') };
}

test('a completed review emits the raw body, then EXACTLY the trailer pair, and exits 0', async () => {
  const s = await liveSession('ok');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Reviewed 1 file\./, 'the review body must be emitted verbatim');
  const [status, scope] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: completed');
  assert.equal(scope, `SCOPE: branch diff against ${readFileSync(join(s.runDir, 'baseline'), 'utf8').trim()} `
    + `(${readFileSync(join(s.runDir, 'baseline'), 'utf8').trim().slice(0, 7)}) head=${s.head} dirty=false`);
});

test('the trailers are the LAST TWO lines even when the review body contains a literal STATUS: line', async () => {
  // statusinbody plants `STATUS: failed` INSIDE the review text. A parser using a bare
  // /^STATUS: …$/m — or a test asserting with assert.match — reads the decoy and reports the
  // opposite verdict. Position is the contract, not presence.
  const s = await liveSession('statusinbody');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^STATUS: failed$/m, 'the decoy must survive in the body, unmodified');
  const [status, scope] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: completed', 'the REAL status is the second-to-last line');
  assert.match(scope, /^SCOPE: .* head=[0-9a-f]{40} dirty=(true|false)$/);
});

test('a completed turn with blank review text is downgraded to failed and does not advance the round marker', async () => {
  // The gate reads "no findings" as "ship it", so a blank body must never exit 0. The daemon already
  // fails such a turn; this pins the collector's own second line of defence.
  const s = await liveSession('blank');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  const [status] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: failed');
  assert.ok(!existsSync(join(s.runDir, 'last-reviewed-sha')),
    'a failed round must not move last-reviewed-sha — that would shrink the NEXT review silently');
});

test('--outcome is a CEILING: a finished turn collected as timeout stays timeout', async () => {
  // The abort decision belongs to the poller. A turn that completes while the recipe is tearing
  // down must not be laundered into a clean review the gate would accept.
  const s = await liveSession('ok');
  const r = await collect(s.runDir, 'timeout');
  assert.equal(r.code, 2);
  const [status] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: timeout');
  assert.ok(!existsSync(join(s.runDir, 'last-reviewed-sha')));
});

test('dirty=true is attested from the RECORDED state, not recomputed at collect time', async () => {
  // The trailer must describe the tree as it was when the review STARTED. Recomputing here would
  // let an edit made during the review silently rewrite what the attestation claims.
  const s = await liveSession('ok', { dirty: true });
  writeFileSync(join(s.repo, 'a.txt'), 'mutated after the review began\n');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 0, r.stderr);
  const [, scope] = lastTwo(r.stdout);
  assert.match(scope, /dirty=true$/);
  assert.match(scope, new RegExp(`head=${s.head} `), 'head must be the captured START head');
});

test('a completed collection records last-reviewed-sha and RETAINS the state directory', async () => {
  const s = await liveSession('ok');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(s.runDir, 'last-reviewed-sha'), 'utf8').trim(), s.head);
  // The enclosing task still needs the baseline, the round marker and the cleanup evidence.
  assert.ok(existsSync(join(s.runDir, 'baseline')), 'the state dir must survive collection');
});

test('a cwd mismatch refuses to collect AND refuses to stop the session', async () => {
  // Stopping a daemon we cannot identify is how one agent kills another agent's review and orphans
  // its own. A refusal must leave both sessions alone.
  const s = await liveSession('ok');
  writeFileSync(join(s.runDir, 'cwd'), '/some/other/repo\n');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  const [status] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: failed');
  assert.match(r.stderr, /cwd mismatch/);
  assert.match(r.stderr, /refusing to stop a session that is not provably ours/);
  assert.ok(pidAlive(s.pid), 'the unidentified daemon must still be running');
});

test('a thread mismatch refuses to collect', async () => {
  const s = await liveSession('ok');
  const start = JSON.parse(readFileSync(join(s.runDir, 'start.json'), 'utf8'));
  writeFileSync(join(s.runDir, 'start.json'), JSON.stringify({ ...start, threadId: 'thread-SOMEONE-ELSE' }));
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /thread mismatch/);
  assert.ok(pidAlive(s.pid));
});

test('a socket sidecar disagreeing with start.json refuses before contacting any daemon', async () => {
  const s = await liveSession('ok');
  writeFileSync(join(s.runDir, 'socket'), '/tmp/some-other.sock\n');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /socket sidecar .* disagrees with start\.json/);
  assert.ok(pidAlive(s.pid));
});

test('a missing start.json is a preflight error (exit 1) with NO trailers at all', async () => {
  // No session was ever started, so there is nothing to attest. Emitting a terminal pair here would
  // tell the gate a review ran and produced nothing, when in fact the run never began.
  const runDir = mkdtempSync(join(tmpdir(), 'cdx-crcs-'));
  DIRS.push(runDir);
  const r = await collect(runDir, 'completed');
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '', 'a preflight failure must emit no contract lines');
  assert.match(r.stderr, /the session was never started/);
});

test('an unconfirmed teardown downgrades a completed review and prints recovery', async () => {
  // `stop` responds BEFORE the daemon finishes tearing down, so trusting the response alone would
  // report success over a live app-server. Here the recorded PID never dies (it is this test
  // process), so confirmation must fail and the clean review must be downgraded.
  const s = await liveSession('ok');
  writeFileSync(join(s.runDir, 'pid'), `${process.pid}\n`);
  const r = await collect(s.runDir, 'completed', {
    CODEX_DRIVE_TEST_MODE: '1', CODEX_DRIVE_TEST_TEARDOWN_MS: '300',
  });
  assert.equal(r.code, 2);
  const [status] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: failed', 'an orphan risk must never exit 0');
  assert.match(r.stderr, /teardown was not confirmed/);
  assert.match(r.stderr, /state retained at/);
  assert.ok(!existsSync(join(s.runDir, 'last-reviewed-sha')));
});

test('the teardown override is refused without CODEX_DRIVE_TEST_MODE=1', async () => {
  // Same fail-closed rule as the app-server seam: an ambient env collision must not be able to
  // quietly shorten the window that exists to catch orphans.
  const runDir = mkdtempSync(join(tmpdir(), 'cdx-crcs-'));
  DIRS.push(runDir);
  const r = await collect(runDir, 'completed', { CODEX_DRIVE_TEST_TEARDOWN_MS: '300' });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CODEX_DRIVE_TEST_MODE=1 is not/);
});

test('usage errors exit 1 without touching anything', async () => {
  const runDir = mkdtempSync(join(tmpdir(), 'cdx-crcs-'));
  DIRS.push(runDir);
  const bad = await collect(runDir, 'nonsense');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--outcome must be one of/);

  const unknown = await run(process.execPath, [COLLECT, '--state-dir', runDir, '--outcome', 'completed', '--bogus', 'x'])
    .then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code, stderr: e.stderr || '' }));
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown flag --bogus/);
});
