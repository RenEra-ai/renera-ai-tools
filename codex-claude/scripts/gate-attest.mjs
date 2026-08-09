#!/usr/bin/env node
// Terminal step of a DISPATCHER-OWNED Codex gate: prove the session is the one the dispatcher
// started, take its result straight from the live daemon, tear the daemon down, and write the only
// artifact anyone is allowed to trust.
//
// WHY THIS EXISTS, and why it is not a `verify` of something an agent wrote:
// docs/bugs/subagent-messages-not-delivered-to-main-thread.md records a run in which the harness
// silently dropped a helper agent's plugin identity. The agent therefore never loaded the
// fail-closed mandate that was supposed to make it drive Codex, and it reviewed the diff itself, as
// its own model, in good faith. The gate's enforcement lived entirely in a system prompt that was
// never applied. So: anything the agent authors — a report, a JSON record, a hash of either — is
// exactly as forgeable as the verdict it is meant to certify. The ONLY evidence with any weight is
// evidence the dispatcher collects itself, from a live daemon it started, before it stops it.
//
// The trust boundary this implements:
//   dispatcher  starts the --private daemon, writes the prompt files, hashes them, runs THIS script
//   helper      is handed a socket and prompt paths; it can drive the turn and nothing else
//   daemon      refuses any prompt whose sha256 is not on the dispatcher's allowlist
//   collector   proves ownership, reads the result, stops, confirms death, writes the artifact
//
// A helper that never reached Codex cannot produce a passing run: an idle session has no turn to
// attest, and a substituted prompt cannot start a turn at all.
//
// WHAT THIS IS NOT — stated so nobody over-reads the guarantee. The threat model is a helper that
// is not the agent it was asked for: a generic assistant with this agent's task, acting in good
// faith. It is NOT an OS sandbox. A hostile process running as the same user can kill the daemon and
// bind its own listener on the socket path, or rewrite the run directory, and this script has no
// authority that could tell the difference. That is why the run directory the dispatcher passes as
// --state-dir must NOT be the directory whose paths the helper is given: the shipped recipes keep
// the prompts in a separate directory, so the helper never learns where start.json lives.
//
// CONTRACT: exactly one compact JSON object on stdout per invocation.
//   exit 0  {ok:true, …}                  — attested; the record and the artifact are on disk
//   exit 1  {ok:false, reason:"usage", …} — bad arguments; nothing was touched
//   exit 2  {ok:false, reason, stopped[, salvaged]} — refusal. `stopped` reports whether THIS
//                                           invocation left the daemon provably dead, so the caller
//                                           knows if a session still needs recovery (a refusal that
//                                           never reached the daemon reports false because it
//                                           stopped nothing, not because something is known to be
//                                           alive). Diagnostics go to stderr, never stdout.
//
// Refusals are RECORDED, and the structural ones can SALVAGE (both exist because of
// docs/bugs/gate-orphaned-completed-turn.md, where a refusal silently destroyed a completed
// 17-minute review): every refusal taken while the lock is held also writes refusal.json into
// --state-dir (reader: scripts/gate-attest-status.mjs — a refused run directory is otherwise
// indistinguishable from one where collect never ran), and when --salvage is given, a refusal whose
// cause is mechanical rather than declared writes the turn's text there — a non-authoritative copy
// that is NEVER an artifact and must never be read as findings.
//
// ORDERING RULE, load-bearing: before ownership is proven, this script stops NOTHING (tearing down
// an unidentified daemon is how one agent kills another's review). After ownership is proven, it
// ALWAYS stops and confirms teardown before deciding anything else — so no refusal path can leave
// an orphaned app-server behind.
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs, assertOnlyFlags } from '../lib/verbs.mjs';
import { sendCommand } from '../lib/client.mjs';
import { isUsablePlan } from '../lib/plan-output.mjs';
import { parseVerdict } from '../lib/verdict.mjs';
import { testTeardownMs } from '../lib/test-appserver.mjs';

const USAGE = 'gate-attest.mjs collect --state-dir <dir> --gate <architect|review> '
  + '--outcome <completed|failed|timeout> --cwd <repo-root> --artifact <new-path> [--prompt <path>] [--plan <path>] [--salvage <path>]';
