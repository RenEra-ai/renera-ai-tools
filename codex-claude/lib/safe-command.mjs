// Auto-approval gate for the ephemeral plan/review drivers. Codex needs exactly ONE thing it cannot do
// through its native file-reading tools: RUN THE REPO'S TEST SUITE to verify. So this gate auto-approves
// ONLY the test runner and DENIES everything else (git, find, cat, rg, …). Inspection commands are not
// needed here — Codex reads files via its own read tools, which never hit command approval — so denying
// shell inspection costs nothing while removing the entire command-string evasion surface.
//
// Why this is robust where a broad allowlist was not: the only positive matches are literal test-runner
// forms, so a quoting/backslash/whitespace trick can at worst make a match FAIL (→ deny, the safe
// direction) — it can never forge an approval for some other program. As defence in depth we still
// unwrap one `sh -c` layer, reject shell metacharacters (chaining / redirect / substitution / subshell /
// background), and reject env-assignment prefixes — so `pytest; rm -rf`, `pytest > x`, and
// `LD_PRELOAD=evil.so pytest` are all denied. Deny is always the safe fallback.

// Chaining / pipe / redirection / command-or-var substitution / subshell / background / newline.
const DANGEROUS_META = /[;&|<>`$()\n\r]/;

// Unwrap a single `sh -c`/`zsh -lc`/`bash -lc` wrapper to its inner command; strip matched surrounding
// quotes only when the tail is metacharacter-free (so a chain hidden outside the quotes survives the
// metachar check below).
function unwrap(cmd) {
  const m = /^\s*\/?(?:[\w/]*\/)?(?:ba|z)?sh\s+-[a-z]*c\s+(.+)$/i.exec(cmd);
  if (!m) return cmd.trim();
  let inner = m[1].trim();
  if (!DANGEROUS_META.test(inner) &&
      ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"')))) {
    inner = inner.slice(1, -1).trim();
  }
  return inner;
}

// The repo's test runner — and nothing else. (`python -m pytest|unittest` allows interpreter flags like
// -B between `python` and `-m`, but NOT `-c`, which would mean "exec this code" rather than run a module.)
function isTestRunner(s) {
  if (/^pytest\b/.test(s)) return true;
  if (/^(tox|nox)\b/.test(s)) return true;
  if (/^python3?\s+(-[A-Za-z]+\s+)*-m\s+(pytest|unittest)\b/.test(s)) return true;
  return false;
}

export function isSafeCommand(raw) {
  const cmd = String(raw == null ? '' : raw);
  if (!cmd.trim()) return false;
  const inner = unwrap(cmd);
  if (DANGEROUS_META.test(inner)) return false;   // no chaining / redirect / substitution
  if (/^\w+=/.test(inner)) return false;          // no env-assignment prefix (LD_PRELOAD/PYTHONPATH injection)
  return isTestRunner(inner);
}
