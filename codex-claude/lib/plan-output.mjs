// Classify whether a completed Plan-mode response contains a substantive plan or only a preamble /
// generic Plan-mode help text. Conservative by design: only clearly thin output is rejected.
export function looksLikeNoPlan(msg) {
  const t = (msg || '').trim();
  if (!t) return true;
  if (/^I.?m Codex in this workspace/i.test(t)) return true;
  if (/Current mode:\s*\*?\*?Plan Mode/i.test(t)) return true;

  // A real file-by-file plan cites concrete files and/or enumerated/bulleted steps. Output with none
  // of those is narration / a reasoning preamble, regardless of length; a long preamble has slipped
  // through before. Lowercase extensions of length >=2 dodge prose false positives like files.The and
  // abbreviations like e.g./i.e.
  const hasFileRef = /[\w/-]+\.[a-z]{2,6}\b/.test(t);
  const hasNumberedStep = /(^|\n)\s*\d+[.)]\s/.test(t);
  const hasBullets = /(^|\n)\s*[-*]\s+\S/.test(t);
  return !hasFileRef && !hasNumberedStep && !hasBullets;
}

// Decide whether a Plan-mode turn carries a plan worth persisting as a durable artifact. Mirrors the
// '(no-plan)'/'(empty)' gate the drivers print: persist ONLY a turn that actually completed with a
// substantive body — never an empty/timeout/failed turn or a reasoning-preamble. Keeps the on-disk
// `.codex/plans/*` artifact truthful (a degraded turn fails loud upstream instead of writing junk).
export function isUsablePlan(status, message, empty) {
  if (status !== 'completed' || empty) return false;
  const t = (message || '').trim();
  if (!t || t === '(empty)') return false;
  return !looksLikeNoPlan(t);
}
