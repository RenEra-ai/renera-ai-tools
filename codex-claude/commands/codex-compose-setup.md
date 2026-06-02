---
name: codex-compose-setup
description: >-
  Make THIS repo composition-ready for /codex-issue (workflow-mode). If the repo has a Claude Code
  Workflow, it adds the `noLand` seam to it in place (returns ready_to_land before landing) — shown as
  a diff for your approval. If the repo has no workflow, it scaffolds a minimal, composition-ready
  starter workflow. Composition is the higher-fidelity path; /codex-issue already works without setup
  via subagent mode.
argument-hint: ""
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
---

Make this repo **composition-ready** so `/codex-issue` can wrap its real dev workflow with a Codex
architect plan + review (workflow-mode). The only thing needed is the **`noLand` contract**: the repo's
workflow must run its full pipeline but return `{ terminal: "ready_to_land", branch, base_sha, ready: true }`
before it lands (squash/push/PR/close), when called with `args.noLand: true`.

## Step 1 — detect

```bash
ls .claude/workflows/*.js 2>/dev/null
grep -l "noLand" .claude/workflows/*.js 2>/dev/null
```

- A workflow that **already contains `noLand`** → already composable. Report which file and stop.
- A workflow **without `noLand`** → **Step 2** (add the seam in place).
- **No** `.claude/workflows/*.js` → **Step 3** (scaffold a starter).

## Step 2 — add the `noLand` seam to the existing workflow (in place, with approval)

**Read the workflow file** and understand its structure: where it reads `args`, where it creates the
working branch and freezes the base commit, and where it **lands** (the terminal integration — squash /
push / PR / issue-close / deploy, often a `land()` function or a final block). Then edit it,
**preserving everything else**:

1. Near the other `args` reads, add:
   `const NO_LAND = !!(args && typeof args === 'object' && args.noLand)`
   and (if implementation guidance is easy to thread in) `const PLAN = (args && typeof args === 'object' && typeof args.plan === 'string') ? args.plan : ''`.
2. If `PLAN` is added, inject it into the implement step ("follow this architect plan where sound").
3. **Immediately before the workflow lands**, gate it: when `NO_LAND` is true, RETURN
   `{ ...<its run report>, terminal: 'ready_to_land', branch: <its branch var>, base_sha: <its frozen base var>, ready: true }`
   instead of landing. Identify the workflow's existing branch + base variables; if it tracks no base,
   set `base_sha` to the commit the working branch was created from.

**Show the change as a diff** (`git diff -- <file>` if it's tracked, otherwise present the before/after
of the edited region) and use **AskUserQuestion** — *Apply* · *Show more* · *Cancel* — before saving.
After applying, verify: `grep -c noLand <file>` is > 0.

(Keep the edit minimal and faithful — do not restructure or "improve" the user's pipeline; only add the
seam. If the land step is too tangled to gate safely, say so and offer Step 3's standalone template as
an alternative the wrapper can call instead.)

## Step 3 — scaffold a starter workflow (no workflow exists)

Copy the bundled, repo-agnostic template (implement → discover-and-run the repo's tests → land, already
`noLand`-aware):

```bash
mkdir -p .claude/workflows
cp "${CLAUDE_PLUGIN_ROOT}/templates/implement-issue.template.js" .claude/workflows/implement-issue.js
```

Tell the user it's a **starting point** they can grow (add their own code-review / QA / lint steps
between Implement and Land), it discovers the test command from their `CLAUDE.md` (no runner assumed),
and it's already composition-ready.

## Done

Confirm: `/codex-issue <issue#>` will now detect this repo as composable and offer the composition path.
Remind the user that this only enables the *higher-fidelity* composition; `/codex-issue` already worked
without it via subagent mode. Note that `.claude/` may be untracked in their repo — if so the seam/
scaffold lives in the working tree (commit it if they want it version-controlled).
