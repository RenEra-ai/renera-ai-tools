# Workflow-mode composition contract

Some repos implement their development lifecycle as a **Claude Code Workflow** — a deterministic
`.claude/workflows/*.js` or `.mjs` script (developer → reviewer loops, QA, internal Codex review, land), invoked
via the Workflow tool or a slash command.

A plugin **subagent cannot run such a Workflow**: the Workflow tool is a session-level capability, not
a grantable subagent tool, and subagents can't invoke slash commands. So a subagent-based approach can
only *approximate* a Workflow-mode repo's pipeline by replaying its steps — losing the gates
baked into the JS (loop caps, scope confinement, verdict classification).

**Composition** solves this. The `/codex-issue` command runs the loop in the **main thread**, where the
Workflow tool *is* available. For a composable workflow, the main thread uses the repo's Workflow as the
**development engine** — running it with `noLand:true` so it executes its full pipeline (all gates
intact) without landing — while the main thread owns the architect plan, Claude plan, review, fix, and
land:

```
[main thread] architect plan → Claude plan → workflow(repo, { noLand:true, plan }) → review → fix → re-review → land
                                              └── the repo's REAL pipeline, all gates intact ──┘
```

Codex (the architect) sets the **intent**; Claude then authors its **own** file-by-file implementation
plan from it; the repo's developer implements **Claude's** plan; the architect review judges the result
against the **architect** plan (so Codex stays the intent authority). Both plans are persisted under
`.codex/plans/` (`issue-<N>.md` = architect, `issue-<N>.claude.md` = Claude) as durable, reviewable
artifacts — untracked, so they never enter the issue commit/PR.

## The contract (what a repo's workflow must support)

To be composable, the repo's `.claude/workflows/*.js` or `.mjs` file must accept:

| arg | required | behavior |
|---|---|---|
| `args.issue` | yes | the issue to implement (already the norm). |
| `args.noLand` | **yes** | run the full pipeline (implement + all internal reviews/QA) but **return before landing** — no squash, push, PR, or issue-close. Leave the implemented + reviewed commits on the branch. Return `{ terminal: "ready_to_land", branch, base_sha, ready: true }`. |
| `args.plan` | optional | an architect plan (string) to guide implementation; inject it into the implement step. Ignore if unsupported. |

The plugin uses `grep noLand` only to discover candidates. `/codex-issue` treats a workflow as
composable only after opening the candidate and confirming it actually reads `args.noLand` (or
destructures `noLand` from `args`) in code, not only in comments/strings. The no-land branch must return
`terminal: "ready_to_land"` with `branch` and `base_sha`; otherwise `/codex-issue` falls back to
**subagent mode** and nudges `/codex-compose-setup`.

## Making a repo composable — `/codex-compose-setup`

Run **`/codex-compose-setup`** in a repo to arrange the contract automatically instead of editing by
hand:
- An existing `.claude/workflows/*.js` or `.mjs` → it adds the `noLand` seam **in place** (gate `land()` → return
  `ready_to_land`), shown as a diff for your approval.
- No workflow → it scaffolds a minimal, composition-ready starter from
  `templates/implement-issue.template.js` (implement → discover-and-run the repo's tests → land,
  already `noLand`-aware).

(Plugin *install* can't do this — a plugin is global and never runs inside your repos; setup is a
per-repo command. `noLand` is **not** an Anthropic-standard arg — the repo's workflow must read it,
which is exactly what setup arranges.)

## What `workflows/codex-wrap.js` does (noLand runner only)

`codex-wrap.js` is a thin **noLand runner**: it runs the repo's workflow with `{ noLand: true, plan }`
and classifies the result as `ready_to_land`, `danger_landed`, or `failed`. It does **not** do
architect planning, Claude planning, review, fix, or landing — those are all main-thread steps.

- **Repo workflow** — `workflow({ scriptPath: <repo wf> }, { issue, noLand: true, plan })` → the repo's
  real pipeline, returning `ready_to_land` on `branch`.
- **Result classification** — `terminal === "ready_to_land"` with `branch` + `base_sha` → returns
  `ready`. Otherwise (any other terminal, or a missing field) it does a **live check** — an agent runs
  `gh pr list --search "<issue> in:body"` and `gh issue view <issue>` — and returns `danger_landed`
  **only if the repo actually landed** (a PR for the issue now exists or the issue is CLOSED, i.e. it
  landed despite `noLand` and bypassed the architect review); if it did not land, it returns `failed`.

## Reference implementation

`Boomi/test/.claude/workflows/implement-issue.js` is the reference: its `noLand` branch returns
`readyToLand()` instead of calling `land()`. Use it as the template when adding the contract to another
repo's workflow.

