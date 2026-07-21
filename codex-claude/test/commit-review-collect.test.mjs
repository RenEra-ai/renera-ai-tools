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
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
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
    // maxBuffer is raised well past the default 1 MiB: the truncation regression below deliberately
    // emits a review larger than that, and the DEFAULT would fail it for the wrong reason.
    const { stdout, stderr } = await run(process.execPath,
      [COLLECT, '--state-dir', runDir, '--outcome', outcome],
      { env: { ...process.env, ...extra }, maxBuffer: 64 * 1024 * 1024 });
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

  // review.json is persisted verbatim, exactly as the recipe does: it is the collector's only
  // evidence that a NATIVE review — rather than a plain `send` — ran on this session.
  const rev = await cli(['review', '--base', first, '--socket', out.socket], { env: e });
  assert.equal(rev.code, 0, `review failed: ${rev.stderr}`);
  const revOut = JSON.parse(rev.stdout);
  writeFileSync(join(runDir, 'review.json'), rev.stdout);
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
  //
  // Both records are rewritten, not just the sidecar: start.json is the AUTHORITY on pid, and
  // leaving them disagreeing would trip the ownership refusal below instead of the teardown check.
  const s = await liveSession('ok');
  const st = JSON.parse(readFileSync(join(s.runDir, 'start.json'), 'utf8'));
  writeFileSync(join(s.runDir, 'start.json'), JSON.stringify({ ...st, pid: process.pid }));
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

test('with NO pid on either record, teardown cannot be confirmed and no deletion marker is written', async () => {
  // confirmStopped falls back to socket-absence when there is no PID, and pidAlive(null) is false —
  // so a swept /tmp (socket gone, daemon alive) would masquerade as teardown and let the recipe
  // delete a directory whose app-server still lives. With both pid records gone, teardown must be
  // UNconfirmed and the `teardown` marker (which alone gates deletion) must never appear.
  const s = await liveSession('ok');
  const st = JSON.parse(readFileSync(join(s.runDir, 'start.json'), 'utf8'));
  delete st.pid;
  writeFileSync(join(s.runDir, 'start.json'), JSON.stringify(st));
  rmSync(join(s.runDir, 'pid'));                       // no pid anywhere → pid === null
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  assert.match(r.stderr, /no PID|teardown could not be confirmed/);
  assert.ok(!existsSync(join(s.runDir, 'teardown')),
    'without a PID to check, teardown is unprovable and its marker must not be written');
  assert.ok(!existsSync(join(s.runDir, 'last-reviewed-sha')));
});

test('the teardown marker records the DAEMON fact, not a verdict that attestation later downgrades', async () => {
  // The marker is written the instant teardown is confirmed — BEFORE the attestation gate can
  // downgrade a read-as-completed turn to failed. Stamping the review verdict there left the file
  // claiming `completed` next to a `STATUS: failed` trailer. Here an unreadable dirty flag forces the
  // downgrade, yet the daemon IS gone, so the marker must exist and say only that the daemon stopped.
  const s = await liveSession('ok');
  writeFileSync(join(s.runDir, 'dirty'), 'perhaps\n');  // forces an attestation downgrade to failed
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed', 'the trailer verdict is failed');
  const marker = join(s.runDir, 'teardown');
  assert.ok(existsSync(marker), 'the daemon WAS confirmed gone, so the run is safe to delete');
  assert.equal(readFileSync(marker, 'utf8'), 'confirmed stopped\n',
    'the marker must not claim the review completed when the emitted verdict was failed');
});

