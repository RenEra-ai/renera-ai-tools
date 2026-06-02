---
name: codex-issue
description: >-
  Run the full autonomous Codex-architect loop end-to-end for a GitHub issue or a free-text task:
  Codex plans → orchestrator approves → a black-box developer implements it via the repo's own full
  internal workflow → Codex reviews until clean → push + open PR (the issue closes on merge via
  Closes #N). Dispatches the codex-orchestrator subagent. Add --dry-run to stop before push/PR.
argument-hint: "<issue number | free-text task> [--dry-run] [--base <branch>]"
allowed-tools:
  - Task
  - Bash
---

Run the fully automated Codex-architect loop for:

> $ARGUMENTS

This is **autonomous and ends in irreversible actions** (git push and PR creation) unless `--dry-run`
is passed. The issue is **not** closed directly — the PR's `Closes #N` closes it on merge. Proceed:

1. Parse `$ARGUMENTS`: the leading token/phrase is the GitHub issue number (if numeric) or the
   free-text task; honor any `--dry-run` and `--base <branch>` flags.
2. Dispatch the **codex-orchestrator** subagent (Task tool) with that task and the flags. It owns the
   entire loop — architect plan, plan approval, black-box implementation, architect review-until-clean,
   and the push/PR finish (the issue closes on merge) — and isolates the verbose codex-drive wait-loop
   from this thread.
3. When it returns, surface its milestone report to me: the approved plan, the architect Q&A it
   auto-answered (with rationale), the number of review rounds, and the final outcome (PR URL + issue
   status, or — if it stopped early — exactly why and the current branch state).

Do not drive `codex-drive` yourself here — the orchestrator does that. Just dispatch and relay.
