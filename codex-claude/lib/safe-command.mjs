// Allowlist gate for the ephemeral plan/review drivers. Codex refuses to architect or review without
// running the repo's tests to verify; the drivers therefore APPROVE a tight set of safe, read-only-ish
// commands (the test runner + inspection) so Codex can verify, and DENY everything else. Shared by
// plan-round.mjs and review-round.mjs so the security boundary can't drift between them.
//
// Conservative by design: deny is always the safe fallback (the worst case of an over-narrow allowlist
// is that Codex stalls and the driver fails loud, never a mutation). The denylist is checked FIRST so a
// command that both matches a safe token and a dangerous one (e.g. "pytest && rm -rf x") is denied.

const DENY = [
  /\b(rm|mv|cp|chmod|chown|chgrp|ln|kill|killall|sudo|su|dd|mkfifo|truncate|tee|shred)\b/i,
  /\b(pip|pip3|npm|npx|yarn|pnpm|cargo|gem|go\s+install|apt|apt-get|brew|conda|uv)\b/i,
  /\b(curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|ftp|telnet)\b/i,
  /\bgit\s+(push|commit|add|reset|checkout|switch|merge|rebase|clean|stash|tag|apply|am|cherry-pick|restore|rm|mv)\b/i,
  />>?\s*\S/,            // output redirection to a file (writes)
  /\b(set|export)\s+\w+=/, // env mutation that could re-point tools
];

const ALLOW = [
  /\bpytest\b/,                                  // the repo's verification command
  /\bpython3?\b[^\n]*\b-m\s+(pytest|unittest)\b/, // python -m pytest / unittest
  /\b(tox|nox)\b/,
  // read-only inspection
  /\bgit\s+(status|diff|log|show|ls-files|rev-parse|branch|cat-file|describe|blame|grep|remote)\b/,
  /\b(ls|cat|head|tail|wc|nl|rg|grep|egrep|fgrep|ack|find|fd|tree|pwd|echo|true|stat|file|basename|dirname|realpath|readlink|sort|uniq|comm|cut|column|env|printenv|date|whoami|uname|which)\b/,
  /\b(command\s+-v|type)\b/,
  /\bsed\s+-n\b/,                                // sed in print-only mode
];

export function isSafeCommand(raw) {
  const cmd = String(raw == null ? '' : raw);
  if (!cmd.trim()) return false;
  if (DENY.some((re) => re.test(cmd))) return false;
  return ALLOW.some((re) => re.test(cmd));
}
