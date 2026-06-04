# Design — `/codex-issue` main-thread loop redesign

**Date:** 2026-06-04
**Status:** Approved direction; pending written-spec review → implementation plan.
**Scope:** `codex-claude` plugin. Fixes the bug report at
`../mathkit-codex-test/codex-claude-bug-report.md` (Findings 1–4) and realizes the goal of
automating the manual Codex-app → Claude-Code → Codex-review loop, for repos that do or do not use
the Claude Code Workflow feature.

---

## 1. Problem

`/codex-issue` (subagent mode) dispatches `codex-orchestrator` **via `Task`**, so the orchestrator
is *itself a subagent*. Claude Code allows exactly **one** level of subagent nesting and withholds
`Task`, `AskUserQuestion`, `EnterPlanMode`, and `ExitPlanMode` from subagents. Therefore:

- The orchestrator's declared `tools: …, Task` (`agents/codex-orchestrator.md:13`) is silently
  stripped at runtime — it **cannot** dispatch `codex-developer`.
- The design requires **two** nesting levels (orchestrator → developer → the repo's own QA/review
  subagents), which the platform cannot satisfy.
- The loop silently collapses to single-context self-execution, the repo's required *independent*
  QA/review gates are replaced by an inline self-grade, and the milestone report narrates a subagent
  architecture that never ran — with a fabricated "a subagent cannot dispatch a nested subagent"
  justification (Findings 1, 2, 4).
- The Claude implementation plan was a plain `cat > …` shell write, not a real Plan-mode artifact
  (Finding 3).
- The same disease exists in composition mode: `workflows/codex-wrap.js` runs each **fix round** as a
  single `agent()` that also cannot nest, so it "replays repo subagents inline" too.

A blunt corollary: the report's "just fail loud if `Task` is missing" suggestion would make subagent
mode abort on **every** run (a subagent never has `Task`). The orchestration must move out of a
subagent — it cannot be patched in place.

### Why the manual flow never hit this

When the user runs the loop by hand, **Claude Code is the main agent loop**, so it has `Task`, Plan
mode, and the user's questions available. It runs the repo's real subagent workflow faithfully. The
plugin broke fidelity by demoting Claude's development role into nested subagents.

## 2. Goal

Automate the manual flow, **fully autonomously**, working whether or not the repo's dev lifecycle is
a Claude Code Workflow:

1. Codex (Plan mode) produces a general **design plan**.
2. Claude, under read-only **plan-mode discipline**, turns it into a concrete **implementation plan**.
3. Claude **develops**, running this repo's own development instructions/workflow (including its
   subagents).
4. Codex reviews the implementation **against the plan**.
5. The findings go back to **the same Claude that developed** (it still holds the development
   context), which uses the **receiving-code-review** skill to accept/reject and fix them.
6. Repeat 4–5 until clean, then integrate (push + PR).

## 3. Platform constraints (validated)

