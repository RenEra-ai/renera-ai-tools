// Append the architect plan file VERBATIM under a fixed, clearly-labeled header so the review judges
// against the exact saved bytes — never a model paraphrase. Empty/absent plan → base prompt unchanged.
// Pure (no IO) so it is unit-testable without booting a Codex daemon; review-round.mjs reads the file
// and passes the text here.
export const PLAN_HEADER = '=== ARCHITECT DESIGN PLAN (verbatim) ===';

export function buildReviewPrompt(basePrompt, planText) {
  if (planText == null || !String(planText).trim()) return basePrompt;
  const body = String(planText).replace(/\n+$/, '');   // normalize to one trailing newline; bytes otherwise exact
  return `${basePrompt}\n\n${PLAN_HEADER}\n${body}\n`;
}