const ALLOWED_FLAGS = ['state-dir', 'gate', 'outcome', 'cwd', 'artifact', 'plan', 'prompt', 'salvage'];
const GATES = ['architect', 'review'];
const OUTCOMES = ['completed', 'failed', 'timeout'];
// The turn is long over by the time this runs; every call here is a local socket round-trip, so a
// short cap turns a wedged daemon into a refusal instead of a hang.
const CALL_TIMEOUT_MS = 10000;
const TEARDOWN_POLL_MS = 100;
const HEX64 = /^[0-9a-f]{64}$/;

const warn = (m) => process.stderr.write(`[gate-attest] ${m}\n`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// stdout is a PIPE under the Bash tool and pipe writes are ASYNCHRONOUS: process.exit() discards
// whatever has not reached the OS. The payload is one short line, but the exit code means nothing to
// a caller that never received the line explaining it.
async function emit(body, code) {
  const text = JSON.stringify(body) + '\n';
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(done, 2000);
    process.stdout.write(text, done);
  });
  process.exit(code);
}

const usageError = async (msg) => { warn(msg); warn(USAGE); await emit({ ok: false, reason: 'usage', stopped: false }, 1); };
// `stopped` is never guessed: callers use it to decide whether a run directory still owns a daemon.
// The closure reads salvagePath/SALVAGE_REASONS/liveMessage/lockHeld/refusalPath, all declared below
// but before the first possible call (:collect_in_progress), and atomicWrite, which is hoisted.
const refuse = async (reason, stopped, detail) => {
  if (detail) warn(detail);
  // SALVAGE (opt-in, structural refusals only). A refusal destroys the CERTIFICATION; for these
  // reasons — a real round that failed mechanically — destroying the TEXT with it is how a completed
  // 17-minute review was lost (docs/bugs/gate-orphaned-completed-turn.md). Never on
  // declared_failed/declared_timeout: there the dispatcher's own declaration is the reason, and a
  // readable review would invite re-litigating it.
  let salvaged = null;
  if (salvagePath && SALVAGE_REASONS.has(reason) && liveMessage && liveMessage.trim()) {
    try {
      atomicWrite(salvagePath, Buffer.from(liveMessage.endsWith('\n') ? liveMessage : `${liveMessage}\n`, 'utf8'));
      salvaged = salvagePath;
      warn(`unattested turn text salvaged to ${salvagePath} — NOT a gate artifact; never act on it as findings`);
    } catch (e) { warn(`salvage write failed (${e.message}); the refusal stands`); }
  }
  // DURABLE REFUSAL RECORD. stdout is a pipe a dropped turn can lose, and without this a refused run
  // directory is indistinguishable from one where collect never ran. Only while the lock is held: a
  // pre-lock refusal is (or races) someone else's collect over the same directory.
  if (lockHeld) {
    try {
      atomicWrite(refusalPath, Buffer.from(`${JSON.stringify({ reason, stopped, collectedAt: new Date().toISOString(), ...(salvaged ? { salvagePath: salvaged } : {}) }, null, 2)}\n`, 'utf8'));
    } catch (e) { warn(`could not record the refusal (${e.message})`); }
  }
  warn(`refusing to attest: ${reason}`);
  await emit({ ok: false, reason, stopped, ...(salvaged ? { salvaged } : {}) }, 2);
};

// --- argv ---------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
// ONLY as the sole argument. `--help` anywhere inside a real `collect` line would otherwise print
// `{ok:true,…}` and exit 0 — the exact shape the dispatcher is told means "attested" — turning a
// typo into a passed gate. Inside a collect line it now falls through to the unknown-flag refusal.
if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) await emit({ ok: true, usage: USAGE }, 0);

let parsed;
try {
  parsed = parseArgs(argv);
  assertOnlyFlags(parsed.flags, ALLOWED_FLAGS);
} catch (e) { await usageError(e.message); }
if (parsed.verb !== 'collect') await usageError(`unknown verb '${parsed.verb ?? '(none)'}'; the only verb is 'collect'`);
if (parsed.positional !== undefined) await usageError(`unexpected argument '${parsed.positional}'`);

async function flagValue(name, { required = true } = {}) {
  const v = parsed.flags[name];
  if (v === undefined) {
    if (required) await usageError(`--${name} is required`);
    return null;
  }
  // A valueless flag parses as boolean `true`; String(true) would become a path literally named
  // "true" — the same truthiness trap the CLI's own flags document.
  if (typeof v !== 'string' || !v.trim()) await usageError(`--${name} requires a value`);
  return v.trim();
}