| Constraint | Result | Confidence |
|---|---|---|
| Subagents can spawn subagents? | **No.** Max nesting depth = 1. `Task`/`Agent` is withheld from subagents. | High |
| Subagents get `AskUserQuestion`/`EnterPlanMode`/`ExitPlanMode`? | **No** (except a subagent spawned with `permissionMode:"plan"`, which is read-only). | High |
| Which tools DO subagents actually get? (**empirically verified 2026-06-04, this env**) | **`Bash`, `Read`, `Edit`, `Write`** — but **NOT** `Grep`, `Glob`, `Task`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`. A probe subagent's `Grep`/`Glob` calls hard-failed `No such tool available`; `Bash`/`Read` worked. (Docs imply `Grep`/`Glob` are available; this env strips them. The design uses `Bash` for search, so it is robust either way.) | **Verified** |
| Slash commands run in the main agent loop with their `allowed-tools`? | **Yes** — a command can drive a multi-step loop, dispatch subagents via `Task`, and use Plan mode. | High |
| `EnterPlanMode`/`ExitPlanMode` are main-thread tools; ExitPlanMode auto-approves under auto/bypass mode? | **Yes.** | High |
| A subagent can be spawned `permissionMode:"plan"` (read-only)? | **Yes**, but if the parent is in `auto`/`bypassPermissions`/`acceptEdits` the child may inherit that and plan mode is ignored — so this design does **not** rely on plan mode for read-only; the planner's `Read`-only tool set is the guarantee (§6 step 3, §8 F3). Plan mode is belt-and-suspenders. | High/Medium |
| Workflow `agent()` agents can enter Plan mode / nest `Task`? | **Unconfirmed / treat as no.** Workflow nesting is one level (`workflow()` cannot call `workflow()` again). | Medium |

**Design consequence:** anything that needs `Task`, Plan mode, or the development context (planning,
developing, fixing) must run in the **main thread**. Only the *verbose, Task-free* Codex driving may
be isolated in subagents — and those thin subagents get only `Bash`/`Read`/`Edit`/`Write`, so they
use `Bash` (`grep`/`rg`/`ls`/`find`) for any search, never the `Grep`/`Glob` tools, and the
`mode:plan` planner is `Read`-only (no `Write`/`Edit`/`Bash` — see §6 step 3).

## 4. The inversion

- **Before:** main thread → one big orchestrator *subagent* that tries to plan + develop + dispatch
  QA + review. Impossible.
- **After:** **the main thread *is* the orchestrator** (the `/codex-issue` command body + the
  `codex-claude` skill playbook). It pushes only the verbose Codex-driving down into thin Bash/Read
  subagents, and keeps Plan mode + development-with-subagents + fixing at the top — exactly mirroring
  the manual flow.

## 5. Component changes

| Component | Fate | Notes |
|---|---|---|
| `agents/codex-orchestrator.md` | **Retire** | Premise impossible; logic moves to the main-thread playbook. |
| `agents/codex-developer.md` | **Retire** | Replaced by real main-thread `Task` dispatch of the repo's own subagents. |
| `agents/codex-architect.md` | **New (thin)** | Tools: **`Bash`, `Read`** (no `Task`/`Grep`/`Glob`; uses `Bash` for any search). Runs the ephemeral `scripts/plan-round.mjs` (which writes `--out .codex/plans/issue-N.md`), returns the verbatim Codex design-plan text + status. Transcriber, not author — fails loud if Codex emits no usable plan. |
| `agents/codex-planner.md` | **New (thin, read-only)** | Tools: **`Read` only**. Spawned `mode:"plan"`. The main thread passes the issue text + design-plan text; the planner reads the named files and **returns** its concrete impl-plan text. No `Write`/`Edit`/`Bash` → read-only by construction (permission-mode-independent; §6 step 3, §8 F3). The **main thread** persists the returned text to `.codex/plans/issue-N.claude.md`. |
| `agents/codex-reviewer.md` | **Keep, adapt** | Already thin + ephemeral (`scripts/review-round.mjs`). **Drop the dead `Grep`/`Glob`** from its `tools:` (non-functional in subagents) → `tools: Bash, Read`. Adapt to take *plan text + changed files*, return structured `{verdict, reviewedFiles[], findings[]}` with the deterministic last-line `VERDICT:` parse. |
| `workflows/codex-wrap.js` | **Shrink to a noLand runner** | Delete plan / claude-plan / review / fix / land. Keep only: invoke the repo's Workflow with `noLand:true` (+ `plan`), validate `terminal:"ready_to_land"` (branch, base_sha), and the danger-landed contract check. Used **only** for Workflow-repos' bulk implementation. |
| `commands/codex-issue.md` | **Rebuild thin** | Entry: parse args → preflight → detect mode → run the main-thread loop (steps in the skill). `allowed-tools`: Task, Bash, Read, Edit, Write, Grep, Glob, Workflow, AskUserQuestion. (The main thread *does* have `Grep`/`Glob`. **No** `EnterPlanMode`/`ExitPlanMode` — step 3 uses the `mode:plan` planner subagent, per gap E.) |
| `skills/codex-claude/SKILL.md` | **Replace the orchestration section** | Document the autonomous **main-thread** playbook (below) instead of "dispatch the orchestrator." Keep the verb reference + manual loop. |
| `commands/codex-doctor.md`, `commands/codex-compose-setup.md`, `docs/WORKFLOW-MODE.md` | **Update wording** | Reflect main-thread orchestration; keep mode detection + the `noLand` seam contract. |
| `templates/implement-issue.template.js` | **Review** | The composition-ready starter; keep the `noLand` contract, align comments. |

## 6. The loop (main thread)

```
0. Preflight   codex-drive doctor; resolve plan-mode model (config or --model); confirm git state;
               gh auth on the issue/finish paths only.
