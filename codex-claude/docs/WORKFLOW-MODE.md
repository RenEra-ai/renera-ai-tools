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

## What the plugin's wrapper does (`workflows/codex-wrap.js`)

1. **Architect plan** — an ephemeral Codex Plan-mode session (`scripts/plan-round.mjs`) → plan text.
2. **Repo workflow** — `workflow({ scriptPath: <repo wf> }, { issue, noLand: true, plan })` → the repo's
   real pipeline, returning `ready_to_land` on `branch`.
3. **Architect review** — an ephemeral Codex review (`scripts/review-round.mjs`) of the branch diff vs
   the inlined plan, parsed for a last-line `VERDICT: NO ISSUES` / `VERDICT: ISSUES FOUND`. On issues,
   the fix is dispatched to the **repo's own `developer` agent** (its conventions), re-verified
   (repo tests) and committed, then re-reviewed — up to `maxRounds` (default 6).
4. **Land** — squash to the repo's one-commit convention, `git push`, `gh pr create` (`Closes #N`).
   Never closes the issue directly; flags non-default bases for manual close. `--dry-run` stops here.

## Reference implementation

`Boomi/test/.claude/workflows/implement-issue.js` is the reference: its `noLand` branch returns
`readyToLand()` instead of calling `land()`. Use it as the template when adding the contract to another
repo's workflow.

## Notes / limits

- The wrapper's architect **fix loop** uses the repo's `developer` agent directly (it must exist as a
  dispatchable `.claude/agents/*` for the fix path). If a repo defines its logic *only* inside the
  Workflow with no dispatchable developer agent, the fix loop degrades — prefer exposing a developer
  agent.
- Approval is requested **before** launch (workflows can't prompt mid-run). The wrapper runs in the
  background and reports on completion.
- The architect plan is **inlined** into the review (no shared Codex thread across phases), so each
  architect touchpoint is a self-contained ephemeral session — no daemon-continuity fragility.