test('the final verdict is persisted to `phase`, matching the STATUS trailer, so a lost stdout still establishes the result', async () => {
  // stdout is a pipe a dropped turn or truncated capture can lose; the retained directory must still
  // record what happened. `phase` is written from the same value as the STATUS line, at the single
  // emit choke point, so the two cannot disagree. Completed first...
  const done = await liveSession('ok');
  const rc = await collect(done.runDir, 'completed');
  assert.equal(rc.code, 0, rc.stderr);
  assert.equal(lastTwo(rc.stdout)[0], 'STATUS: completed');
  assert.equal(readFileSync(join(done.runDir, 'phase'), 'utf8').trim(), 'completed');

  // ...then a downgrade: an unreadable dirty flag forces the verdict to failed AFTER the turn read as
  // completed. `phase` must record the FINAL downgraded verdict, not the optimistic pre-attestation
  // state — proving it is written from emit(), past every downgrade, not at read time.
  const bad = await liveSession('ok');
  writeFileSync(join(bad.runDir, 'dirty'), 'perhaps\n');
  const rb = await collect(bad.runDir, 'completed');
  assert.equal(rb.code, 2);
  assert.equal(lastTwo(rb.stdout)[0], 'STATUS: failed');
  assert.equal(readFileSync(join(bad.runDir, 'phase'), 'utf8').trim(), 'failed',
    'phase must record the final verdict emitted, not the read-as-completed state');
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

test('a review far larger than one pipe buffer survives intact, trailers included', async () => {
  // THE regression: process.stdout is a pipe here, pipe writes are async, and process.exit()
  // discards whatever has not reached the OS. This exact shape emitted 65536 bytes of a 1 MiB body
  // and lost BOTH trailers while still exiting 0 — truncated findings AND a silently disabled
  // enforcement hook, the worst reachable combination.
  const s = await liveSession('huge');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.length > 512 * 1024, `body was truncated: only ${r.stdout.length} bytes survived`);
  assert.match(r.stdout, /^Reviewed a very large delta\.$/m, 'the head of the body must survive');
  assert.match(r.stdout, /^- \[P2\] finding 20000 — a\.txt:20000$/m, 'the last finding must survive');
  const [status, scope] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: completed');
  assert.match(scope, /^SCOPE: .* head=[0-9a-f]{40} dirty=false$/);
});

test('a session with no review.json is not certifiable — a plain send is not a review', async () => {
  // `send` leaves no review.json, so its absence is the only signal separating an ordinary chat turn
  // from a native git-scoped review. Without this the collector would stamp any completed turn with
  // the contract the gate trusts.
  const s = await liveSession('ok');
  rmSync(join(s.runDir, 'review.json'));
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  assert.match(r.stderr, /cannot prove a native review/);
  assert.ok(!existsSync(join(s.runDir, 'last-reviewed-sha')));
});

test('a plain send AFTER the review cannot be certified by the stale review.json', async () => {
  // The attack: a real review completes (review.json is written and valid), then an ordinary chat
  // turn runs on the same session. `read` now returns the CHAT turn. review.json existence alone
  // would launder that chat turn into a certified review; binding on the collected turn's kind is
  // what refuses it.
  const s = await liveSession('ok');                 // review completes, review.json persisted
  const send = await cli(['send', 'say OK', '--socket', s.socket], { env: env('ok') });
  assert.equal(send.code, 0, `send failed: ${send.stderr}`);
  await driveToTerminal(s.socket, env('ok'));        // the chat turn is now the current turn
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2, 'a chat turn must never certify as a review');
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  assert.match(r.stderr, /the collected turn is a 'turn', not a review/);
  assert.ok(!existsSync(join(s.runDir, 'last-reviewed-sha')));
});

test('a SECOND review on the same session cannot be certified under the first review.json', async () => {
  // The subtle attack `kind` alone misses: review A completes (review.json + scope describe A), then
  // review B runs on the same socket. `read` returns B — kind:'review', so the kind check passes —
  // but B's body would be labeled with A's scope/dirty. The per-turn token binds review.json to A's
  // exact invocation, so B (a higher token) is refused rather than mislabeled.
  const s = await liveSession('ok');                       // review A; review.json captured for A
  const base = readFileSync(join(s.runDir, 'baseline'), 'utf8').trim();
  const tokenA = JSON.parse(readFileSync(join(s.runDir, 'review.json'), 'utf8')).turnToken;
  assert.ok(Number.isInteger(tokenA), 'review.json must carry a per-turn token');
  const revB = await cli(['review', '--base', base, '--socket', s.socket], { env: env('ok') });
  assert.equal(revB.code, 0, `review B failed to start: ${revB.stderr}`);
  const tokenB = JSON.parse(revB.stdout).turnToken;
  assert.notEqual(tokenB, tokenA, 'a second review must get a distinct token');
  await driveToTerminal(s.socket, env('ok'));              // B is now the current turn
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2, "review B must not certify under review A's review.json");
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  assert.match(r.stderr, /turn token mismatch/);
  assert.ok(!existsSync(join(s.runDir, 'last-reviewed-sha')));
});

test('a review.json stripped of status:"running" is not well-formed and blocks certification', async () => {
  // Only ok + scope used to be checked; a record missing the status field still certified. Every
  // field the `review` verb emits must be present, or it is not the output of a real review start.
  const s = await liveSession('ok');
  const rec = JSON.parse(readFileSync(join(s.runDir, 'review.json'), 'utf8'));
  delete rec.status;
  writeFileSync(join(s.runDir, 'review.json'), JSON.stringify(rec));
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.equal(lastTwo(r.stdout)[0], 'STATUS: failed');
  assert.match(r.stderr, /cannot prove a native review|turn token mismatch/);
});

test('a review.json stripped of its turnToken cannot bind to the collected turn', async () => {
  const s = await liveSession('ok');
  const rec = JSON.parse(readFileSync(join(s.runDir, 'review.json'), 'utf8'));
  delete rec.turnToken;
  writeFileSync(join(s.runDir, 'review.json'), JSON.stringify(rec));
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /turn token mismatch|cannot prove a native review/);
});