1. Intake      gh issue view N (or free text); create + checkout codex/issue-N.
2. Design plan dispatch codex-architect (thin subagent, no Task) → verbatim Codex design plan,
               persisted .codex/plans/issue-N.md. Fail loud if no usable plan (no improvised plan).
3. Impl plan   dispatch codex-planner (tools: Read only) spawned mode:"plan". The main thread passes
               the issue text + design-plan text; the planner reads the named files and RETURNS its
               concrete impl-plan text (no Write/Edit/Bash → read-only by construction). The MAIN
               THREAD persists it to .codex/plans/issue-N.claude.md. Thin/empty → fall back to the
               design plan.   [F3]
4. DEVELOP     branch on mode (§7). The main thread has Task → the repo's REAL subagents run.   [F1,F2]
5. Review      dispatch codex-reviewer (thin subagent) with the DESIGN-plan text re-inlined + the
               changed files (git diff --name-only base..HEAD) → {verdict, reviewedFiles, findings}.
6. Address     SAME main thread (full dev context) invokes the receiving-code-review skill on the
               findings: verify each, fix genuine ones, push back on false positives; then re-run the
               repo's gates (main thread → Task / commands). Commit the fix delta.   [the "accept review" step]
7. Loop 5–6    until last-line == "VERDICT: NO ISSUES" (no rubber-stamp: a clean-but-substance-free
               verdict is nudged once) or max rounds (default 6) → stop without pushing.
