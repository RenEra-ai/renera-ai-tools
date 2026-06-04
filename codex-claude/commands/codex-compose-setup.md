---
name: codex-compose-setup
description: >-
  Make THIS repo composition-ready for /codex-issue (workflow-mode). If the repo has a Claude Code
  Workflow, it adds the `noLand` seam to it in place (returns ready_to_land before landing) — shown as
  a diff for your approval. If the repo has no workflow, it scaffolds a minimal, composition-ready
  starter workflow. Composition makes the repo's Workflow the development ENGINE for /codex-issue (run
  with noLand, bracketed by main-thread architect plan + review); /codex-issue already works without
  setup via main-thread mode.
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

Make this repo **composition-ready** so `/codex-issue` can use its real dev workflow as the
**development engine** (workflow-mode). Composition means the repo's Workflow runs with `noLand:true`
as the dev engine — all its gates intact — bracketed by main-thread architect plan, Claude plan,
review, fix, and land steps. The only thing the repo's workflow needs is the **`noLand` contract**:
it must run its full pipeline but return `{ terminal: "ready_to_land", branch, base_sha, ready: true }`
before it lands (squash/push/PR/close), when called with `args.noLand: true`.

## Step 1 — detect

```bash
ls .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null
grep -l "noLand" .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null   # candidates only
grep -l "codex-claude:generic-scaffold" .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null  # our unmodified starter?
```

- A workflow that actually **reads `args.noLand`** or destructures `noLand` from `args` in code (not a
  comment-only/string-only mention) and returns `terminal: "ready_to_land"` with `branch` and `base_sha`
  under that branch → already composable. **Idempotency:** setup has nothing to add — report which file
  and stop (do NOT re-scaffold or re-add the seam). If that file still contains the
  `codex-claude:generic-scaffold` marker, add the caveat from Step 3 (it's our untouched starter and does
  NOT run the repo's documented gates).
- A workflow file exists but no file implements that contract → **Step 2** (add the seam in place).
- **No** `.claude/workflows/*.js` or `.mjs` → **Step 3** (scaffold a starter).

## Step 2 — add the `noLand` seam to the existing workflow (in place, with approval)

**Read the workflow file** and understand its structure: where it reads `args`, where it creates the
working branch and freezes the base commit, and where it **lands** (the terminal integration — squash /
push / PR / issue-close / deploy, often a `land()` function or a final block).

**Do NOT modify the real workflow file yet** — draft the change to a temp copy so Cancel leaves the
original untouched:
1. Copy the workflow to a temp file: `cp <file> /tmp/codex-seam.proposed.js`.
2. Apply the seam to the **temp copy** (preserving everything else):
   - Near the other `args` reads, add `const NO_LAND = !!(args && typeof args === 'object' && args.noLand)`
     and (if easy to thread in) `const PLAN = (args && typeof args === 'object' && typeof args.plan === 'string') ? args.plan : ''`.
   - If `PLAN` is added, inject it into the implement step ("follow this architect plan where sound").
   - **Immediately before the workflow lands**, gate it: when `NO_LAND` is true, RETURN
     `{ ...<its run report>, terminal: 'ready_to_land', branch: <its branch var>, base_sha: <its frozen base var>, ready: true }`
     instead of landing. Identify the workflow's existing branch + base variables; if it tracks no
     base, set `base_sha` to the commit the working branch was created from.
3. Show the diff between the original and the proposal: `diff <file> /tmp/codex-seam.proposed.js`
   (or present the before/after of the changed region).
4. **AskUserQuestion** — *Apply* · *Show more* · *Cancel*. **Only on Apply**, overwrite the original:
   `cp /tmp/codex-seam.proposed.js <file>` (and `node --check` it isn't required — workflow scripts use
   top-level await/return, but confirm it still reads as the same workflow). On **Cancel**, delete the
   temp and leave the original **unchanged**.
5. After Apply, verify the same contract `/codex-issue` will require: the file reads `args.noLand` (or
   destructures `noLand` from `args`) in code, and the no-land path returns `terminal: 'ready_to_land'`
   with `branch` and `base_sha`.

(Keep the edit minimal and faithful — do not restructure or "improve" the user's pipeline; only add the
seam. If the land step is too tangled to gate safely, say so and offer Step 3's standalone template as
an alternative the wrapper can call instead.)

## Step 3 — scaffold a starter workflow (no workflow exists)

Copy the bundled, repo-agnostic template (implement → discover-and-run the repo's tests → land, already
`args.noLand`-aware):

```bash
mkdir -p .claude/workflows
cp "${CLAUDE_PLUGIN_ROOT}/templates/implement-issue.template.js" .claude/workflows/implement-issue.js
```

Tell the user it's a **starting point** they can grow (add their own code-review / QA / lint steps
between Implement and Land), it discovers the test command from their `CLAUDE.md` (no runner assumed),
and it's already composition-ready.

**Fidelity tripwire (do not skip).** The scaffold carries a `codex-claude:generic-scaffold` marker and
only does implement → run-tests → land. Read the repo's `CLAUDE.md` / `AGENTS.md`: **if they document a
real completion process** (a QA gate, a code-review/`codex-companion` review loop, lint, etc.), say
**plainly** that the scaffold does **NOT** implement those gates and is therefore **not "ready"** for a
faithful run yet — `/codex-issue` will run the scaffold's phases, not the documented prose. List the
specific documented gates it is missing, and tell the user to encode them (replacing the marker line)
before relying on workflow-mode. Do not describe an unmodified scaffold as "ready" when documented gates
exist. While the marker line remains, `/codex-issue` and `/codex-doctor` will warn it's unmodified.

**Tracked-ness (reproducibility).** `.claude/` is often untracked, and mode-detection keys on the file
being present — a `git clean`/fresh clone would silently flip the repo back to main-thread mode. After
writing the file, check `git ls-files --error-unmatch .claude/workflows/implement-issue.js` and, if it's
untracked, **offer to stage/commit it** (e.g. `git add .claude/workflows/implement-issue.js`) so the
chosen mode is durable. Leave the commit to the user's approval.

## Done

Confirm: `/codex-issue <issue#>` will now detect this repo as composable and offer the composition path.
Remind the user that this only enables the *higher-fidelity* composition; `/codex-issue` already worked
without it via main-thread mode. Note that `.claude/` may be untracked in their repo — if so the seam/
scaffold lives in the working tree (commit it if they want it version-controlled).
