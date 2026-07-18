#!/usr/bin/env node
// One-shot native commit review, for a shell gate (boomi-mcp-server's CLAUDE.md Stage 2).
//
// Boots a PRIVATE ephemeral daemon on a temp socket, runs one git-scoped `review/start`, prints the
// review verbatim, and exits with an honest code. It reuses review-round.mjs's daemon LIFECYCLE only:
// that script always exits 0 and fronts metadata by design of its /codex-issue parser, whereas this
// one is consumed by `&&`-style shell logic and MUST be exit-code-honest.
//
// It never touches ~/.codex-drive/state.json: the global CLI verbs would let a concurrent `start`
// elsewhere redirect this review, and our own state write would clobber someone else's session.
//
// Output contract (order matters — the trailers are LAST so they survive a `tail`):
//   <review text, raw and in full>
//   STATUS: completed|timeout|failed
//   SCOPE: <label> [base=<sha> head=<sha>]
//
// No verdict parsing: deciding "zero issues" is Claude's job under receiving-code-review. This script
// only guarantees that a clean exit means a REAL review of a NON-EMPTY diff actually happened.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Daemon, REVIEW_PROFILE } from '../lib/daemon.mjs';
import { sendCommand } from '../lib/client.mjs';
import { CLIENT_INFO } from '../lib/protocol.mjs';
import { parseArgs, assertOnlyFlags } from '../lib/verbs.mjs';
import { resolveReviewTarget, fullSha, SCOPES } from '../lib/git-scope.mjs';
import { driveTurn } from '../lib/drive-loop.mjs';
import { testAppServerOpts, testWaitMs } from '../lib/test-appserver.mjs';

const USAGE = `usage: commit-review-round.mjs [--base <ref> | --scope <${SCOPES.join('|')}>] [--cwd <repo>]`;

// TOTAL wall-clock budget for the whole drive, under the ~10-min Bash cap so a wedged turn can't
// hang the gate. It used to be applied PER wait, so each parked round reset it and the real bound
// was 20 rounds × 9 minutes ≈ 3 hours — the opposite of the guarantee the comment claimed.
const WAIT_TIMEOUT_MS = testWaitMs() ?? 540000;

const ALLOWED_FLAGS = ['base', 'scope', 'cwd'];

function die(msg, code) {
  process.stderr.write(`[commit-review] ${msg}\n`);
  if (code === 1) process.stderr.write(`${USAGE}\n`);   // spec: usage errors print usage
  process.exit(code);
}

