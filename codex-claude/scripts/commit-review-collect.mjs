#!/usr/bin/env node
// Terminal step of the DETACHED Stage-2 commit review — the only hook-visible call in the recipe.
//
// The polling loop is prose (the consumer's CLAUDE.md Stage 2): it starts a detached `--private`
// daemon, sends one native `review`, and polls `wait` in SEPARATE Bash calls, so no Bash cap and no
// signal can reach the session. That is the whole point of the detached path — an in-process driver
// dies with its Bash call and takes a healthy Codex turn with it.
//
// This helper does the terminal step ONLY: prove the session is the one the recipe started, read the
// result, stop the daemon, and emit the enforcement contract. Everything policy-shaped (poll
// cadence, stall threshold, wall-clock backstop, question/approval handling) deliberately stays in
// prose — this is not a second drive-loop.
//
// Why a script at all, when the architecture is prose: this output is what the PostToolUse
// enforcement hook keys on, and a prose recipe already lost that once. The daemon-verbs fallback
// ended in `read --out`, which prints a single JSON line with no `SCOPE:`, so the review silently
// escaped the receiving-code-review gate entirely. Prose is fine for policy; it is not fine for a
// contract another program parses.
//
// Output contract (order matters — the trailers are LAST so they survive a `tail`):
//   <review text, raw and in full>
//   STATUS: completed|timeout|failed
//   SCOPE: <label> head=<sha> dirty=<true|false>
//
// Note the trailing `dirty=` field: the one-shot (`commit-review-round.mjs`) stays on the older
// two-field form. Both satisfy the hook, which anchors on `^SCOPE: ` only.
//
// Exit 0 means, and ONLY means: a completed, non-empty, attested review whose daemon is confirmed
// stopped. Exit 1 is usage/preflight — no session was ever started, so there is nothing to attest.
// Exit 2 is everything else, and always carries the trailer pair.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendCommand } from '../lib/client.mjs';
import { parseArgs, assertOnlyFlags } from '../lib/verbs.mjs';
import { testTeardownMs } from '../lib/test-appserver.mjs';

const USAGE = 'usage: commit-review-collect.mjs --state-dir <dir> --outcome <completed|timeout|failed>';
const OUTCOMES = ['completed', 'timeout', 'failed'];
const ALLOWED_FLAGS = ['state-dir', 'outcome'];

// Every daemon call is bounded. A collector that can block forever reintroduces exactly the failure
// the detached path exists to remove, one layer up.
const CALL_TIMEOUT_MS = 10000;
const TEARDOWN_POLL_MS = 100;
const UNRESOLVED = '(unresolved)';

const warn = (msg) => process.stderr.write(`[collect] ${msg}\n`);

function die(msg, code) {
  process.stderr.write(`[collect] ${msg}\n`);
  if (code === 1) process.stderr.write(`${USAGE}\n`);
  process.exit(code);
}