const stateDir = await flagValue('state-dir');
const gate = await flagValue('gate');
const outcome = await flagValue('outcome');
const expectedCwd = await flagValue('cwd');
const artifactPath = await flagValue('artifact');
const planPath = await flagValue('plan', { required: false });
const promptFile = await flagValue('prompt', { required: false });
const salvagePath = await flagValue('salvage', { required: false });

if (!GATES.includes(gate)) await usageError(`--gate must be one of ${GATES.join('|')} (got '${gate}')`);
if (!OUTCOMES.includes(outcome)) await usageError(`--outcome must be one of ${OUTCOMES.join('|')} (got '${outcome}')`);
for (const [name, val] of [['state-dir', stateDir], ['cwd', expectedCwd], ['artifact', artifactPath], ...(planPath ? [['plan', planPath]] : []), ...(promptFile ? [['prompt', promptFile]] : []), ...(salvagePath ? [['salvage', salvagePath]] : [])]) {
  if (!isAbsolute(val)) await usageError(`--${name} must be an absolute path (got '${val}')`);
}
if (!existsSync(stateDir)) await usageError(`--state-dir does not exist: ${stateDir}`);

// Resolved after the argv preflight: the seam THROWS on a malformed ambient value, and at module
// top that would turn `--help` into a stack trace.
let TEARDOWN_TIMEOUT_MS;
try { TEARDOWN_TIMEOUT_MS = testTeardownMs() ?? 30000; } catch (e) { await usageError(e.message); }

const startPath = join(stateDir, 'start.json');
const lockPath = join(stateDir, 'collect.lock');
const attestationPath = join(stateDir, 'attestation.json');
const refusalPath = join(stateDir, 'refusal.json');
// The salvage file must never be mistakable for the artifact, nor able to claim any of this run
// directory's own records: planted at the artifact path it hands UNCERTIFIED text the exact name
// every downstream step trusts, and planted at refusal.json it would beat the durable refusal
// record to its own name. Compared RESOLVED, not as raw strings — `/x//artifact.md`, `/x/./…` and a
// symlinked parent all alias the same file.
const normPath = (p) => { try { return join(realpathSync(dirname(p)), basename(p)); } catch { return resolve(p); } };
if (salvagePath) {
  for (const [what, p] of [['the --artifact path', artifactPath], ['start.json', startPath], ['collect.lock', lockPath], ['attestation.json', attestationPath], ['refusal.json', refusalPath]]) {
    if (normPath(salvagePath) === normPath(p)) {
      await usageError(`--salvage must not be ${what} (the salvage copy is not an artifact, and never a state-dir record)`);
    }
  }
}
// The refusals whose cause is mechanical — a real round, a real turn that failed a shape or persist
// step — may carry their text to --salvage. That includes the persist-phase refusals: by then the
// turn has passed every structural check and the daemon is already dead, so discarding the text over
// a pre-existing file or a failed write is pure loss (the incident class again). Declared/derailed
// outcomes and identity failures never salvage. (`empty_result` is in the set for symmetry but a
// blank message skips the write anyway.)
const SALVAGE_REASONS = new Set(['gate_mismatch', 'wrong_turn_kind', 'empty_result', 'unusable_plan', 'prompt_mismatch',
  'preexisting_artifact', 'preexisting_attestation', 'artifact_write_failed', 'attestation_write_failed']);
let lockHeld = false;
let liveMessage = null;

// --- one collect per run directory --------------------------------------------------------------
// Exclusive create, never released: a run directory describes ONE gate round, and a second collect
// against it would be either a retry of an already-torn-down session (nothing left to prove) or a
// concurrent collector racing this one over the same outputs.
try {
  closeSync(openSync(lockPath, 'wx'));
  lockHeld = true;
} catch (e) {
  await refuse('collect_in_progress', false, `could not take ${lockPath}: ${e.message}`);
}

