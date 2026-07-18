// ONE wait/drain engine for every driver.
//
// This logic existed in three near-identical copies (review-round, plan-round, commit-review-round),
// each with its own 540000ms constant, its own drain guard of 20, and its own first-option
// extraction — so a protocol change to the question payload had to be fixed three times, and a miss
// meant that driver silently answered questions with `undefined` mid-review. The approval POLICY is
// the part that genuinely differs per driver, so it is injected.
import { performance } from 'node:perf_hooks';
import { sendCommand } from './client.mjs';

// Fixed cap on the cleanup interrupt itself: a wedged daemon must not turn cleanup into a second
// hang. Deliberately NOT clamped by deadlineMs — the deadline is the wait/drain budget, and once it
// is exhausted this is the one bounded post-deadline grace that actually delivers the cancellation.
// Clamping it to the exhausted remainder would either become UNBOUNDED in sendCommand (a timeout
// <= 0 disables the timer entirely, client.mjs) or destroy the socket before the interrupt is even
// written — abandoning the very cancellation the budget exists to guarantee.
const INTERRUPT_TIMEOUT_MS = 10000;

/**
 * Pick the answer for a parked question. Accepts every option shape the protocol uses: a bare
 * string, `{label}`, or `{value}`. The daemon already reads `label ?? value` when resolving
 * `__option:<n>`; the drivers only ever read `.label`, so a `{value}`-only option answered the
 * question with the string "undefined".
 */
export function firstOptionAnswer(question) {
  const first = question && question.options && question.options[0];
  if (first == null) return 'proceed';
  if (typeof first === 'string') return first;
  return first.label ?? first.value ?? String(first);
}

/**
 * Drive an already-started turn to a terminal state.
 *
 * @param {string} socketPath
 * @param {object} opts
 *  - waitTimeoutMs   per-wait client cap (a timeout interrupts the turn and yields status 'timeout')
 *  - deadlineMs      OPTIONAL total wall-clock budget across ALL waits. Without it each parked
 *                    round resets the cap, so N rounds could run N × waitTimeoutMs — which is how a
 *                    "9 minute" cap became a ~3 hour worst case. deadlineMs bounds WAITING and
 *                    DRAINING only: when it exhausts, one final cleanup `interrupt` is still sent
 *                    under its own fixed INTERRUPT_TIMEOUT_MS cap, so "out of budget" ends with a
 *                    bounded cancellation, not an abandonment.
 *  - log(msg)        stderr logger; the caller supplies its own '[prefix] '
 *  - decideApproval(request) => 'allow' | 'deny' | 'fail'   ('fail' => interrupt, status 'failed')
 *  - onMalformedQuestion 'fail' | 'return'  (default 'fail')
 *  - onUnsupported       'fail' | 'return'  (default 'return')
 *  - maxDrains       how many parked rounds to service before giving up (default 20)
 *  - onWaitExpiry    'interrupt' | 'rewait' (default 'interrupt'). 'rewait' turns the per-wait cap
 *                    into a POLL INTERVAL: expiry logs and waits again instead of killing the turn.
 *                    A slow turn is not a dead turn — the fixed cap killed two healthy ~10-minute
 *                    Codex reviews in one day, while a 21-minute one completed fine under manual
 *                    re-waits. deadlineMs exhaustion STILL interrupts regardless of this mode, so
 *                    an explicit total budget is never weakened.
 * @returns {Promise<{status:string, message?:string, empty?:boolean, reason?:string}>}
 */
