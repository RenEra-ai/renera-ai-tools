---
name: codex-review
description: >-
  Get an independent Codex (GPT-5.x) review of the current changes. Dispatches the codex-impl-reviewer
  subagent, which drives a read-only Codex review on its own isolated session and returns just the
  findings — keeping the verbose wait-loop out of this conversation.
argument-hint: "[files/scope to review — defaults to the current uncommitted diff]"
allowed-tools:
  - Task
  - Bash
  - Read
---

Get an independent Codex review of:

> $ARGUMENTS

If no scope was given above, default to the current **uncommitted diff** (run `git status` /
`git diff --stat` to see what changed; if this isn't a git repo, ask me what to review).

Dispatch the **codex-impl-reviewer** subagent (via the Task tool) with a precise brief: the files/scope
to review and what to look for (correctness bugs, missing edge cases, contract mismatches). The
subagent runs the Codex review in isolation and returns a structured findings list.

When it returns:
- Present the findings to me grouped by severity, each with `file:line` and a concrete fix.
- If it reports **no issues**, say so plainly.
- Do **not** auto-apply fixes unless I ask — surface them first.
