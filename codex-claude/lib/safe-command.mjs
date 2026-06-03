// Allowlist gate for the ephemeral plan/review drivers. Codex refuses to architect or review without
// running the repo's tests to verify; the drivers therefore APPROVE a tight set of safe commands (the
// test runner + read-only inspection) so Codex can verify, and DENY everything else. Shared by
// plan-round.mjs and review-round.mjs so the security boundary can't drift between them.
//
// The gate is STRUCTURAL and ARGUMENT-AWARE, not a token-contains check:
//   1. unwrap one `sh -c` layer;
//   2. REFUSE any shell metacharacter that could chain / redirect / substitute / background;
//   3. REFUSE a leading `VAR=val` env-assignment prefix (LD_PRELOAD/PYTHONPATH injection);
//   4. require the (now single) command to match a specific safe FORM — and for any program that has a
//      write/exec escape hatch (find -delete/-exec, sort -o, rg --pre, git remote add, …) validate its
//      arguments, not just its name. A first-token allowlist is NOT enough: `env rm -rf`, `find . -delete`,
//      and `rg --pre sh` all start with an "inspection" tool yet mutate/execute.
// Deny is always the safe fallback — an over-narrow allowlist only costs Codex a stall, never a mutation.

// Chaining / pipe / redirection / substitution / subshell / background / newline. Any → deny.
const DANGEROUS_META = /[;&|<>`$()\n\r]/;

// Programs with NO write/exec escape hatch under ANY arguments. (Deliberately excludes command-runners
// like env/xargs/nice/timeout, exec-capable searchers like fd/ack/rg-with---pre, and writers like
// sort -o / tee / uniq<out> / tree -o / sed-script-w/e — those are handled below or omitted entirely.)
const READONLY_ANY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'nl', 'pwd', 'echo', 'true', 'stat', 'file',
  'basename', 'dirname', 'realpath', 'readlink', 'cut', 'column', 'printenv',
  'whoami', 'uname', 'which', 'type', 'grep', 'egrep', 'fgrep',
]);

// Unwrap a single `sh -c`/`zsh -lc`/`bash -lc` wrapper. Strip matched surrounding quotes ONLY when the
// tail has no metacharacters, so a chain hidden outside the quotes (`'pytest' ; rm -rf /`) is preserved
// for the metachar check below.
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

function gitAllowed(s) {
  if (/^git\s+-/.test(s)) return false;   // no global -c/-C/--exec-path/--git-dir/--work-tree (config/hook injection, retarget)
  const sub = s.split(/\s+/)[1] || '';
  if (sub === 'remote') return /^git\s+remote(\s+(-v|--verbose|show|get-url)\b.*)?\s*$/.test(s); // read-only forms only
  if (sub === 'branch') return !/(?:^|\s)(-d|-D|-m|-M|-c|-C|-f|--delete|--move|--copy|--force|--edit-description|-u|--set-upstream-to|--unset-upstream|--create-reflog)\b/.test(s);
  if (sub === 'config') return /^git\s+config\s+--get\b/.test(s);
  return ['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse', 'cat-file', 'describe', 'blame', 'grep'].includes(sub);
}

function innerAllowed(inner) {
  const s = inner.trim();
  if (!s) return false;
  if (/^\w+=/.test(s)) return false;            // no leading env-assignment (e.g. LD_PRELOAD=… cmd)

  if (/^pytest\b/.test(s)) return true;                                          // the repo's test runner
  if (/^python3?\b/.test(s)) return /^python3?\s+(-[A-Za-z]+\s+)*-m\s+(pytest|unittest)\b/.test(s);
  if (/^(tox|nox)\b/.test(s)) return true;

  const prog = s.split(/\s+/)[0] || '';
  if (prog === 'git') return gitAllowed(s);
  if (prog === 'find') return !/(?:^|\s)-(?:delete|exec|execdir|ok|okdir|fprintf|fprint0|fprint|fls)\b/.test(s); // no delete/exec/write actions
  if (prog === 'sort') return !/(?:^|\s)(?:-o|--output)\b/.test(s);             // no write-to-file
  if (prog === 'rg')   return !/(?:^|\s)(?:--pre|--pre-glob|--hostname-bin)\b/.test(s); // no preprocessor-exec
  return READONLY_ANY.has(prog);
}

export function isSafeCommand(raw) {
  const cmd = String(raw == null ? '' : raw);
  if (!cmd.trim()) return false;
  const inner = unwrap(cmd);
  if (DANGEROUS_META.test(inner)) return false;
  return innerAllowed(inner);
}
