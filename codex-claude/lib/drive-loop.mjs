// ONE wait/drain engine for every driver.
//
// This logic existed in three near-identical copies (review-round, plan-round, commit-review-round),
// each with its own 540000ms constant, its own drain guard of 20, and its own first-option
// extraction — so a protocol change to the question payload had to be fixed three times, and a miss
// meant that driver silently answered questions with `undefined` mid-review. The approval POLICY is
// the part that genuinely differs per driver, so it is injected.
import { performance } from 'node:perf_hooks';
import { sendCommand } from './client.mjs';

// Cap on the interrupt call itself: a wedged daemon must not turn cleanup into a second hang.
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
 *                    "9 minute" cap became a ~3 hour worst case.
 *  - log(msg)        stderr logger; the caller supplies its own '[prefix] '
 *  - decideApproval(request) => 'allow' | 'deny' | 'fail'   ('fail' => interrupt, status 'failed')
 *  - onMalformedQuestion 'fail' | 'return'  (default 'fail')
 *  - onUnsupported       'fail' | 'return'  (default 'return')
 *  - maxDrains       how many parked rounds to service before giving up (default 20)
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
  } = opts;

  // Monotonic: a wall-clock source can jump backwards (NTP, DST) and hand out a budget that never
  // expires — the exact unbounded wait this is here to prevent.
  const startedAt = performance.now();
  const remaining = () => (deadlineMs == null ? waitTimeoutMs
    : Math.min(waitTimeoutMs, Math.ceil(deadlineMs - (performance.now() - startedAt))));

  // Answering/approving must be bounded too — client.mjs reads a missing or <=0 timeout as NO
  // timeout, so an unanswered action call hung the whole loop past its total budget. Never <=0:
  // fall back to the interrupt cap so an exhausted budget still yields a bounded call rather than
  // an unbounded one.
  const actionBudget = () => {
    const left = remaining();
    return left > 0 ? Math.min(left, INTERRUPT_TIMEOUT_MS) : INTERRUPT_TIMEOUT_MS;
  };

  async function interruptAndReturn(status, reason) {
    log(`${reason} — interrupting`);
    try { await sendCommand(socketPath, { cmd: 'interrupt' }, { timeoutMs: INTERRUPT_TIMEOUT_MS }); }
    catch { /* best effort: the point is not to leave the turn running, not to prove we stopped it */ }
    return { status, message: '', reason };
  }

  async function waitOnce() {
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
      return interruptAndReturn('timeout', outOfBudget ? 'total wait budget exhausted' : 'wait cap expired');
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
      log(`${decision === 'allow' ? 'approving' : 'declining'} approval: ${request.method || '?'}`);
      const r = await sendCommand(socketPath, { cmd: 'approve', decision }, { timeoutMs: actionBudget() });
      // An {error} here means the daemon could not act on our decision (e.g. a shape protocol.mjs
      // refuses to fake). Looping would just re-park the same request until the drain guard ran out,
      // spraying misleading log lines on the way.
      if (r && r.error) return interruptAndReturn('failed', `approve rejected: ${r.error}`);
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
      const r = await sendCommand(socketPath, { cmd: 'answer', id: q.id, answers: [answer] }, { timeoutMs: actionBudget() });
      if (r && r.error) return interruptAndReturn('failed', `answer rejected: ${r.error}`);
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
