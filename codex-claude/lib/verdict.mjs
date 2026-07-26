// The ONE deterministic verdict rule, shared by every consumer that has to turn a Codex review
// message into a verdict. It lived only inside scripts/review-round.mjs — the one script the
// reviewer agent is BANNED from running (agents/codex-impl-reviewer.md:84-87) — so the agent file
// told the agent to read a `PARSED_VERDICT:` line that its mandated recipe could never produce, and
// the agent had to improvise the one field the contract most wants pinned.
//
// THE RULE, and why it is this strict: ONLY the FINAL non-empty line may be the verdict. A model
// that emits its verdict and then keeps talking has NOT delivered a clean verdict — trailing text
// after a `VERDICT:` line yields UNCLEAR, which is what makes the drivers' static re-ask fire
// instead of certifying a half-finished review.

const VERDICT_LINE = /^VERDICT:\s*(NO ISSUES|ISSUES FOUND)$/i;

// The final non-empty, trimmed line of `message` ('' when there is none).
function finalLine(message) {
  const lines = String(message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

/** True when the message ENDS with a well-formed verdict line. */
export function hasVerdict(message) {
  return VERDICT_LINE.test(finalLine(message));
}

/**
 * The deterministic verdict of a review message.
 * @returns {'NO ISSUES'|'ISSUES FOUND'|'UNCLEAR'} — UNCLEAR for a missing/empty message, a literal
 *   `VERDICT: UNCLEAR` final line, or any text following an earlier verdict line.
 */
export function parseVerdict(message) {
  const m = VERDICT_LINE.exec(finalLine(message));
  return m ? m[1].toUpperCase() : 'UNCLEAR';
}