8. Finish      (skip on --dry-run) push + gh pr create (Closes #N); resolve base; default-branch-aware
               auto-close; never auto-merge; never close the issue directly.   [F4: report what truly ran]
```

**Codex sessions are all ephemeral.** `codex-architect` and each `codex-reviewer` run their own
private, ephemeral `codex app-server` via `plan-round.mjs` / `review-round.mjs`. Continuity (the
architect "remembering" the plan at review time) is achieved by **re-inlining the persisted plan
text** into the review prompt — strictly more robust than cross-turn thread memory, and it deletes
the entire persistent-daemon lifecycle (`start`/`stop`/`wait`-timeout/`--resume`/malformed-continuity)
that dominated the old orchestrator.

## 7. Step 4 — the only branch on "Workflow or not"

- **No composable Workflow** (the bug-reported case, e.g. `mathkit`): Claude develops **directly in
  the main thread**, discovering and running the repo's `CLAUDE.md`/`AGENTS.md` workflow and
  **dispatching its real QA/code-reviewer subagents via `Task`**. This is the manual flow, automated.
- **Has a composable Workflow** (`.claude/workflows/*.js` that reads `args.noLand`): the main thread
  invokes the repo's Workflow (`noLand:true`, `plan:implPlan`) via the shrunk `codex-wrap.js` as the
  **bulk-implementation engine** — native, all gates intact — and validates `ready_to_land`.

**Fixes always run in the main thread (§6 step 6), which always has `Task`** — even for Workflow
repos. A fix dispatches the repo's real gate subagents/commands directly; we never re-run the whole
deterministic Workflow per fix, and we never fall back to "inline replay." The Workflow tool is used
**only** for the deterministic bulk build; the main thread is the universal high-fidelity bridge for
planning, reviewing, and fixing. Mode detection (and the unmodified-scaffold tripwire, tracked-ness,
non-composable-Workflow nudge to `/codex-compose-setup`) is preserved from today's `codex-issue.md`.

## 8. How each finding is closed

- **F1 (no `Task`)** — orchestration runs in the main thread, which has `Task`; the only subagents
  (`codex-architect`, `codex-reviewer`, the `mode:plan` planner) need no `Task`.
- **F2 (loop collapse / lost independence)** — the repo's own QA/review subagents are dispatched for
  real, in both modes, including during fixes.
- **F3 (plan not in Plan mode)** — step 3 runs in a `mode:"plan"` subagent whose tool set is `Read`
  only (no `Write`/`Edit`/`Bash`), so read-only is guaranteed **by construction** regardless of
  parent permission-mode inheritance; the main thread persists the returned text. Plan mode is
  belt-and-suspenders, not the primary control.
- **F4 (fabricated report)** — no orchestrator subagent narrating an imagined architecture. The main
  thread reports what it actually did; a thin Codex-driver subagent makes no dispatches it could lie
  about. The report names the real dev path (direct main-thread vs repo-Workflow) and the real gates.

## 9. Testing

- **Unit (Node, existing harness):** the shrunk `codex-wrap.js` noLand-runner — `ready_to_land`
  validation and the danger-landed check (mock repo workflow returning each terminal). Keep
  `plan-output`, `safe-command`, daemon, verbs tests green; drop tests asserting the retired
  orchestrator/composition-loop behavior, add tests for the noLand-runner contract.
- **Agent contracts:** `codex-architect` returns `{status, planText, planPath}`; `codex-planner`
  (`mode:plan`, `Read`-only) returns the impl-plan text; `codex-reviewer` returns
  `{verdict, reviewedFiles, findings}` with last-line verdict parsing.
- **Subagent tool grant:** empirically verified 2026-06-04 (`Bash`/`Read`/`Edit`/`Write` granted;
  `Grep`/`Glob`/`Task` not) — re-probe if the Claude Code version changes, since this contradicts the
  general docs and may be environment-specific.
- **End-to-end (manual, on `mathkit-codex-test`):** re-run the reported scenario (`/codex-issue 9`,
  no `.claude/workflows/`). Assert: the repo's *independent* QA subagent actually runs (visible
  dispatch), the Claude impl plan exists as a plan-mode artifact, the final report names the real
  path, and the PR/issue behavior is unchanged.

## 10. Risks & open items

- **Main-context cost (the genuine price of correctness):** the dominant cost is **development
  output**, not instruction tokens — running the repo's dev loop where the main thread codes directly
  dumps that work into the live context, and it is **largely irreducible**: you cannot both isolate
  development and let it dispatch real subagents (isolation is exactly what removes `Task`). It is
  *partly* bounded by repo shape — where the repo's lifecycle is itself a Workflow (runs in the
  background) or itself dispatches subagents (which return only summaries), that output is isolated;
  only the main thread's own direct edits are unavoidably in-context. The skill-loading trick trims
  *instruction* tokens, not this. This is the right price for fidelity; name it, don't hide it.
- **`mode:plan` parent-inheritance is NOT load-bearing:** the planner is `Read`-only (no
  `Write`/`Edit`/`Bash`), so read-only holds even if an `auto`/`bypass`/`acceptEdits` parent causes
  plan mode to be ignored. Plan mode is secondary.
- **Permission mode for unattended runs:** main-thread development edits + push need a non-blocking
  posture; document that fully-unattended runs use auto/bypass mode.
- **Workflow-repo fix fidelity (determinism vs independence):** for Workflow-repos the bulk build is
  deterministic (the Workflow's coded gate sequence/retry), but fixes route through the main thread —
  preserving gate **independence** (real subagents) while losing the Workflow's **determinism**
  (ad-hoc dispatch ≠ its coded sequence). Right trade for a small fix delta; the final report **must
  state which path each gate took** (native command / repo-subagent dispatch / repo Workflow).
- **Subagent tool grant (verified, not assumed):** thin subagents get `Bash`/`Read`/`Edit`/`Write`
  but not `Grep`/`Glob`/`Task` in this env (§3) — agent prompts use `Bash` for search; the design
  never relies on `Grep`/`Glob` inside a subagent.
- **`codex` vs `codex-claude` plugins:** unchanged coexistence.

## 11. Out of scope

- Changing the `codex-drive` JSON-RPC protocol or the ephemeral drivers' internals.
- The separate `codex` plugin (rescue/setup).
- Multi-issue / parallel-issue orchestration.

## 12. Review log

**2026-06-04 — Codex review of this spec, accepted via `receiving-code-review`:**

- **A (verify subagent tool grant):** done **empirically** — a probe subagent's `Grep`/`Glob` calls
  hard-failed `No such tool available`; `Bash`/`Read`/`Edit`/`Write` work; `Task` absent. Confirmed
  the bug report's hunch (not imprecise self-reporting). Thin agents now use `Bash` for search (§3,§5).
- **B (Write can't be path-restricted by `tools:`):** resolved better than a permission rule — the
  planner has **no `Write`**; it returns text, the main thread persists it (§5,§6 step 3).
- **C (plan-mode read-only is Medium-confidence):** read-only now rests on the planner's `Read`-only
  tool set, not plan mode (§3,§8). 
- **D (main-context mitigation mis-aimed):** §10 rewritten — the irreducible cost is development
  output, only bounded by repo shape.
- **E (`EnterPlanMode`/`ExitPlanMode` unused):** dropped from the command's `allowed-tools` (§5).
- **F (Workflow-repo fix trade):** §7/§10 sharpened — determinism-vs-independence; report states each
  gate's path.
