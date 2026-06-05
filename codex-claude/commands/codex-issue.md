---
name: codex-issue
description: >-
  Run the autonomous Codex-architect ↔ Claude loop for a GitHub issue or free-text task, IN THE MAIN
  THREAD (so it can run this repo's real development workflow, including its subagents). Codex
  architects a design plan → Claude (read-only) writes its own implementation plan → Claude develops
  here, running the repo's own workflow → Codex reviews impl-vs-plan → Claude addresses findings via
  receiving-code-review → push + PR. For repos whose lifecycle is a composable Claude Code Workflow,
  development runs that workflow (noLand) as the engine. Add --dry-run to stop before push/PR.
argument-hint: "<issue number | free-text task> [--dry-run] [--base <branch>]"
allowed-tools:
  - Task
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Workflow
  - AskUserQuestion
---

Run the autonomous Codex-architect ↔ Claude loop for:

> $ARGUMENTS

You run this loop **yourself, in the main thread** — you have `Task`, so the repo's own subagents run
for real (unlike a nested-subagent design, which cannot dispatch them). Parse `$ARGUMENTS`: the
leading token is the GitHub issue number (if numeric) or the free-text task; honor `--dry-run` and
`--base <branch>`. Define the CLI once:

```bash
CDX="node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs"
```

This is **fully autonomous**: you make the judgment calls (answering ambiguity from the issue/code,
approving the implementation plan, deciding when a review is clean) — the only brakes are `--dry-run`
(stop before push/PR) and **max review rounds** (default 6 → stop before push, report state; never
push an un-clean change). `gh` (authenticated) is required for issue intake and the finish.

Follow the **codex-claude** skill for the exact `codex-drive` verb contract used by the helper agents.

## 0. Preflight

- `$CDX doctor`. If `codexVersion` is null or `authPresent` is false → **abort** (Codex not installed /
  not logged in).
- Confirm a Plan-mode model is configured (the architect's driver reads it from `~/.codex/config.toml`):
  ```bash
  CONFIG_MODEL=$(node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/config.mjs').then(m=>process.stdout.write(m.readConfiguredModel()||''),()=>{})" 2>/dev/null)
  ```
  If `$CONFIG_MODEL` is empty → **abort**: "Plan mode needs a model — set `model = \"…\"` in
  ~/.codex/config.toml."
- Record the starting commit: `START=$(git rev-parse HEAD)`. Require `gh auth status` only on the
  paths that need it: a numeric issue (for `gh issue view`) or a non-`--dry-run` run (the finish
  pushes + opens a PR). A free-text `--dry-run` needs no `gh`.

## 1. Intake

- Numeric → `gh issue view <#> --json number,title,body`. Free text → use as-is.
- Create + checkout the working branch: `codex/issue-<#>` (or `codex/<short-slug>`).

## 2. Detect the repo's development mode (state which branch you take — never silent)

Scan for a composable Claude Code **Workflow** that the dev step can run as an engine:

```bash
ls .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null
grep -l "noLand" .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null
grep -l "codex-claude:generic-scaffold" .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null
git ls-files --error-unmatch <matched-file> 2>/dev/null && echo tracked || echo UNTRACKED
```

Decide and **say which branch you took**:
- A file that actually **reads** `args.noLand` in code (open it and confirm — a bare comment mention
  doesn't qualify) **and** a numeric issue → **Workflow-engine mode** (§5 develops via that workflow).
  Surface, so the substitution is never silent: a **faithfulness banner** naming the workflow's own
  `meta.phases` (which may differ from your `CLAUDE.md`/`AGENTS.md` prose) and whether the file is
  **git-tracked** (untracked → reproducibility risk: a `git clean`/fresh clone flips it to main-thread
  mode). **Unmodified-scaffold tripwire:** if the matched file still contains
  `codex-claude:generic-scaffold`, it is the untouched generic starter that runs **no** real gates —
  warn loudly and prefer main-thread mode (or fixing the scaffold first).
- A workflow exists but none reads `noLand` (or a free-text task) → say so and nudge:
  "This repo has `.claude/workflows/<file>` but it's not composition-ready (no `noLand` seam) — run
  **`/codex-compose-setup`** for the higher-fidelity engine. Proceeding in **main-thread mode**."
- No composable workflow → **main-thread mode**. Say: "No composable workflow detected — main-thread mode."

## 3. Architect design plan (Codex, read-only)

Dispatch the **codex-architect** subagent (Task) with the issue/task text and instruct it to save to
`--out .codex/plans/issue-<#>.md` (a slug for free-text). Parse its **first line**: `STATUS: DONE` →
hold the absolute path it returns as `$PLAN_PATH` and **Read** the plan body from it as `$DESIGN` (the
reviewer in §6 receives `$PLAN_PATH`; `$DESIGN` feeds the §4 planner). `STATUS: FAILED` → **abort** (no
usable architect plan — fail loud; do not improvise one).

## 4. Claude implementation plan (read-only, plan-mode)

Dispatch the **codex-planner** subagent **with `mode: "plan"`** (Task), passing the issue text and
`$DESIGN`. Its returned message is Claude's own file-by-file implementation plan. If it is exactly
`STATUS: THIN` (or is < 80 chars / has no file or step), set `$IMPL = $DESIGN`; otherwise `$IMPL` =
its returned markdown. **You (main thread) persist** `$IMPL` with Write to
`.codex/plans/issue-<#>.claude.md`. (The planner is read-only — it returns text; you save it.)

## 5. Develop — branch on mode

**Main-thread mode:** implement `$IMPL` **yourself, here**. First DISCOVER this repo's own development
workflow — read `CLAUDE.md`, `AGENTS.md`, `.claude/` process docs / commands / agents — then RUN it
as-is, however many internal steps it has, **dispatching its real QA / code-reviewer / tester
subagents via `Task`** (you can — you are the main thread). Run its **review/QA gates**, not just its
tests — and a gate counts **whether it's a dispatched subagent OR a command the repo names** (e.g. a
`CLAUDE.md` step that runs an independent Codex review via `codex-companion … review`): run that one
too, with the **exact tool the repo specifies**. **The repo's own Codex/AI review gate MUST run here**;
the §6 architect-vs-plan review is **additive and does NOT "stand in for" it** — different goals (the
repo's gate judges the code, §6 judges impl-vs-plan), so never drop the repo's own review just because
§6 also calls Codex. Commit on the branch as the repo's workflow dictates, but **stop before any landing step**
(no push / PR / close — you own integration in §8). A **required** gate that cannot run (missing
credentials/live QA/network) is a **fail-closed block** → stop and report; never land a change whose
required gate was skipped.

**Workflow-engine mode:** run the repo's deterministic workflow as the development engine via the wrapper:
```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/codex-wrap.js",
  args: { issue: <#>, repoWorkflowPath: "<abs path to the matched .claude/workflows file>",
          plan: "<$IMPL>", base: "<--base value or empty>" } })
```
It runs in the background; on completion branch on its `status`: `ready` → record `branch` + `base_sha`
(use `base_sha` as the review base below); `danger_landed` → **abort** with its danger message (the
repo landed despite `noLand` — the review was bypassed; manual inspection needed); `failed` → **abort**
with its `detail`.

## 6. Architect review (Codex, against the design plan)

This review is **additive** — it does **not** replace or "stand in for" any Codex/AI review gate the
repo's own workflow already ran in §5 (two reviews, two goals — by design, not redundant: the repo's
gate judges the code on its own merits; this one judges the implementation against the **architect's
design plan**). If the repo defines its own Codex review, **both** run — never collapse them into one.

Compute the changed files: `git diff --name-only <START | base_sha>..HEAD` (use `base_sha` in
Workflow-engine mode, `$START` in main-thread mode). Dispatch the **codex-reviewer** subagent (Task)
with the **plan file path `$PLAN_PATH`** (`.codex/plans/issue-<#>.md`) — **NOT** the plan prose — and
the changed-file list; the reviewer hands `$PLAN_PATH` to its driver, which inlines the plan
**verbatim**. You **MUST NOT** summarize, compress, drop sections from, reorder, or re-author the plan
when handing it off — doing so lets a load-bearing constraint silently vanish before the review ever
sees it. You **MAY** additionally pass the issue's acceptance criteria, but only as a **separate,
clearly-labeled** block — never in place of, or merged into, the verbatim plan. Read its **last line**:
clean **only** when it is exactly `VERDICT: NO ISSUES`. A clean verdict
with **no** `Reviewed files:` line and no findings is a thin signal → dispatch the reviewer once more
asking it to list the files it reviewed first; if still substance-free, accept clean. `VERDICT: ISSUES
FOUND` / `VERDICT: UNCLEAR` with findings → §7.

## 7. Address findings (you, with full development context)

Invoke the **receiving-code-review** skill on the reviewer's findings: verify each against the code,
fix only genuinely-wrong things, and **push back (in your report) on false positives** with technical
reasoning — do not implement blindly. Then **re-run this repo's own review/QA gates on the fix**:
- main-thread mode → dispatch the repo's gate subagents (Task) / run its gate commands as in §5,
  **including re-running the repo's own Codex/AI review gate on the fix delta with the exact tool the
  repo names — §6 never substitutes for it on any round** (many repos require their own Codex gate on
  every fix round, scoped to the delta);
- Workflow-engine mode → re-run the repo's **discoverable** gate commands on the fix delta (you have
  `Task` + `Bash`), since a full re-run of the deterministic Workflow per fix is unnecessary. **State
  in the final report which path each gate took** (native command / dispatched repo subagent) — fixes
  trade the Workflow's determinism for gate independence; that's intended for a small fix delta.

Commit the fix delta (no landing). Increment the round counter; return to §6 **scoped to the fix
delta** (tell the reviewer to review only the newly changed files). Stop when clean, or at the max
(default 6) → do **not** push; report the outstanding findings and current state.

## 8. Finish — integrate (skip entirely if `--dry-run`)

- **Pre-finish landing guard.** `git ls-remote --heads origin <branch>` must be **empty** and, for a
  numeric issue, `gh issue view <#> --json state` must still be **OPEN**. If the branch is already
  pushed or the issue already closed → the developer landed prematurely → **do not push/re-PR**;
  abort with `DANGER: landed before review — manual inspection needed` and the current state.
- Ensure everything is committed. Resolve the default branch and base (a **bare** name, never
  `origin/…`): `$DEFAULT = gh repo view --json defaultBranchRef -q .defaultBranchRef.name`; `$BASE` =
  `--base` if given, else `dev` if it exists **on the remote** (`git ls-remote --heads origin dev | grep -q .`),
  else `$DEFAULT`. Record whether `$BASE == $DEFAULT`.
- `git push -u origin <branch>`.
- Set `$PLAN_SUMMARY` to a 1–2 sentence summary of what shipped (derive it from `$IMPL`). Build the
  PR body with **real newlines**:
  ```bash
  BODY=$(printf 'Closes #%s\n\n%s\n\nArchitect review: clean after %s round(s).' "$NUM" "$PLAN_SUMMARY" "$K")
  gh pr create --base "$BASE" --head "$BRANCH" --title "<issue title or task>" --body "$BODY"
  ```
  (Drop the `Closes #N` line for a free-text task with no issue.) Capture the PR URL.
- **Never auto-merge; never close the issue directly.** `Closes #N` auto-closes only on a merge into
  the **default branch**: `$BASE == $DEFAULT` → leave it (the merge closes it); `$BASE != $DEFAULT`
  (e.g. `dev`) → it will **not** auto-close — leave it OPEN and **flag a manual close** in the report.

## Final report (report what ACTUALLY happened — never narrate an intended architecture)

- **Issue/task** and branch; the two plan artifacts (`.codex/plans/issue-<#>.md` and `…claude.md`).
- **Which development path ran** — main-thread (you ran the repo's workflow) or Workflow-engine (the
  repo Workflow) — and **which gates ran how**: a native command vs a **dispatched repo subagent**
  (name it). This is the fidelity record: the human can see the repo's real lifecycle executed.
- **Architect Q&A** you auto-answered (via the helper agents) with rationale; any findings you pushed
  back on and why.
- **Rounds**: how many review rounds and the final verdict.
- **Outcome**: PR URL + whether the issue **auto-closes** (`$BASE == $DEFAULT`) or **needs a manual
  close**. Or — if you stopped early — exactly why and the current state (branch, commits, outstanding
  findings). Be honest about anything you could not get clean or any gate that could not run.

In both modes the loop never auto-merges and never closes the issue itself. Do not drive `codex-drive`
yourself for the plan/review turns — the `codex-architect` / `codex-reviewer` subagents do that, and
isolate their verbose wait-loops from this conversation.