// --- the start record ---------------------------------------------------------------------------
// Written by `codex-drive start` itself and captured verbatim by the DISPATCHER. It is the only
// statement of what the dispatcher intended; everything below is checked against it.
let start = null;
try {
  // Not merely readable: a symlink here would let anything on the machine redirect what this
  // collector believes it started, and the whole point is that the record is the dispatcher's.
  const st = lstatSync(startPath);
  if (!st.isFile()) throw new Error('not a regular file');
  start = JSON.parse(readFileSync(startPath, 'utf8'));
  // JSON `null` (and any other non-object) parses without throwing; dereferencing it below would
  // kill the module with a bare TypeError — empty stdout, exit 1, lock burned, no refusal record.
  if (start === null || typeof start !== 'object' || Array.isArray(start)) throw new Error('not a JSON object');
} catch (e) {
  await refuse('invalid_start_record', false, `${startPath}: ${e.message}`);
}

const startSocket = typeof start.socket === 'string' && start.socket.trim() ? start.socket.trim() : null;
const startThread = typeof start.threadId === 'string' && start.threadId.trim() ? start.threadId.trim() : null;
const startCwd = typeof start.cwd === 'string' && start.cwd.trim() ? start.cwd.trim() : null;
const startPid = Number.isInteger(start.pid) && start.pid > 0 ? start.pid : null;
const allowedPrompts = Array.isArray(start.gatePromptSha256) ? start.gatePromptSha256 : [];
// Absence is NOT refused here: a record without `gate` only occurs on version skew, and the
// snapshot's protocol check catches that case with a confirmed teardown instead of walking away
// from a daemon a record-level refusal would orphan.
const startGate = start.gate === 'architect' || start.gate === 'review' ? start.gate : null;

if (start.ok !== true || !startSocket || !isAbsolute(startSocket) || !startThread || !startCwd || startPid === null) {
  await refuse('invalid_start_record', false, `${startPath} is not a complete \`start\` record`);
}
// No PID means teardown can never be PROVEN (socket absence alone does not prove the app-server
// died), so such a record could only ever produce an unconfirmed teardown.
if (!allowedPrompts.length || !allowedPrompts.every((h) => typeof h === 'string' && HEX64.test(h))) {
  await refuse('invalid_start_record', false, 'start record carries no usable gatePromptSha256 policy — this was not a gate session');
}
// A shared session's socket can be redirected by any concurrent `start` on the machine, so "the
// daemon at this socket" would not be a stable claim.
if (start.private !== true) await refuse('non_private_session', false, 'start record is not a --private session');

// --- ownership (nothing is stopped until every check below has passed) ---------------------------
const call = (cmd) => sendCommand(startSocket, cmd, { timeoutMs: CALL_TIMEOUT_MS });
const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };

const realExpected = realOrNull(expectedCwd);
const realStart = realOrNull(startCwd);
if (!realExpected || !realStart || realExpected !== realStart) {
  await refuse('ownership_mismatch', false, `--cwd ${expectedCwd} does not resolve to the session's cwd ${startCwd}`);
}

let st = null;
try {
  st = await call({ cmd: 'status' });
} catch (e) {
  await refuse('session_unreachable', false, `status probe failed: ${e.message}`);
}
if (!st || st.error) await refuse('session_unreachable', false, `status probe returned an error: ${st && st.error}`);
if (st.threadId !== startThread) {
  await refuse('ownership_mismatch', false, `daemon reports thread ${st.threadId ?? '(none)'}, start.json recorded ${startThread}`);
}
if (st.cwd !== startCwd) {
  await refuse('ownership_mismatch', false, `daemon serves ${st.cwd ?? '(none)'}, start.json recorded ${startCwd}`);
}