## Two reference shapes (how the design maps to real repos)

The plugin must wrap a repo's lifecycle **whatever shape it has**. Two real repos illustrate the two modes:

- **Deterministic Workflow → workflow mode.** `Boomi/test` (mathkit) defines `.claude/workflows/implement-issue.js`:
  a `developer ⇄ code-reviewer` loop (cap 3) then its own internal Codex loop (cap 3), already
  `noLand`+`plan`-aware. `/codex-issue` detects `noLand`, runs it as the dev engine via `codex-wrap.js`
  (gates intact), and the main-thread architect fix rounds re-apply **that repo's `code-reviewer` gate
  discipline** on the delta (its first native pass runs the real reviewer; on fix rounds the main-thread
  fix agent — a subagent that can't dispatch the reviewer subagent — **replays** that reviewer's
  criteria inline, as faithfully as a single agent can).
- **Prose policy with a live gate → subagent mode.** `Boomi/boomi-mcp-server` has no workflow — a
  prose-only `CLAUDE.md` two-stage gate (live `boomi-qa-tester` QA via real tool calls → Codex review,
  "skipping either stage is never acceptable"). `/codex-issue` falls back to subagent mode; the
  main-thread loop discovers and runs both stages. Because that QA stage needs live credentials, it
  can be **BLOCKED** — which the loop reports fail-closed (the loop stops, nothing is landed)
  rather than silently skipping a required gate.

## Notes / limits

- The main-thread **fix loop** is repo-agnostic and **gate-faithful**: it discovers the repo's
  own dev conventions, applies the fix, and re-runs the repo's **own review/QA gate(s)** plus its tests
  before committing — not just the tests. The fix agent is itself a subagent and **cannot dispatch
  another subagent** (no nested Task), so it runs each gate the honest way: a review/QA **command or
  script** is run natively; a gate that is a repo-defined **subagent** is **replayed inline** from that
  agent's `.md`; a gate that must **execute live** (credentials/network) and can't be run is **BLOCKED**.
- **Fail-closed.** A required review/QA gate that cannot run (missing credentials/env, no network) is
  treated as BLOCKED — the change is never landed with a skipped gate. The main thread also stages only
  the fix delta (never `git add -A`), so a pre-existing untracked file is not swept into the PR.
- **Landing is main-thread-owned (by design).** Under `noLand` the repo's own `land()` is suppressed
  and the main thread does the squash + `git push` + `gh pr create` itself. A repo's **bespoke land
  side-effects** (deploy, tag/release, changelog, issue-close-with-stats) are therefore **not** replayed
  — only push + PR with `Closes #N`. If a repo needs those, run its real land step manually after the
  PR merges.
- **Preflight with `/codex-doctor`** to see which mode a repo will use and whether the `noLand` seam is
  intact, before a real run.
- The only hard requirement for composition is that the repo's Workflow implements the **`noLand`
  contract** (`noLand` is NOT an Anthropic-standard arg — the repo's script must read `args.noLand`).
  If it doesn't, `/codex-issue` detects nothing and falls back to subagent mode, which needs no contract.
- Approval is requested **before** launch (workflows can't prompt mid-run). The main-thread loop runs
  in the background and reports on completion.
- The architect plan is **inlined** into the review (no shared Codex thread across phases), so each
  architect touchpoint is a self-contained ephemeral session — no daemon-continuity fragility.
- **Two reviews, two goals (by design — not redundant).** If the repo's own workflow contains a Codex
  code-review of the implementation (reviewing the code and specific fixes in the developer loop, with
  the developer's context) AND the main-thread architect review judges the implementation against the
  **architect session's plan/intent** (with the architect's context), a change is reviewed twice —
  intentionally. They have **different goals and different context**, so neither is suppressed. The only
  "double" guarded against is re-installing the plugin's own seam/scaffold: `/codex-compose-setup` is
  **idempotent** — it detects an already-composable workflow (or its own `codex-claude:generic-scaffold`
  marker) and does **not** re-add the seam or re-scaffold.
- **Composition fidelity is loud, never silent.** Workflow-mode runs the *workflow's* phases, which can
  differ from a repo's `CLAUDE.md` prose. `/codex-issue` prints a faithfulness banner naming those phases
  and reports whether the matched workflow is git-tracked; if the workflow still carries the
  `codex-claude:generic-scaffold` marker (the untouched starter that runs **no** documented QA/review
  gates), `/codex-issue` warns and makes subagent mode the fail-safe default, and `/codex-doctor` flags
  it. `/codex-compose-setup` won't call a scaffold "ready" while a repo's documented gates are unencoded.