test('a missing cwd sidecar blocks certification even though the daemon cwd still matches start.json', async () => {
  // start.json still carries cwd, so ownership and the head= attestation are provable — but the
  // recipe writes the cwd sidecar in the same block as everything else, so its absence means the run
  // directory is not a complete run and must not be certified.
  const s = await liveSession('ok');
  rmSync(join(s.runDir, 'cwd'));
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no cwd sidecar/);
  assert.ok(pidAlive(s.pid) === false, 'the daemon is ours by threadId, so it is still stopped');
});

test('a start.json stripped of cwd blocks certification (the daemon repo is unverifiable)', async () => {
  const s = await liveSession('ok');
  const st = JSON.parse(readFileSync(join(s.runDir, 'start.json'), 'utf8'));
  delete st.cwd;
  writeFileSync(join(s.runDir, 'start.json'), JSON.stringify(st));
  rmSync(join(s.runDir, 'cwd'));           // remove the sidecar too: now NO cwd exists anywhere
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cwd was not positively matched|records no cwd/);
});

test('a start.json stripped of pid blocks certification', async () => {
  const s = await liveSession('ok');
  const st = JSON.parse(readFileSync(join(s.runDir, 'start.json'), 'utf8'));
  delete st.pid;
  writeFileSync(join(s.runDir, 'start.json'), JSON.stringify(st));
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /records no pid/);
});

test('an unreadable dirty flag blocks certification instead of shipping an (unresolved) attestation', async () => {
  // `SCOPE: … dirty=(unresolved)` exiting 0 is the gate accepting a review nobody can place. Exit 0
  // claims the scope is known; when it is not, the claim is simply unavailable.
  const s = await liveSession('ok');
  writeFileSync(join(s.runDir, 'dirty'), 'perhaps\n');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  const [status, scope] = lastTwo(r.stdout);
  assert.equal(status, 'STATUS: failed');
  assert.match(scope, /dirty=\(unresolved\)$/, 'the trailer must still say plainly what it could not resolve');
  assert.match(r.stderr, /refusing to certify an unattested review/);
});

test('a scope sidecar disagreeing with review.json blocks certification', async () => {
  const s = await liveSession('ok');
  writeFileSync(join(s.runDir, 'scope'), 'some other scope entirely\n');
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /scope sidecar .* disagrees with review\.json/);
});

test('a pid sidecar disagreeing with start.json refuses, and leaves the daemon alone', async () => {
  // start.json is the authority; a sidecar that has drifted from it means this state directory no
  // longer describes one session, so nothing here may be stopped.
  const s = await liveSession('ok');
  writeFileSync(join(s.runDir, 'pid'), `${process.pid}\n`);
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /pid sidecar .* disagrees with start\.json/);
  assert.match(r.stderr, /refusing to stop a session that is not provably ours/);
  assert.ok(pidAlive(s.pid), 'the unidentified daemon must still be running');
});

test('a start.json with no threadId is refused before any daemon is contacted', async () => {
  const s = await liveSession('ok');
  const st = JSON.parse(readFileSync(join(s.runDir, 'start.json'), 'utf8'));
  delete st.threadId;
  writeFileSync(join(s.runDir, 'start.json'), JSON.stringify(st));
  const r = await collect(s.runDir, 'completed');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /records no threadId/);
  assert.ok(pidAlive(s.pid));
});

test('two collectors running concurrently do not cross-talk', { timeout: 60000 }, async () => {
  // Nothing in the collector is global — it is addressed entirely by --state-dir and --socket — and
  // this pins that. A shared session file or a stray `--force` would show up here as one collector
  // stopping the other's daemon, which is precisely the fix-loop hazard (a repo can have a review
  // and a re-review in flight from different agents).
  const [a, b] = await Promise.all([liveSession('ok'), liveSession('statusinbody')]);
  assert.notEqual(a.socket, b.socket, 'private sessions must not share a socket');

  const [ra, rb] = await Promise.all([collect(a.runDir, 'completed'), collect(b.runDir, 'completed')]);
  assert.equal(ra.code, 0, ra.stderr);
  assert.equal(rb.code, 0, rb.stderr);
  assert.match(ra.stdout, /Reviewed 1 file\./);
  assert.match(rb.stdout, /a trap for naive trailer parsing/);
  assert.equal(lastTwo(ra.stdout)[1], `SCOPE: ${readFileSync(join(a.runDir, 'scope'), 'utf8').trim()} head=${a.head} dirty=false`);
  assert.equal(lastTwo(rb.stdout)[1], `SCOPE: ${readFileSync(join(b.runDir, 'scope'), 'utf8').trim()} head=${b.head} dirty=false`);
  assert.ok(!pidAlive(a.pid) && !pidAlive(b.pid), 'both daemons must be torn down');
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