// --- argv ---
// `--help` BEFORE anything else: this script once ran a full live review for `--help`, which is the
// bug that started the whole flag-validation cleanup.
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${USAGE}\n`); process.exit(0); }

// The SHARED parser, not a hand-rolled one. The local copy had already drifted: it was first-wins on
// a repeated flag while the CLI is last-wins, so `--base A --base B` reviewed a different range
// depending on which entry point you used. It also brings the `--flag=value` rejection for free.
let parsed;
try {
  parsed = parseArgs(['commit-review-round', ...argv]);
  assertOnlyFlags(parsed.flags, ALLOWED_FLAGS);
} catch (e) {
  die(e.message, 1);
}
if (parsed.positional !== undefined) die(`unexpected argument '${parsed.positional}'`, 1);

const flagValue = (name) => {
  if (!(name in parsed.flags)) return undefined;
  const v = parsed.flags[name];
  // Blank counts as missing. `--cwd ""` would otherwise pass, then lose to `|| process.cwd()` and
  // review whatever directory we happen to be in — a review of the wrong repository that exits 0.
  if (typeof v !== 'string' || !v.trim()) die(`--${name} requires a non-blank value`, 1);
  return v;
};

const base = flagValue('base');
const scope = flagValue('scope');
const cwd = resolve(flagValue('cwd') || process.cwd());

// --- preflight: the FULL authoritative validation, before a daemon exists ---
// Not a hand-rolled subset: this is the same resolveReviewTarget the daemon runs, so the repo check,
// the scope enum, --base/--scope exclusivity, ref resolution, ancestry and the empty-delta rule all
// come from one place and cannot drift. It costs milliseconds and it runs with a SCRUBBED git env,
// unlike the raw execFileSync calls it replaces — which answered from whatever GIT_DIR the caller
// happened to export. The daemon still re-validates authoritatively.
try {
  resolveReviewTarget(cwd, { base, scope });
} catch (e) {
  die(e.message, 1);
}

let daemon = null;
let dir = null;
let status = 'failed';
let reviewText = '';
let scopeLabel = '(unresolved)';
let fatal = null;   // set instead of exiting: process.exit() inside the try would SKIP the finally,
                    // leaking the temp dir and orphaning a codex app-server.

async function teardown() {
  try { if (daemon) await daemon.stop(); } catch { /* best effort */ }
  try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  daemon = null; dir = null;
}

// Installed BEFORE any resource exists, so a signal that lands mid-boot still cleans up. Without
// these, a SIGTERM (the gate's own runner capping out, a user aborting) killed the process outright:
// the `finally` never ran, the temp dir leaked and the codex app-server was orphaned mid-review,
// still burning a turn. Idempotent — a second signal must not re-enter teardown.
let signalled = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (signalled) return;
    signalled = true;
    process.stderr.write(`[commit-review] ${sig} — cleaning up\n`);
    teardown().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  });
}

try {
  // Boot INSIDE the try: review-round.mjs boots before its try, so a boot failure there skips
  // cleanup and leaks a temp dir (and possibly an app-server).
  dir = mkdtempSync(join(tmpdir(), 'cdx-creview-'));
  const socketPath = join(dir, 'r.sock');
  daemon = new Daemon({
    socketPath,
    clientInfo: CLIENT_INFO,
    cwd,
    profile: REVIEW_PROFILE,
    appServerOpts: testAppServerOpts(),
  });
  await daemon.start();

  const started = await sendCommand(socketPath, { cmd: 'review', base, scope });
  if (started.error) {
    // A scope/validation rejection is a usage error (exit 1); `busy` cannot happen on a fresh
    // private daemon, but if it ever did it is a real failure, not bad input.
    fatal = { msg: started.error, code: started.error === 'busy' ? 2 : 1 };
  } else {
    scopeLabel = started.scope || scopeLabel;
    const res = await driveTurn(socketPath, {
      waitTimeoutMs: WAIT_TIMEOUT_MS,
      deadlineMs: WAIT_TIMEOUT_MS,        // TOTAL, not per-wait
      log: (m) => process.stderr.write(`[commit-review] ${m}\n`),
      // Deny approvals. NOT because a review never runs commands — it runs many (git diff, ls, …) —
      // but because under approvalPolicy:'never' + sandbox:'read-only' they never PROMPT. An approval
      // arriving here means the thread profile is wrong, so granting it would be the actual mistake.
      //
      // A permissions-shaped one is different again: protocol.mjs deliberately refuses to fake its
      // response shape, so denying it just errors. The spec maps it straight to interrupt + failed,
      // which is what 'fail' does — instead of 20 futile deny/wait rounds ending in the drain guard.
      decideApproval: (req) => (req.method === 'item/permissions/requestApproval' ? 'fail' : 'deny'),
      onMalformedQuestion: 'fail',
      onUnsupported: 'fail',
    });
    status = res.status;
    reviewText = res.message || '';
  }
} catch (e) {
  fatal = { msg: e.message, code: 1 };   // boot/transport failure
} finally {
  await teardown();
}

if (fatal) die(fatal.msg, fatal.code);

// --- output ---
const clean = status === 'completed' && reviewText.trim().length > 0;
if (reviewText) process.stdout.write(reviewText.endsWith('\n') ? reviewText : reviewText + '\n');
// Blank text on a 'completed' turn is NOT a clean review — the daemon already fails such a turn, and
// this is the second line of defence, because the gate reads "no findings" as "ship it".
process.stdout.write(`STATUS: ${clean ? 'completed' : (status === 'timeout' ? 'timeout' : 'failed')}\n`);
// Identify what was ACTUALLY reviewed, not merely what was asked for: a SCOPE line that only echoes
// the request cannot distinguish a real review from one anchored at the wrong commit. Scrubbed env
// (via git-scope), so an exported GIT_DIR cannot make this name a different repo's HEAD than the one
// the daemon reviewed.
const head = fullSha(cwd, 'HEAD');
process.stdout.write(`SCOPE: ${scopeLabel}${head ? ` head=${head}` : ''}\n`);
// timeout and failed are deliberately the SAME exit code: both mean "no trustworthy review".
process.exit(clean ? 0 : 2);
