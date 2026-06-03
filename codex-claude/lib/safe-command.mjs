// Allowlist gate for the ephemeral plan/review drivers. Codex refuses to architect or review without
// running the repo's tests to verify; the drivers therefore APPROVE a tight set of safe, read-only-ish
// commands (the test runner + inspection) so Codex can verify, and DENY everything else. Shared by
// plan-round.mjs and review-round.mjs so the security boundary can't drift between them.
//
// The gate is STRUCTURAL, not a token-contains check: a denylist can never be exhaustive, and
// "contains pytest" would approve `pytest; touch pwned` or `git diff && python -c '...'`. Instead we
// (1) unwrap one `sh -c` layer, (2) REFUSE any shell metacharacter that could chain / redirect /
// substitute / background another command, then (3) require the (now single) command to match a
// specific safe form. Deny is always the safe fallback — an over-narrow allowlist only costs Codex a
// stall, never a mutation.

// Metacharacters that let one command run another (chaining, pipes, redirection, command/var
// substitution, subshells, background, newlines). Any of these → we can't reason about what runs → deny.
const DANGEROUS_META = /[;&|<>`$()\n\r]/;

// Read-only inspection programs whose mere first-token presence is safe (no args can mutate state).
const READONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'nl', 'rg', 'grep', 'egrep', 'fgrep', 'ack', 'find', 'fd',
  'tree', 'pwd', 'echo', 'true', 'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink',
  'sort', 'uniq', 'cut', 'column', 'env', 'printenv', 'date', 'whoami', 'uname', 'which', 'type',
]);

// Unwrap a single `sh -c`/`zsh -lc`/`bash -lc` wrapper to the inner command; strip matched surrounding
// quotes. Returns the captured tail UNstripped of trailing junk so the metachar check still sees e.g.
// `'pytest' ; rm -rf /` (a chain hidden OUTSIDE the quotes).
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

// Does a single (already metachar-free) command match an allowed safe form?
function innerAllowed(inner) {
  let s = inner.trim();
  while (/^\w+=[^\s]*\s+/.test(s)) s = s.replace(/^\w+=[^\s]*\s+/, ''); // drop leading FOO=bar env assigns
  if (!s) return false;
  if (/^pytest\b/.test(s)) return true;                                          // the repo's test runner
  if (/^python3?\b/.test(s)) return /^python3?\s+(-[A-Za-z]+\s+)*-m\s+(pytest|unittest)\b/.test(s);
  if (/^(tox|nox)\b/.test(s)) return true;
  if (/^git\b/.test(s)) {
    return /^git\s+(-c\s+\S+\s+)*(status|diff|log|show|ls-files|rev-parse|branch|cat-file|describe|blame|grep|remote|config\s+--get)\b/.test(s);
  }
  const prog = s.split(/\s+/)[0] || '';
  if (prog === 'sed') return /^sed\s+-n\b/.test(s);   // print-mode sed only
  return READONLY.has(prog);
}

export function isSafeCommand(raw) {
  const cmd = String(raw == null ? '' : raw);
  if (!cmd.trim()) return false;
  const inner = unwrap(cmd);
  if (DANGEROUS_META.test(inner)) return false;   // no chaining/redirect/substitution
  return innerAllowed(inner);
}