// OWNERSHIP IS PROVEN HERE — the threadId is unique per session and this daemon serves the recorded
// repo. From this line on, EVERY exit tears the daemon down first: a refusal that walks away from a
// daemon it has already identified as ours orphans it (and the never-released lock below means no
// second collect can come back for it).
const pidAlive = (p) => {
  if (p === null) return false;
  try { process.kill(p, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; }   // EPERM = alive but not ours; only ESRCH proves death
};

async function confirmStopped() {
  const deadline = Date.now() + TEARDOWN_TIMEOUT_MS;
  for (;;) {
    if (!existsSync(startSocket) && !pidAlive(startPid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, TEARDOWN_POLL_MS));
  }
}

/**
 * End the session and PROVE it ended. `stop` ACKS BEFORE TEARDOWN (lib/daemon.mjs: the response is
 * written, then the daemon tears down), so the reply proves nothing — death is the socket
 * disappearing AND the recorded pid being gone.
 * @returns {Promise<boolean>} whether teardown was confirmed.
 */
async function teardown(turnStatus) {
  // A turn still running or parked must be ended at the PROTOCOL level first — `stop` on a live turn
  // is the orphaning path the agent recipes are also forbidden to take.
  if (turnStatus === 'running' || turnStatus === 'awaiting_input') {
    try { await call({ cmd: 'interrupt' }); } catch (e) { warn(`interrupt failed: ${e.message}`); }
  }
  let stopError = null;
  try {
    const res = await call({ cmd: 'stop' });
    if (res && res.error) stopError = res.error;
  } catch (e) { stopError = e.message; }
  const stopped = await confirmStopped();
  if (!stopped) {
    warn(stopError ? `stop reported '${stopError}' and teardown was not confirmed within ${TEARDOWN_TIMEOUT_MS}ms`
      : `teardown was not confirmed within ${TEARDOWN_TIMEOUT_MS}ms`);
    warn(`state retained at ${stateDir}; recover with: codex-drive stop --socket "${startSocket}"`);
  } else if (stopError) {
    warn(`stop reported '${stopError}' but teardown was confirmed`);
  }
  return stopped;
}

/** Refuse, having first torn down the daemon we have just proven is ours. */
const refuseOwned = async (reason, detail, turnStatus) => refuse(reason, await teardown(turnStatus), detail);

// --- the gate snapshot: identity AND result in one reply -----------------------------------------
// Two calls could straddle a turn boundary and bind an identity to a result that never belonged to
// it. An older daemon does not know this command, and that `unknown_cmd` is the runtime-skew signal:
// a detached 1.8.19 daemon keeps serving happily after an upgrade, and silently accepting it would
// mean attesting a session whose prompt policy was never enforced.
let snap = null;
try {
  snap = await call({ cmd: 'gate_snapshot' });
} catch (e) {
  await refuseOwned('session_unreachable', `gate_snapshot failed: ${e.message}`, st.turnStatus);
}
if (!snap || snap.error === 'unknown_cmd' || snap.gateProtocol !== 2) {
  await refuseOwned('runtime_skew', 'daemon does not serve gate_snapshot protocol 2 (started by an older build?) — a session with no gate-kind binding cannot be attested by this collector',
    snap && typeof snap.status === 'string' ? snap.status : st.turnStatus);
}
// The SNAPSHOT's turn status, not the earlier probe's: a turn can start (or end) between the two
// calls, and teardown keys its protocol-level interrupt on this value — a stale 'completed' would
// stop a now-running turn without interrupting it, the exact orphaning path teardown() avoids.
const liveTurnStatus = typeof snap.status === 'string' ? snap.status : st.turnStatus;
// From here the turn's text is in hand — any structural refusal below may salvage it.
if (typeof snap.message === 'string') liveMessage = snap.message;
if (snap.private !== true) await refuseOwned('non_private_session', 'live daemon reports a shared session', liveTurnStatus);
if (snap.pid !== startPid || snap.threadId !== startThread || snap.cwd !== startCwd) {
  await refuseOwned('ownership_mismatch', `gate_snapshot identity (pid ${snap.pid}, thread ${snap.threadId}, cwd ${snap.cwd}) disagrees with the start record`, liveTurnStatus);
}
// The gate the daemon ENFORCED is the authority — the flag only claims. A session bound to the
// other gate (or to none: direct construction, never possible via a 1.8.21 `start`) cannot certify
// this one, whatever the turn looked like.
if (snap.gate !== gate) {
  await refuseOwned('gate_mismatch', snap.gate
    ? `this session was started for the '${snap.gate}' gate, not '${gate}'`
    : 'the live daemon reports no gate kind — the session was never bound to a gate', liveTurnStatus);
}
if (startGate !== null && startGate !== snap.gate) {
  await refuseOwned('gate_mismatch', 'start record and live daemon disagree about the gate kind', liveTurnStatus);
}
const livePolicy = Array.isArray(snap.gatePromptSha256) ? snap.gatePromptSha256 : [];
const sameSet = livePolicy.length === allowedPrompts.length && [...livePolicy].sort().join(',') === [...allowedPrompts].sort().join(',');
if (!sameSet) {
  await refuseOwned('prompt_mismatch', 'the live daemon enforces a different prompt policy than the start record', liveTurnStatus);
}

const snapshot = {
  status: snap.status, message: typeof snap.message === 'string' ? snap.message : '',
  empty: snap.empty === true, kind: snap.kind, turnToken: snap.turnToken, promptSha256: snap.promptSha256,
  promptSha256Seen: Array.isArray(snap.promptSha256Seen) ? snap.promptSha256Seen : [],
};

// --- always stop, then confirm ------------------------------------------------------------------
const stopped = await teardown(snapshot.status);
if (!stopped) await refuse('teardown_unconfirmed', false, 'the daemon was not provably torn down');

// --- what the turn actually was -----------------------------------------------------------------
// The caller's --outcome is a CEILING. A dispatcher that already knows the round failed (its helper
// errored, its own cap expired) must never have that upgraded by a turn that happened to finish in
// the meantime — that is precisely how an abandoned round would launder itself into a clean gate.
if (outcome === 'failed') await refuse('declared_failed', true, 'the dispatcher declared this round failed');
if (outcome === 'timeout') await refuse('declared_timeout', true, 'the dispatcher declared this round timed out');

// A session that never ran a turn has no prompt hash and no token. This is the headline case: the
// helper that never reached Codex at all.
if (snapshot.promptSha256 === null || snapshot.promptSha256 === undefined || !Number.isInteger(snapshot.turnToken) || snapshot.turnToken < 1) {
  await refuse('turn_not_completed', true, 'the session ran no turn — nothing was ever sent to Codex');
}
// Defence in depth: the daemon already refuses an unapproved prompt, so reaching here means the
// recorded hash was produced by something other than this policy.
if (!allowedPrompts.includes(snapshot.promptSha256)) {
  await refuse('prompt_mismatch', true, `the turn ran a prompt (${snapshot.promptSha256}) that is not on the dispatcher's allowlist`);
}
// The RETRY prompt is a context-free re-ask ("output the review NOW…") — it only means anything as
// a later turn of a session that actually RAN the real brief. A turnToken heuristic ("token ≥ 2")
// is forgeable by sending the re-ask twice, so the daemon records every prompt hash that started a
// turn (promptSha256Seen) and the check demands the PRIMARY among them. allowedPrompts[0] is the
// primary by construction (bin/codex-drive.mjs records the policy in flag order).
if (allowedPrompts.length > 1 && snapshot.promptSha256 !== allowedPrompts[0]
  && !snapshot.promptSha256Seen.includes(allowedPrompts[0])) {
  await refuse('prompt_mismatch', true, 'the certifying turn is the re-ask, and the primary brief never ran on this session; a retry certifies nothing on its own');
}
if (snapshot.status !== 'completed') await refuse('turn_not_completed', true, `turn status is '${snapshot.status}'`);

// `kind` is per-turn (lib/daemon.mjs), so this also rejects a gate certified by a LATER, different
// turn on the same session. Defence in depth since protocol 2: the daemon's own kind front-stop
// makes this unreachable via a 1.8.21 `start`, but a hand-built daemon has no such guarantee.
const expectedKind = gate === 'architect' ? 'plan' : 'turn';
if (snapshot.kind !== expectedKind) {
  await refuse('wrong_turn_kind', true, `${gate} gate requires kind '${expectedKind}', the turn was '${snapshot.kind}'`);
}
if (snapshot.empty || !snapshot.message.trim()) await refuse('empty_result', true, 'the turn completed with no content');
if (gate === 'architect' && !isUsablePlan(snapshot.status, snapshot.message, snapshot.empty)) {
  await refuse('unusable_plan', true, 'the plan turn produced only a preamble — no files, steps or bullets');
}

// A completed review with no parseable verdict is ATTESTED but never clean: Codex really ran, it
// just did not deliver a verdict line. The caller decides what to do with it; this script refuses to
// turn it into one.
const parsedVerdict = gate === 'review' ? parseVerdict(snapshot.message) : null;

// --- persist (artifact first, record last) --------------------------------------------------------
if (existsSync(artifactPath)) await refuse('preexisting_artifact', true, `${artifactPath} already exists`);
if (existsSync(attestationPath)) await refuse('preexisting_attestation', true, `${attestationPath} already exists`);

let planSha = null;
let planBytes = null;
if (planPath) {
  try {
    planBytes = readFileSync(planPath);
    if (!planBytes.length || !planBytes.toString('utf8').trim()) throw new Error('empty');
    planSha = sha256(planBytes);
  } catch (e) {
    await refuse('unusable_plan', true, `--plan could not be read: ${planPath}: ${e.message}`);
  }
}

// END-TO-END BINDING (optional but strongly recommended: the shipped recipes always pass it).
// Without the prompt file, `inputPlan` only records that a plan EXISTED — the collector never sees
// what the model was actually asked. This closes the gap in the direction that actually goes wrong
// in practice: not an attacker, but a dispatcher that followed the recipe imperfectly and never
// inlined the plan, leaving a "reviewed against the plan" record for a review that never saw it.
if (promptFile) {
  let promptBytes = null;
  try { promptBytes = readFileSync(promptFile); }
  catch (e) { await refuse('prompt_mismatch', true, `--prompt could not be read: ${promptFile}: ${e.message}`); }
  if (sha256(promptBytes) !== snapshot.promptSha256) {
    await refuse('prompt_mismatch', true, `--prompt ${promptFile} is not the prompt this turn ran`);
  }
  if (planBytes && !promptBytes.includes(planBytes)) {
    await refuse('unusable_plan', true, 'the plan was never inlined into the prompt — this review did not judge against it');
  }
}

// Durable + atomic: write to a unique sibling temp, fsync it, then rename (atomic on POSIX), so a
// reader never sees a torn file and a failed write leaves only the temp — which we remove.
function atomicWrite(target, bytes) {
  const tmp = `${target}.tmp-${process.pid}`;
  let fd = null;
  try {
    fd = openSync(tmp, 'wx');
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd); fd = null;
    // rename(2) would silently clobber; the exclusive-target rule is the point of the check.
    if (existsSync(target)) throw new Error(`target appeared while writing: ${target}`);
    renameSync(tmp, target);
    // The rename is only durable once the DIRECTORY entry is. Best effort: not every platform
    // permits opening a directory, and a missing dir-fsync is not a reason to fail the gate.
    try { const dfd = openSync(dirname(target), 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* best effort */ }
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } }
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    throw e;
  }
}