// --- argv ---
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${USAGE}\n`); process.exit(0); }

let parsed;
try {
  parsed = parseArgs(['commit-review-collect', ...argv]);
  assertOnlyFlags(parsed.flags, ALLOWED_FLAGS);
} catch (e) {
  die(e.message, 1);
}
if (parsed.positional !== undefined) die(`unexpected argument '${parsed.positional}'`, 1);

const flagValue = (name) => {
  const v = parsed.flags[name];
  if (typeof v !== 'string' || !v.trim()) die(`--${name} requires a non-blank value`, 1);
  return v.trim();
};

const stateDir = flagValue('state-dir');
const outcome = flagValue('outcome');
if (!OUTCOMES.includes(outcome)) die(`--outcome must be one of ${OUTCOMES.join('|')} (got '${outcome}')`, 1);
if (!existsSync(stateDir)) die(`state dir not found: ${stateDir}`, 1);

// Teardown is confirmed, not assumed: `stop` responds BEFORE the daemon finishes tearing down (the
// response is sent from _onClient and the app-server dies after), so returning on the response
// alone would report success while an app-server is still alive. Resolved AFTER the argv preflight
// because the seam THROWS on a malformed ambient value, and at module top that would turn `--help`
// into a stack trace — the same ordering bug commit-review-round.mjs:62-65 documents.
let TEARDOWN_TIMEOUT_MS;
try { TEARDOWN_TIMEOUT_MS = testTeardownMs() ?? 30000; } catch (e) { die(e.message, 1); }

// --- state ---
const readState = (name) => {
  try {
    const raw = readFileSync(join(stateDir, name), 'utf8').trim();
    return raw.length ? raw : null;
  } catch { return null; }
};

let start = null;
try {
  start = JSON.parse(readFileSync(join(stateDir, 'start.json'), 'utf8'));
} catch { /* handled below */ }

// No start.json means the recipe never got a session up, so there is nothing to own, stop or attest.
// That is a preflight error (exit 1, no trailers) rather than a failed review: emitting a terminal
// pair here would tell the gate a review was attempted and produced nothing, when in fact the run
// never began. Past this line a session DID exist, so every exit carries the trailers.
if (!start || typeof start.socket !== 'string' || !start.socket.trim()) {
  die(`no usable start.json in ${stateDir}; the session was never started (nothing to collect)`, 1);
}

const scopeLabel = readState('scope') || UNRESOLVED;
const startHead = readState('start-head') || UNRESOLVED;
const dirtyRaw = readState('dirty');
// Only the two literals are attestable. Anything else is an unreadable sidecar, and guessing
// `false` would understate what was reviewed.
const dirty = dirtyRaw === 'true' || dirtyRaw === 'false' ? dirtyRaw : UNRESOLVED;
const persistedCwd = readState('cwd');
const socketFile = readState('socket');
const pidRaw = readState('pid');
const pid = pidRaw !== null && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
const socket = start.socket;

// --- helpers ---
// Output is BUFFERED until after the stop attempt: printing the review first would let a cleanup
// failure arrive after a body the gate has already accepted, and the trailers must be the last two
// lines of THIS call's stdout.
function emit(status, reviewText, code) {
  const text = reviewText || '';
  if (text) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  process.stdout.write(`STATUS: ${status}\n`);
  process.stdout.write(`SCOPE: ${scopeLabel} head=${startHead} dirty=${dirty}\n`);
  process.exit(code);
}

const call = (cmd) => sendCommand(socket, cmd, { timeoutMs: CALL_TIMEOUT_MS });

const pidAlive = (p) => {
  if (p === null) return false;
  try { process.kill(p, 0); return true; }
  // EPERM means alive but not ours; only ESRCH proves it is gone.
  catch (e) { return e.code !== 'ESRCH'; }
};

const recovery = () => {
  warn(`state retained at ${stateDir}`);
  const cacheDir = readState('cache-dir');
  const drive = cacheDir ? `${cacheDir}/bin/codex-drive.mjs` : '<cache-dir>/bin/codex-drive.mjs';
  warn(`recover with: node "${drive}" stop --socket "${socket}"`);
};

// A stop we could not confirm is the orphan case: a detached daemon plus its codex app-server left
// running with nobody holding the socket. Never report success over it.
async function confirmStopped() {
  const deadline = Date.now() + TEARDOWN_TIMEOUT_MS;
  for (;;) {
    if (!existsSync(socket) && !pidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, TEARDOWN_POLL_MS));
  }
}

// --- collect ---
// `timeout` survives as its own status so the wall-clock backstop stays distinguishable from a
// defect; every other unhappy path collapses to `failed`. Both are exit 2 — "no trustworthy
// review" either way. The caller's --outcome is a CEILING: a turn that happens to finish during an
// abort must never be laundered into a clean review the gate would accept.
const unhappy = outcome === 'timeout' ? 'timeout' : 'failed';
let reviewText = '';
let terminal = unhappy;
// A refusal means we could NOT prove this daemon is the one the recipe started. Ownership failures
// deliberately stop NOTHING: tearing down a session we cannot identify is how one agent kills
// another agent's review and orphans its own. Everything past the ownership gate is ours to stop.
let refusal = null;

try {
  if (socketFile && socketFile !== socket) {
    refusal = `socket sidecar (${socketFile}) disagrees with start.json (${socket})`;
  }

  let st = null;
  if (!refusal) {
    try {
      st = await call({ cmd: 'status' });
    } catch (e) {
      refusal = `status probe failed (${e.message}); cannot prove session ownership`;
    }
  }
  if (!refusal && st && st.error) refusal = `status probe returned an error (${st.error})`;
  if (!refusal && st) {
    if (start.threadId && st.threadId && st.threadId !== start.threadId) {
      refusal = `thread mismatch: daemon reports ${st.threadId}, start.json recorded ${start.threadId}`;
    // The daemon's OWN cwd, not ours: `--socket` bypasses the global state file, so this is the only
    // authority on WHICH repository was reviewed. A mismatch means we attached to a daemon serving a
    // different tree, and the head= attestation would be a lie.
    } else if (persistedCwd && st.cwd && st.cwd !== persistedCwd) {
      refusal = `cwd mismatch: daemon serves ${st.cwd}, state recorded ${persistedCwd}`;
    }
  }

  if (!refusal) {
    const readRes = await call({ cmd: 'read' });
    if (readRes && readRes.error) throw new Error(`read returned an error (${readRes.error})`);
    reviewText = (readRes && readRes.message) || '';
    if (outcome === 'completed') {
      if (readRes.status === 'completed' && reviewText.trim().length > 0) {
        terminal = 'completed';
      } else {
        // Blank text on a 'completed' turn is NOT a clean review; the gate reads "no findings" as
        // "ship it". The daemon already fails such a turn — this is the second line of defence.
        warn(readRes.status === 'completed'
          ? 'turn completed with blank review text — refusing to report success'
          : `turn status is '${readRes.status}', not 'completed'`);
      }
    }
  }
} catch (e) {
  // Never let an unexpected throw skip the stop below: that is the orphan path.
  warn(`collection failed: ${e.message}`);
  terminal = unhappy;
}

if (refusal) {
  warn(refusal);
  warn('refusing to stop a session that is not provably ours');
  recovery();
  emit(unhappy, '', 2);
}

// --- always stop, then confirm ---
let stopError = null;
try {
  const res = await call({ cmd: 'stop' });
  if (res && res.error) stopError = res.error;
} catch (e) {
  stopError = e.message;
}

if (!(await confirmStopped())) {
  recovery();
  warn(stopError
    ? `daemon stop failed (${stopError}) and teardown was not confirmed within ${TEARDOWN_TIMEOUT_MS}ms`
    : `teardown was not confirmed within ${TEARDOWN_TIMEOUT_MS}ms`);
  // A cleanup failure DOWNGRADES a would-be completion: an orphaned app-server is a real cost, and
  // reporting success over it is how the orphan goes unnoticed until someone finds it days later.
  emit(unhappy, reviewText, 2);
}
if (stopError) warn(`stop reported '${stopError}' but teardown was confirmed`);

if (terminal === 'completed' && startHead === UNRESOLVED) {
  warn('no start HEAD recorded — a clean exit here would be unattested');
  emit(unhappy, reviewText, 2);
}

// Only a confirmed-clean, completed review advances the round marker. Writing it earlier would let a
// failed round move the baseline and silently shrink the NEXT review's scope.
if (terminal === 'completed') {
  try {
    writeFileSync(join(stateDir, 'last-reviewed-sha'), `${startHead}\n`);
  } catch (e) {
    warn(`could not record last-reviewed-sha (${e.message})`);
    emit(unhappy, reviewText, 2);
  }
}

// The state directory is deliberately NOT removed: it holds the baseline, the round marker and the
// cleanup evidence the enclosing task still needs. The recipe removes it when the task ends.
emit(terminal, reviewText, terminal === 'completed' ? 0 : 2);
