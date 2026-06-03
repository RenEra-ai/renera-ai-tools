// Auto-approval gate for the ephemeral plan/review drivers. Codex needs exactly ONE thing it cannot do
// through its native file-reading tools: RUN THE REPO'S TEST SUITE to verify. So this gate auto-approves
// ONLY the test runner and DENIES everything else (git, find, cat, rg, …). Inspection commands are not
// needed here — Codex reads files via its own read tools, which never hit command approval.
//
// Arguments are parsed with a real tokenizer (quotes + backslashes), not regex on the raw string, so a
// quoted/escaped flag (`pytest "--basetemp=/x"`) can't smuggle past validation. Even the test runner has
// destructive options, so its args are validated: no write/delete/config-redirect/plugin-exec options
// and no path that escapes the working tree (absolute, `~`, or `..`). Defence in depth: we still unwrap
// one `sh -c` layer, reject shell metacharacters, and reject env-assignment prefixes. Deny is always safe.

// Chaining / pipe / redirection / command-or-var substitution / subshell / background / newline.
const DANGEROUS_META = /[;&|<>`$()\n\r]/;

// pytest options that write, delete, redirect config, or load/exec code — never auto-approve.
const PYTEST_BAD_OPT = /^(--basetemp|--junitxml|--junit-xml|--report-log|--result-log|--resultlog|-o|--override-ini|-c|--config-file|--rootdir|--pdbcls)(=|$)/;

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

// Split a metacharacter-free command into argv: unquote '…'/"…", honor backslash escapes, split on
// unquoted whitespace — so validation sees the SAME argv the program will, not the quoted source.
function tokenize(s) {
  const out = [];
  let cur = '', q = null, started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === '\\' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; started = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[++i]; started = true; continue; }
    if (/\s/.test(c)) { if (started) { out.push(cur); cur = ''; started = false; } continue; }
    cur += c; started = true;
  }
  if (started) out.push(cur);
  return out;
}

// A path token that escapes the working tree: absolute, home-relative, or parent traversal — checked on
// both the whole token and its post-`=` value (so `--x=/abs` is caught).
function isPathEscape(tok) {
  const v = tok.includes('=') ? tok.slice(tok.indexOf('=') + 1) : tok;
  const bad = (t) => /^\//.test(t) || /^~/.test(t) || /(^|\/)\.\.(\/|$)/.test(t);
  return bad(tok) || bad(v);
}

function pytestArgsOk(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PYTEST_BAD_OPT.test(a)) return false;
    if (a === '-p') { if (!/^no:/.test(args[++i] || '')) return false; continue; }        // -p VALUE
    if (/^-p./.test(a)) { if (!/^no:/.test(a.replace(/^-p=?/, ''))) return false; continue; } // -pVALUE
    if (isPathEscape(a)) return false;
  }
  return true;
}

export function isSafeCommand(raw) {
  const cmd = String(raw == null ? '' : raw);
  if (!cmd.trim()) return false;
  const inner = unwrap(cmd);
  if (DANGEROUS_META.test(inner)) return false;       // no chaining / redirect / substitution
  const argv = tokenize(inner);
  if (!argv.length || /^\w+=/.test(argv[0])) return false; // no env-assignment prefix (LD_PRELOAD/PYTHONPATH)
  const prog = argv[0];

  if (prog === 'pytest') return pytestArgsOk(argv.slice(1));
  // NOTE: tox/nox are deliberately NOT auto-approved — they run arbitrary repo-defined sessions
  // (`nox -s deploy`, `tox -e clean`), not just tests, so they're not a safe blanket approval.
  if (prog === 'python' || prog === 'python3') {
    const mi = argv.indexOf('-m');
    if (mi < 1) return false;                          // must be `-m <module>`, never `-c <code>`
    for (let i = 1; i < mi; i++) if (!/^-[A-Za-bd-z]+$/.test(argv[i])) return false; // interpreter flags only, no -c
    const mod = argv[mi + 1];
    if (mod !== 'pytest' && mod !== 'unittest') return false;
    const rest = argv.slice(mi + 2);
    return mod === 'pytest' ? pytestArgsOk(rest) : rest.every((a) => !isPathEscape(a));
  }
  return false;
}
