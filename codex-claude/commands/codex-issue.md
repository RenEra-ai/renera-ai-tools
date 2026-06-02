---
name: codex-issue
description: >-
  Run the full autonomous Codex-architect loop for a GitHub issue or free-text task. For repos whose
  dev workflow is a Claude Code Workflow that supports the composition contract (a `noLand` arg), it
  COMPOSES: Codex architect plan → the repo's own workflow (full pipeline, land suppressed) → Codex
  architect review → land. Otherwise it falls back to subagent mode (a black-box developer that
  discovers + runs the repo's workflow). Codex plans/reviews; the repo implements; push + PR (the
  issue closes on a default-branch merge). Add --dry-run to stop before push/PR.
argument-hint: "<issue number | free-text task> [--dry-run] [--base <branch>]"
allowed-tools:
  - Task
  - Bash
  - Read
  - Workflow
  - AskUserQuestion
---

Run the autonomous Codex-architect loop for:

> $ARGUMENTS

Parse `$ARGUMENTS`: the leading token is the GitHub issue number (if numeric) or the free-text task;
honor `--dry-run` and `--base <branch>`.

## Step 1 — detect the repo's integration mode

Check whether this repo's dev workflow is a Claude Code **Workflow** that supports the codex-claude
**composition contract** (an `args.noLand` branch that runs the full pipeline but returns before
landing):

```bash
grep -l "noLand" .claude/workflows/*.js 2>/dev/null   # composable workflow(s), if any
```

- A match **and** the task is a **numeric issue** → **workflow-mode composition** (Step 2A). If
  multiple files match, pick the one that defines an issue-implementation pipeline (or the first) and
  state which you chose. (The detector is a heuristic gate — the wrapper hard-validates the contract by
  requiring the repo workflow to return `terminal: "ready_to_land"`.)
- Otherwise → **subagent mode** (Step 2B — the default for repos without a composable Workflow).

## Step 2A — workflow-mode composition (runs the repo's REAL pipeline, bracketed by Codex)

This composes: Codex architect plan → the repo's own workflow with **land suppressed** (its full
pipeline, all gates intact) → Codex architect review→fix loop → land (push + PR). It runs the repo's
genuine lifecycle instead of a subagent approximation, but it executes the full pipeline and — unless
`--dry-run` — pushes and opens a PR. **Get approval first:**

- Use **AskUserQuestion**: "Detected a composable repo workflow (`<matched path>`). Run the
  composition — Codex architect plan → that workflow (land suppressed) → architect review → push + PR?"
  Options: **Run composition** · **Use subagent mode instead** · **Cancel**.
- On **Run composition**, invoke the **Workflow** tool (resolve `${CLAUDE_PLUGIN_ROOT}` to its real path):
  `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/codex-wrap.js", args: { issue: <N>, repoWorkflowPath: "<absolute path to the matched .claude/workflows/*.js>", pluginRoot: "${CLAUDE_PLUGIN_ROOT}", base: "<--base value or empty>", dryRun: <true|false> } })`.
  It runs in the background; when it completes, relay its result: status, branch, PR URL, review
  rounds, and whether the issue will auto-close (default base) or needs a manual close (non-default base).
- On **Use subagent mode instead** → Step 2B. On **Cancel** → stop and report nothing was changed.

## Step 2B — subagent mode (default)

Dispatch the **codex-orchestrator** subagent (Task) with the task and the flags. It owns the loop:
architect plan → approval → a black-box `codex-developer` that discovers and runs THIS repo's own
workflow → architect review-until-clean → push/PR. When it returns, relay its milestone report.

---

In **both** modes the loop never auto-merges and never closes the issue itself — the PR's `Closes #N`
closes it on a **default-branch** merge; a non-default base (e.g. `dev`) is flagged for manual close.
Do not drive `codex-drive` yourself — the workflow/orchestrator does that.