export async function driveTurn(socketPath, opts = {}) {
  const {
    waitTimeoutMs = 540000,
    deadlineMs = null,
    log = () => {},
    decideApproval = () => 'deny',
    onMalformedQuestion = 'fail',
    onUnsupported = 'return',
    maxDrains = 20,
    onWaitExpiry = 'interrupt',
  } = opts;

  // Monotonic: a wall-clock source can jump backwards (NTP, DST) and hand out a budget that never
  // expires — the exact unbounded wait this is here to prevent.
  const startedAt = performance.now();
  const remaining = () => (deadlineMs == null ? waitTimeoutMs
    : Math.min(waitTimeoutMs, Math.ceil(deadlineMs - (performance.now() - startedAt))));

  // The one sanctioned post-deadline action: a single interrupt under the fixed cap above.
  async function interruptAndReturn(status, reason) {
    log(`${reason} — interrupting`);
    try { await sendCommand(socketPath, { cmd: 'interrupt' }, { timeoutMs: INTERRUPT_TIMEOUT_MS }); }
    catch { /* best effort: the point is not to leave the turn running, not to prove we stopped it */ }
    return { status, message: '', reason };
  }

  // One bounded action (answer/approve), budget-guarded like the waits: an exhausted deadline goes
  // straight to the single cleanup interrupt instead of granting the action another grace, and an
  // action that TIMES OUT (a daemon wedged mid-answer) routes through interruptAndReturn like an
  // expired wait — it used to throw straight out of driveTurn, skipping the cleanup interrupt the
  // deadline contract promises. Returns {reply} from the daemon, or {terminal} to hand the caller.
  //
  // ONE sample of remaining() decides both the guard and the cap: re-reading the clock for the cap
  // meant a deadline expiring between the two reads still handed the action a full post-deadline
  // grace — the interrupt-only contract, lost to a race. client.mjs reads <= 0 as NO timeout, which
  // the guard above has already excluded here.
  async function actionOnce(cmdObj, name) {
    const budget = remaining();
    if (budget <= 0) return { terminal: await interruptAndReturn('timeout', 'total wait budget exhausted') };
    try {
      const timeoutMs = Math.min(budget, INTERRUPT_TIMEOUT_MS);
      return { reply: await sendCommand(socketPath, cmdObj, { timeoutMs }) };
    } catch (e) {
      if (!/timeout/i.test(e.message)) throw e;
      return { terminal: await interruptAndReturn('timeout', `${name} call timed out`) };
    }
  }

  async function waitOnce() {
    for (;;) {
      const budget = remaining();
      // NEVER call sendCommand with <= 0: it reads that as "no timeout at all" (client.mjs), so an
      // exhausted budget would become an unbounded wait instead of an immediate stop.
      if (budget <= 0) return interruptAndReturn('timeout', 'total wait budget exhausted');
      try {
        return await sendCommand(socketPath, { cmd: 'wait' }, { timeoutMs: budget });
      } catch (e) {
        if (!/timeout/i.test(e.message)) throw e;
        // Say WHICH limit ended it. The total budget clamps the per-wait cap, so a run that exhausts
        // its budget usually expires inside a clamped wait rather than landing exactly on zero —
        // reporting "wait cap expired" there would send the operator after the wrong knob.
        const outOfBudget = deadlineMs != null && (performance.now() - startedAt) >= deadlineMs;
        if (outOfBudget) return interruptAndReturn('timeout', 'total wait budget exhausted');
        if (onWaitExpiry === 'rewait') {
          // The cap is a poll interval here, not a verdict on the turn. The external bound is the
          // caller's own lifetime (e.g. the Bash tool cap + the drivers' SIGTERM teardown).
          log('wait cap expired — turn still running, re-waiting');
          continue;
        }
        return interruptAndReturn('timeout', 'wait cap expired');
      }
    }
  }

  let res = await waitOnce();
  let drains = 0;
  while ((res.status === 'question' || res.status === 'approval') && drains++ < maxDrains) {
    if (res.status === 'approval') {
      const request = res.request || {};
      const decision = decideApproval(request);
      if (decision === 'fail') {
        return interruptAndReturn('failed', `approval policy refuses ${request.method || '?'}`);
      }
      // Name the COMMAND when allowing: "approving approval: <method>" tells an operator nothing
      // about what was actually authorised, and the pre-migration drivers logged the command here.
      const cmd = request.params && request.params.command;
      log(decision === 'allow'
        ? `approving safe command: ${cmd ? String(cmd).slice(0, 140) : (request.method || '?')}`
        : `declining approval: ${request.method || '?'}`);
      const a = await actionOnce({ cmd: 'approve', decision }, 'approve');
      if (a.terminal) return a.terminal;
      // An {error} here means the daemon could not act on our decision (e.g. a shape protocol.mjs
      // refuses to fake). Looping would just re-park the same request until the drain guard ran out,
      // spraying misleading log lines on the way.
      if (a.reply && a.reply.error) return interruptAndReturn('failed', `approve rejected: ${a.reply.error}`);
    } else {
      const qs = res.question && res.question.questions;
      if (!Array.isArray(qs) || !qs.length) {
        if (onMalformedQuestion === 'fail') return interruptAndReturn('failed', 'malformed question payload');
        // RETURN, not break: breaking leaves res.status === 'question', which the post-loop guard
        // below then reads as drain exhaustion — so 'return' mode would interrupt the turn and
        // report `failed`, the exact opposite of handing the parked shape back to the caller.
        log('malformed question payload — stopping');
        return res;
      }
      const q = qs[0];
      const answer = firstOptionAnswer(q);
      log(`answering question ${q.id} -> ${answer}`);
      const a = await actionOnce({ cmd: 'answer', id: q.id, answers: [answer] }, 'answer');
      if (a.terminal) return a.terminal;
      if (a.reply && a.reply.error) return interruptAndReturn('failed', `answer rejected: ${a.reply.error}`);
    }
    res = await waitOnce();
  }

  if (res.status === 'question' || res.status === 'approval') {
    return interruptAndReturn('failed', 'drain guard exhausted');
  }
  // 'unsupported' = a parked shape this client cannot answer (an elicitation, or a permissions-shaped
  // approval whose response shape protocol.mjs deliberately refuses to fake).
  if (res.status === 'unsupported') {
    const method = (res.request && res.request.method) || '?';
    if (onUnsupported === 'fail') return interruptAndReturn('failed', `unsupported request: ${method}`);
    log(`unsupported request: ${method}`);
  }
  return res;
}
