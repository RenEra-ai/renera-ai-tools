# Workflow-mode composition contract

Some repos implement their development lifecycle as a **Claude Code Workflow** — a deterministic
`.claude/workflows/*.js` script (developer → reviewer loops, QA, internal Codex review, land), invoked
via the Workflow tool or a slash command.

A plugin **subagent cannot run such a Workflow**: the Workflow tool is a session-level capability, not
a grantable subagent tool, and subagents can't invoke slash commands. So the `codex-developer` black
box can only *approximate* a Workflow-mode repo's pipeline by replaying its steps — losing the gates
baked into the JS (loop caps, scope confinement, verdict classification).

**Composition** solves this. The `/codex-issue` command runs in the **main thread**, where the Workflow
tool *is* available, so it composes a wrapper workflow (`workflows/codex-wrap.js`) that brackets the
repo's **own** workflow with a Codex architect plan + review:

```
Codex architect plan  →  workflow(repo, { noLand: true })  →  Codex architect review → fix → re-review  →  land (push + PR)
                          └── the repo's REAL pipeline, all gates intact ──┘
```

`workflow()` runs another workflow inline as a one-level sub-step, so the repo's pipeline executes for
real; the plugin only adds the architect bookends and the landing.

## The contract (what a repo's workflow must support)

To be composable, the repo's `.claude/workflows/*.js` must accept:

| arg | required | behavior |
|---|---|---|
| `args.issue` | yes | the issue to implement (already the norm). |
| `args.noLand` | **yes** | run the full pipeline (implement + all internal reviews/QA) but **return before landing** — no squash, push, PR, or issue-close. Leave the implemented + reviewed commits on the branch. Return `{ terminal: "ready_to_land", branch, base_sha, ready: true }`. |
| `args.plan` | optional | an architect plan (string) to guide implementation; inject it into the implement step. Ignore if unsupported. |

The plugin **detects** a composable workflow by `grep -l noLand .claude/workflows/*.js`. If none is
found, `/codex-issue` falls back to **subagent mode** (the `codex-developer` black box) and works as
before.

## Making a repo composable — `/codex-compose-setup`

Run **`/codex-compose-setup`** in a repo to arrange the contract automatically instead of editing by
hand:
- An existing `.claude/workflows/*.js` → it adds the `noLand` seam **in place** (gate `land()` → return
  `ready_to_land`), shown as a diff for your approval.
- No workflow → it scaffolds a minimal, composition-ready starter from
  `templates/implement-issue.template.js` (implement → discover-and-run the repo's tests → land,
  already `noLand`-aware).

(Plugin *install* can't do this — a plugin is global and never runs inside your repos; setup is a
per-repo command. `noLand` is **not** an Anthropic-standard arg — the repo's workflow must read it,
which is exactly what setup arranges.)

## What the plugin's wrapper does (`workflows/codex-wrap.js`)

1. **Architect plan** — an ephemeral Codex Plan-mode session (`scripts/plan-round.mjs`) → plan text.
2. **Repo workflow** — `workflow({ scriptPath: <repo wf> }, { issue, noLand: true, plan })` → the repo's
   real pipeline, returning `ready_to_land` on `branch`.
3. **Architect review** — an ephemeral Codex review (`scripts/review-round.mjs`) of the branch diff vs
   the inlined plan, parsed for a last-line `VERDICT: NO ISSUES` / `VERDICT: ISSUES FOUND`. A clean
   verdict with **zero substance** (no findings, no `reviewedFiles`) is not rubber-stamped — the
   wrapper nudges once for the list of reviewed files and re-reviews before accepting clean. On issues,
   a single merged fix agent runs the repo's **own review/QA discipline on the fix delta**, not just
   its tests: it discovers the repo's process (CLAUDE.md/AGENTS.md/.claude docs/commands/agents),
   applies the fix, **re-runs the repo's own review/QA gate(s)** — dispatching the repo's
   reviewer/QA agent via Task and looping until that gate is clean (falling back to running the gate's
   discipline inline if Task can't dispatch it), then runs the repo's discovered test/QA command — and
   commits **only if all of that is green**. A required gate that **cannot run** (e.g. a credential-gated
   live QA stage that needs an account the run doesn't have) is **fail-closed**: the round returns
   `not_clean` (its `detail` is expected to begin `BLOCKED:`) and the change is **not** landed — a live
   gate is never inline-faked from a diff. Re-reviewed up to `maxRounds` (default 6).
4. **Land** — squash to the repo's one-commit convention, `git push`, `gh pr create` (`Closes #N`).
   Never closes the issue directly; flags non-default bases for manual close. `--dry-run` stops here.

## Reference implementation

`Boomi/test/.claude/workflows/implement-issue.js` is the reference: its `noLand` branch returns
`readyToLand()` instead of calling `land()`. Use it as the template when adding the contract to another
repo's workflow.

## Two reference shapes (how the design maps to real repos)

The plugin must wrap a repo's lifecycle **whatever shape it has**. Two real repos illustrate the two modes:

- **Deterministic Workflow → workflow mode.** `Boomi/test` (mathkit) defines `.claude/workflows/implement-issue.js`:
  a `developer ⇄ code-reviewer` loop (cap 3) then its own internal Codex loop (cap 3), already
  `noLand`+`plan`-aware. `/codex-issue` detects `noLand`, runs it as a real sub-workflow (gates intact),
  and the architect's fix rounds re-apply **that repo's `code-reviewer` gate discipline** on the delta
  (dispatching its reviewer agent where possible; a gate baked entirely into the workflow JS is
  replayed as faithfully as a single agent can, not natively re-run).
- **Prose policy with a live gate → subagent mode.** `Boomi/boomi-mcp-server` has no workflow — a
  prose-only `CLAUDE.md` two-stage gate (live `boomi-qa-tester` QA via real tool calls → Codex review,
  "skipping either stage is never acceptable"). `/codex-issue` falls back to subagent mode; the
  `codex-developer` discovers and runs both stages. Because that QA stage needs live credentials, it
  can be **BLOCKED** — which the developer reports fail-closed (the loop stops, nothing is landed)
  rather than silently skipping a required gate.

## Notes / limits

- The wrapper's architect **fix loop** is repo-agnostic and **gate-faithful**: it discovers the repo's
  own dev conventions, applies the fix, and re-runs the repo's **own review/QA gate(s)** (its reviewer/
  QA agent via Task, with an inline fallback) plus its tests before committing — not just the tests.
  It uses a named developer/reviewer agent **if one exists**, otherwise follows the repo's documented
  procedure or implements per CLAUDE.md. No specific agent name is assumed.
- **Fail-closed.** A required review/QA gate that cannot run (missing credentials/env, no network) is
  treated as BLOCKED — the change is never landed with a skipped gate.
- The only hard requirement for composition is that the repo's Workflow implements the **`noLand`
  contract** (`noLand` is NOT an Anthropic-standard arg — the repo's script must read `args.noLand`).
  If it doesn't, `/codex-issue` detects nothing and falls back to subagent mode, which needs no contract.
- Approval is requested **before** launch (workflows can't prompt mid-run). The wrapper runs in the
  background and reports on completion.
- The architect plan is **inlined** into the review (no shared Codex thread across phases), so each
  architect touchpoint is a self-contained ephemeral session — no daemon-continuity fragility.