// The artifact is the daemon's own message, plus exactly one terminal newline. Not the helper's
// summary of it: the whole point is that no agent-authored text is on this path.
const artifactBytes = Buffer.from(snapshot.message.endsWith('\n') ? snapshot.message : `${snapshot.message}\n`, 'utf8');
try {
  atomicWrite(artifactPath, artifactBytes);
} catch (e) {
  await refuse('artifact_write_failed', true, `${artifactPath}: ${e.message}`);
}

const record = {
  schema: 1,
  gateProtocol: 2,
  gate,
  collectedAt: new Date().toISOString(),
  start: { threadId: startThread, pid: startPid, socket: startSocket, cwd: startCwd, private: true },
  prompt: { allowedSha256: allowedPrompts, actualSha256: snapshot.promptSha256, ...(promptFile ? { path: promptFile, verified: true } : {}) },
  turn: { status: snapshot.status, kind: snapshot.kind, turnToken: snapshot.turnToken, messageSha256: sha256(Buffer.from(snapshot.message, 'utf8')) },
  artifact: { path: artifactPath, sha256: sha256(artifactBytes) },
  ...(planPath ? { inputPlan: { path: planPath, sha256: planSha } } : {}),
  parsedVerdict,
  teardown: 'confirmed',
};
try {
  atomicWrite(attestationPath, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
} catch (e) {
  // Never leave a certified-looking artifact next to no record of what certified it: the artifact
  // exists only as the attestation's subject.
  try { rmSync(artifactPath, { force: true }); } catch { /* best effort */ }
  await refuse('attestation_write_failed', true, `${attestationPath}: ${e.message}`);
}

// The ONLY authorization this design issues. The record on disk is audit evidence, not a credential
// anything may re-verify later: a gate is authorized by THIS exit-0 line, in the turn that ran it.
await emit({
  ok: true, schema: 1, gate, status: snapshot.status, parsedVerdict,
  threadId: startThread, turnToken: snapshot.turnToken, promptSha256: snapshot.promptSha256,
  messageSha256: record.turn.messageSha256, artifactPath, attestationPath, stopped: true,
}, 0);
