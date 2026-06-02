---
name: codex-doctor
description: >-
  Preflight which fidelity tier /codex-issue will use for THIS repo and whether the composition seam is
  intact, before spending a real run. Reports: the resolved mode (workflow-composition vs subagent) and
  WHY, the matched noLand workflow + a static seam check, the resolved PR base / default branch and
  whether the issue will auto-close, and the Codex daemon health (version/auth). Read-only.
argument-hint: ""
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

Produce a **read-only** preflight report for the current repo. Make no changes. Run the checks below and
present the findings as a short report.

## 1. Codex daemon health

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs doctor
```

Report `codexVersion` / `authPresent`. If `codexVersion` is null → Codex CLI not installed; if
`authPresent` is false → not logged in (`codex login`). Either makes the architect steps unrunnable.

## 2. Resolved mode (workflow-composition vs subagent) and why

```bash
ls .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null            # any Workflow at all?
grep -l "noLand" .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null   # composition-ready one(s)
```

- **A file reads `noLand`** → for a **numeric issue**, `/codex-issue` will use **workflow-mode
  composition** (the repo's real pipeline, bracketed by the architect). Name the matched file.
- **A workflow exists but none reads `noLand`** → `/codex-issue` will use **subagent mode** and should
  nudge `/codex-compose-setup`. Say so — composition would be higher fidelity here.
- **No workflow** → **subagent mode** (the black-box developer discovers + runs the repo's prose
  lifecycle). Note that a repo-defined *subagent* review gate will be **replayed inline** (subagents
  can't dispatch subagents), and a live credential-gated gate will fail-closed **BLOCKED**.

## 3. Seam integrity (only if a composable workflow was matched)

Open the matched file and statically confirm the composition contract — report PASS/CONCERN for each:
- It **reads** `args.noLand` (not just a comment mention): `grep -n "noLand" <file>`.
- Under `noLand`, it **returns** `terminal: 'ready_to_land'` with `branch` and `base_sha` (the wrapper
  hard-validates these): `grep -n "ready_to_land\|base_sha\|branch" <file>`.
- (Optional, deeper) a `dryRun` invocation confirms the script parses + preflights but does NOT
  exercise the `noLand` return: a composition-ready workflow returns its **dry-run terminal** (e.g.
  `dry_run_ok`) because most workflows short-circuit `dryRun` before reaching the `noLand` seam. So a
  true seam exercise needs a **non-dry** `noLand` run; treat a clean dry run only as "parses +
  preflights OK", and rely on the static `noLand`/`ready_to_land` check above for seam integrity.

## 4. Base / auto-close prediction

```bash
DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null)
git ls-remote --heads origin dev | grep -q . && echo "origin/dev exists" || echo "no origin/dev"
```

The loop resolves BASE as `dev` if `origin/dev` exists, else `$DEFAULT`. Report the resolved BASE and
the default branch, and predict auto-close: `Closes #N` fires **only** on a merge into the **default**
branch — so if BASE ≠ default, the issue will **not** auto-close and needs a manual close.

## Report

Summarize: **mode** (+ why), **seam** (intact / not composition-ready → run `/codex-compose-setup`),
**base + auto-close**, **Codex health**. Keep it to a few lines. Change nothing.
