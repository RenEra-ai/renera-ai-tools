// Classify whether a completed Plan-mode response contains a substantive plan or only a preamble /
// generic Plan-mode help text. Conservative by design: only clearly thin output is rejected.
export function looksLikeNoPlan(msg) {
  const t = (msg || '').trim();
  if (!t) return true;
  if (/^I.?m Codex in this workspace/i.test(t)) return true;
  if (/Current mode:\s*\*?\*?Plan Mode/i.test(t)) return true;

  // A real file-by-file plan cites concrete files and/or enumerated/bulleted steps. Output with none
  // of those is narration / a reasoning preamble, regardless of length.
  const hasFileRef = /[\w/-]+\.[a-z]{2,6}\b/.test(t);
  const hasNumberedStep = /(^|\n)\s*\d+[.)]\s/.test(t);
  const hasBullets = /(^|\n)\s*[-*]\s+\S/.test(t);
  return !hasFileRef && !hasNumberedStep && !hasBullets;
}
