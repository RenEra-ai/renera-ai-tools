# Main-thread Codex↔Claude loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-seat `/codex-issue`'s orchestration in the **main agent loop** (so it has `Task`, develops with the repo's real subagents, and produces a real plan-mode artifact), retiring the two impossible nested-subagent agents.

**Architecture:** The `/codex-issue` command body runs the whole loop in the main thread. It dispatches only *thin, Task-free* subagents to drive Codex (`codex-architect` for the design plan, `codex-planner` read-only for the impl plan, `codex-reviewer` for review). Development and fixes happen in the main thread, where `Task` exists, so the repo's own QA/review subagents run for real. All Codex sessions are ephemeral (`plan-round.mjs`/`review-round.mjs`); the persisted plan text is re-inlined into reviews — no persistent daemon.

**Tech Stack:** Claude Code plugin (markdown agents/commands/skill + Node `.mjs` Workflow script + `node --test`). No new deps.

**Spec:** `codex-claude/docs/specs/2026-06-04-mainthread-loop-redesign-design.md` (read it first).

**Verified platform facts (2026-06-04, this env):** subagents get `Bash`/`Read`/`Edit`/`Write` but NOT `Grep`/`Glob`/`Task`/`AskUserQuestion`/`EnterPlanMode`/`ExitPlanMode`. Thin agents therefore use `Bash` for search; the planner is `Read`-only.

---

## File structure

```
codex-claude/
  agents/
    codex-orchestrator.md    # DELETE (impossible: subagent that dispatches a developer)
    codex-developer.md       # DELETE (impossible: subagent that dispatches repo QA subagents)
    codex-architect.md       # CREATE — thin Codex design-plan driver (Bash, Read)
    codex-planner.md         # CREATE — Read-only impl-plan author (mode:plan), returns text
    codex-reviewer.md        # REWRITE — drop dead Grep/Glob; structured {verdict, reviewedFiles, findings}
  commands/
    codex-issue.md           # REWRITE — thin entry + preflight + mode-detect + main-thread loop
    codex-doctor.md          # EDIT — wording (mode preflight unchanged; drop orchestrator mentions)
    codex-compose-setup.md   # EDIT — wording (composition is now the dev-engine, not the bracket)
  skills/codex-claude/SKILL.md  # EDIT — replace the orchestration section; point at the command
  workflows/codex-wrap.js    # SHRINK — noLand runner only (run repo workflow, validate ready_to_land, danger-landed check)
  lib/
    wrap-terminal.mjs        # CREATE — pure decision helper for codex-wrap.js (testable)
  test/
    wrap-terminal.test.mjs   # CREATE — unit tests for the helper
  templates/implement-issue.template.js  # EDIT — align comments (noLand contract unchanged)
  docs/WORKFLOW-MODE.md      # EDIT — wording (main-thread brackets; composition = dev engine)
  README.md                  # EDIT — drop retired-agent references
```

**Shared contracts (keep identical across tasks):**
- `codex-architect` final message: first line `STATUS: DONE` or `STATUS: FAILED: <reason>`; second line `PLAN_PATH: <abs path or (none)>`. (The main thread reads the plan body from that file.)
- `codex-planner` final message **IS** the implementation plan markdown, OR exactly `STATUS: THIN` if it could not produce one.
- `codex-reviewer` final message: findings as `file:line — issue — fix` lines, then a LAST line exactly `VERDICT: NO ISSUES` or `VERDICT: ISSUES FOUND` (or `VERDICT: UNCLEAR`); a `Reviewed files:` line listing what it inspected.
- `codex-wrap.js` return: `{ status, branch, base_sha, ... }` where `status:"ready"` means the repo workflow returned `terminal:"ready_to_land"`; `status:"danger_landed"` / `status:"failed"` otherwise.
- Plan artifacts: design `.codex/plans/issue-<N>.md`; impl `.codex/plans/issue-<N>.claude.md`.

---

## Task 1: Retire the two impossible agents

**Files:**
- Delete: `codex-claude/agents/codex-orchestrator.md`
- Delete: `codex-claude/agents/codex-developer.md`
- Modify: `codex-claude/README.md` (remove references)

- [ ] **Step 1: Find every reference to the retired agents**

Run: `grep -rn "codex-orchestrator\|codex-developer" codex-claude --include=*.md --include=*.js --include=*.json`
Expected: matches in `agents/codex-orchestrator.md`, `agents/codex-developer.md`, `commands/codex-issue.md`, `skills/codex-claude/SKILL.md`, `README.md` (and possibly `docs/`). Note them — `codex-issue.md` and `SKILL.md` are rewritten in later tasks; only fix non-rewritten files here (README, any stray docs).

- [ ] **Step 2: Delete the two agent files**

```bash
git rm codex-claude/agents/codex-orchestrator.md codex-claude/agents/codex-developer.md
```

- [ ] **Step 3: Remove README references**

Open `codex-claude/README.md`; delete/replace any sentence describing `codex-orchestrator`/`codex-developer` (e.g. "the orchestrator dispatches a black-box developer…") with a one-liner: "`/codex-issue` runs the loop in the main thread; Codex is driven by the thin `codex-architect`/`codex-reviewer` agents." Leave the rest intact. (If README has no such reference, skip.)

- [ ] **Step 4: Verify the plugin still loads (no dangling agent refs)**

Run: `node codex-claude/bin/codex-drive.mjs doctor`
Expected: prints the JSON `{ codexVersion, authPresent, threads }` with no error about missing agents. (Doctor doesn't load agents, but this confirms the bin still runs.) Also re-run Step 1's grep and confirm only `codex-issue.md`/`SKILL.md` (to be rewritten) still reference the names.

- [ ] **Step 5: Commit**

```bash
git add -A codex-claude/README.md
git commit -m "codex-claude: retire codex-orchestrator/codex-developer (impossible nested subagents)"
```

---

## Task 2: New thin agent — `codex-architect.md`

**Files:**
- Create: `codex-claude/agents/codex-architect.md`

- [ ] **Step 1: Create the file with exactly this content**

```markdown
---
name: codex-architect
description: >-
  Drives Codex (GPT-5.x) to produce a read-only, file-by-file ARCHITECT design plan for an issue or
  task, on its own ephemeral Codex session, and persists it. Returns just a STATUS + the saved path —
  it keeps the verbose Codex plan wait-loop out of the main conversation. It is a transcriber, not the
  author: it never writes a plan of its own if Codex fails to produce one. Dispatched by /codex-issue.
model: claude-sonnet-4-6
color: cyan
tools: Bash, Read
skills: codex-claude
---

You drive **Codex** in Plan mode to architect a concrete plan, then hand back where it was saved. You
do NOT design the plan yourself and you do NOT edit code. Your final message is the entire contract.

## Steps

1. **Doctor.** `node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs doctor`. If `codexVersion` is null or
   `authPresent` is false, return `STATUS: FAILED: Codex unavailable (not installed / not logged in)`
   and stop. Do not fabricate a plan.

2. **Build the prompt file.** You are given the issue/task text and the `--out` path by the
   dispatcher. Write the plan prompt to a temp file with the Write tool — NEVER inline issue text in a
   shell argument (it may contain backticks/`$()`/quotes). The prompt body:
   > "Architect a concrete, file-by-file plan for this task. Inspect the relevant files. Honor this
   > repo's own conventions in CLAUDE.md / AGENTS.md (no new dependencies, minimal diff, scope
   > discipline) — propose nothing that violates them. Do not change anything." …followed by the task
   > title + body.
   (You only have `Bash`/`Read`/`Write` — no `Grep`/`Glob`; use `Bash` (`rg`/`grep`/`ls`/`find`) if
   you need to look around, but normally you just pass the task through.)

3. **Run the ephemeral Plan-mode driver FROM THE REPO ROOT** so `--out` lands in the repo:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/plan-round.mjs --prompt-file <tmp> --out <the --out path> --effort xhigh`
   It prints `STATUS: …`, `PLAN_FILE: …`, then `=== PLAN ===` and the body.

4. **Check it's real.** If `STATUS` is not exactly `completed`, or it shows `(empty)`/`(no-plan)`, or
   the body is only a reasoning preamble: rebuild the prompt file with a nudge appended ("Approvals
   are unavailable in this read-only planning session — do NOT run pytest or any command. Emit the
   FULL file-by-file plan as plain text NOW from static reading only; do not stop after the reasoning
   preamble.") and run the driver ONCE more (same `--out`).

5. **Report.** If a usable plan was saved, return EXACTLY two lines:
   ```
   STATUS: DONE
   PLAN_PATH: <the absolute path from PLAN_FILE>
   ```
   If after the retry it still produced no usable plan, return:
   ```
   STATUS: FAILED: <the driver's STATUS and a one-line reason>
   PLAN_PATH: (none)
   ```
   Do NOT write, summarize, or substitute your own plan. Failing loud is the correct outcome.
```

- [ ] **Step 2: Validate the frontmatter parses**

Run: `node -e "const f=require('fs').readFileSync('codex-claude/agents/codex-architect.md','utf8'); const m=f.match(/^---\n([\s\S]*?)\n---/); if(!m) throw new Error('no frontmatter'); if(!/tools: Bash, Read/.test(m[1])) throw new Error('tools wrong'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add codex-claude/agents/codex-architect.md
git commit -m "codex-claude: add thin codex-architect (drives Codex plan, no Task)"
```

---

## Task 3: New read-only agent — `codex-planner.md`

**Files:**
- Create: `codex-claude/agents/codex-planner.md`

- [ ] **Step 1: Create the file with exactly this content**

```markdown
---
name: codex-planner
description: >-
  Authors Claude's OWN concrete, file-by-file IMPLEMENTATION plan from a Codex architect design plan,
  under read-only discipline (Read-only tools; dispatched mode:plan). It returns the plan text — it
  does NOT write files or code. The dispatcher (main thread) persists the returned text. Used by
  /codex-issue between the architect plan and development.
model: inherit
color: yellow
tools: Read
---

You turn the architect's INTENT into a concrete implementation plan **you** would follow. You are
**read-only**: your only tool is `Read`. You write nothing and run nothing. Your final message IS the
plan (the dispatcher persists it).

You are given, in your prompt: the issue/task text, and the architect's design-plan text.

## Do this

1. Read the files the architect plan names (and their close neighbours) so your plan is grounded in
   the real code — use the `Read` tool on the exact paths the design plan references.
2. Honor THIS repo's conventions from its CLAUDE.md / AGENTS.md as quoted in your prompt (no new
   dependencies, minimal diff, scope discipline). Cover every file/behavior the architect plan calls
   for; keep its scope. If you intend to deviate, say so with a one-line reason — don't just echo it.
3. Return the plan as markdown with these sections: **Summary** (2–4 sentences), **File-by-file**
   (each path + what changes), **Test plan** (what to run / add), **Deviations from architect plan**
   (or "none").

If you genuinely cannot produce a substantive plan (e.g. the design plan is empty/unusable), return
EXACTLY `STATUS: THIN` and nothing else — the dispatcher will fall back to the architect plan.

Do NOT attempt to edit, create, or stage any file; you have no tools to do so and must not try.
```

- [ ] **Step 2: Validate the frontmatter (Read-only tool set)**

Run: `node -e "const f=require('fs').readFileSync('codex-claude/agents/codex-planner.md','utf8'); const m=f.match(/^---\n([\s\S]*?)\n---/)[1]; if(!/^tools: Read$/m.test(m)) throw new Error('planner must be Read-only'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add codex-claude/agents/codex-planner.md
git commit -m "codex-claude: add read-only codex-planner (impl plan, mode:plan, returns text)"
```

---

## Task 4: Rewrite `codex-reviewer.md` (structured findings; drop dead Grep/Glob)

**Files:**
- Modify: `codex-claude/agents/codex-reviewer.md`

- [ ] **Step 1: Replace the frontmatter `tools:` line**

Change `tools: Bash, Read, Grep, Glob` → `tools: Bash, Read` (Grep/Glob are non-functional in subagents — verified). Leave `model`, `color`, `skills`, `name`, `description` as-is.

- [ ] **Step 2: Replace the body's review step to take a plan + emit a structured contract**

Keep the doctor/scope/run-driver structure, but make the prompt and the return contract explicit:
- The dispatcher passes the **architect design-plan text** and the **changed files**. The review must
  judge the implementation **against that plan** and the repo's conventions, listing concrete
  `file:line` issues with fixes.
- Build the review prompt in a temp file (Write-free is impossible here — the reviewer HAS `Bash`;
  use `printf`/heredoc to a temp file is fine since reviewer has Bash, OR keep using a prompt file via
  the existing pattern). Run EXACTLY: `node ${CLAUDE_PLUGIN_ROOT}/scripts/review-round.mjs --prompt-file <tmp>`
  (the only driver with a bounded timeout — never substitute `codex exec`/`codex review`).
- Parse the driver's `PARSED_VERDICT:` line for the verdict; collect `file:line` findings from the
  `=== REVIEW ===` body.
- **Return contract** (final message): one `Reviewed files: <list>` line; then each finding as
  `path:line — <problem> — <fix>`; then a LAST line that is EXACTLY one of
  `VERDICT: NO ISSUES` / `VERDICT: ISSUES FOUND` / `VERDICT: UNCLEAR`. Quote Codex faithfully; mark a
  suspected false positive but keep it.

Replace the existing step 3–5 prose accordingly (the exact driver command and the last-line verdict
rule must appear verbatim).

- [ ] **Step 3: Validate frontmatter + contract markers present**

Run: `node -e "const f=require('fs').readFileSync('codex-claude/agents/codex-reviewer.md','utf8'); if(/Grep|Glob/.test(f)) throw new Error('still references Grep/Glob'); if(!/review-round\.mjs/.test(f)) throw new Error('missing driver'); if(!/VERDICT: NO ISSUES/.test(f)) throw new Error('missing verdict contract'); console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add codex-claude/agents/codex-reviewer.md
git commit -m "codex-claude: codex-reviewer takes plan+files, structured verdict, drop dead Grep/Glob"
```

---

## Task 5: Shrink `codex-wrap.js` to a noLand runner (TDD the decision helper)

The wrapper no longer plans/reviews/fixes/lands (all main-thread now). It ONLY runs the repo's
workflow with `noLand` and classifies the result. Extract the classification into a pure, testable
helper.

**Files:**
- Create: `codex-claude/lib/wrap-terminal.mjs`
- Create: `codex-claude/test/wrap-terminal.test.mjs`
- Modify: `codex-claude/workflows/codex-wrap.js`

- [ ] **Step 1: Write the failing test** (`codex-claude/test/wrap-terminal.test.mjs`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRepoResult } from '../lib/wrap-terminal.mjs';

test('ready_to_land with branch+base_sha → ready', () => {
  const r = classifyRepoResult({ terminal: 'ready_to_land', branch: 'codex/issue-9', base_sha: 'abc123' });
  assert.deepEqual(r, { status: 'ready', branch: 'codex/issue-9', base_sha: 'abc123' });
});

test('ready_to_land missing branch → failed', () => {
  const r = classifyRepoResult({ terminal: 'ready_to_land', base_sha: 'abc' });
  assert.equal(r.status, 'failed');
});

test('non-ready terminal → needs_land_check (could be a noLand violation)', () => {
  const r = classifyRepoResult({ terminal: 'landed' });
  assert.equal(r.status, 'needs_land_check');
});

test('null/empty result → failed', () => {
  assert.equal(classifyRepoResult(null).status, 'failed');
  assert.equal(classifyRepoResult({}).status, 'needs_land_check');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test codex-claude/test/wrap-terminal.test.mjs`
Expected: FAIL — `Cannot find module '../lib/wrap-terminal.mjs'`.

- [ ] **Step 3: Create `codex-claude/lib/wrap-terminal.mjs`**

```js
// Pure classification of a repo workflow's noLand result, extracted from codex-wrap.js so it is
// unit-testable (a sandboxed Workflow script cannot import modules; codex-wrap.js inlines a mirror —
// keep them in sync, the test guards this copy).
export function classifyRepoResult(repo) {
  if (!repo || typeof repo !== 'object') return { status: 'failed', detail: 'no result' };
  if (repo.terminal === 'ready_to_land') {
    if (!repo.branch || !repo.base_sha) return { status: 'failed', detail: 'ready_to_land missing branch/base_sha' };
    return { status: 'ready', branch: repo.branch, base_sha: repo.base_sha };
  }
  // Asked for noLand but did NOT return ready_to_land → caller must check whether it landed anyway.
  return { status: 'needs_land_check', terminal: repo.terminal || null, detail: repo.detail || '' };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test codex-claude/test/wrap-terminal.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewrite `codex-claude/workflows/codex-wrap.js`** to the noLand runner

Replace the whole file with:

```js
export const meta = {
  name: 'codex-wrap',
  description: "Run a repo's OWN workflow with land suppressed (noLand) and return its ready-to-land state. The /codex-issue main thread brackets this with the Codex architect plan + review; this script only runs the repo's deterministic pipeline as the development engine.",
  phases: [{ title: 'Repo workflow' }],
}

// args (from the /codex-issue main thread): { issue, repoWorkflowPath, plan, base?, maxRounds? }
const ARGS = (typeof args === 'string' ? JSON.parse(args) : args) || {}
const ISSUE = ARGS.issue
const REPO_WF = ARGS.repoWorkflowPath
const PLAN = ARGS.plan || ''
if (!ISSUE || !REPO_WF) throw new Error('codex-wrap: need args.issue and args.repoWorkflowPath')

// Mirror of lib/wrap-terminal.mjs classifyRepoResult (sandboxed script can't import). Keep in sync —
// test/wrap-terminal.test.mjs guards the lib copy.
function classifyRepoResult(repo) {
  if (!repo || typeof repo !== 'object') return { status: 'failed', detail: 'no result' }
  if (repo.terminal === 'ready_to_land') {
    if (!repo.branch || !repo.base_sha) return { status: 'failed', detail: 'ready_to_land missing branch/base_sha' }
    return { status: 'ready', branch: repo.branch, base_sha: repo.base_sha }
  }
  return { status: 'needs_land_check', terminal: repo.terminal || null, detail: repo.detail || '' }
}

const LANDCHK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['landed', 'detail'], properties: { landed: { type: 'boolean' }, detail: { type: 'string' } },
}

phase('Repo workflow')
const repo = await workflow({ scriptPath: REPO_WF }, { issue: ISSUE, noLand: true, plan: PLAN })
const c = classifyRepoResult(repo)

if (c.status === 'ready') {
  log(`repo workflow ready-to-land on ${c.branch} (base ${c.base_sha})`)
  return { status: 'ready', branch: c.branch, base_sha: c.base_sha, repo }
}

if (c.status === 'needs_land_check') {
  // It was asked for noLand but didn't return ready_to_land. Distinguish a clean fail-closed from a
  // DANGEROUS noLand-contract violation where it landed anyway (which would bypass the architect review).
  const landed = await agent(
    `The repo workflow for issue #${ISSUE} was called with noLand:true but did NOT return ready_to_land. Determine whether it nevertheless ALREADY LANDED: check \`gh pr list --search "${ISSUE} in:body" --state all --json url\` for a PR referencing this issue, and \`gh issue view ${ISSUE} --json state\` (the issue was OPEN at start). landed=true if a PR for this issue now exists OR the issue is CLOSED; else false. In detail give the PR url + issue state.`,
    { label: `land-check #${ISSUE}`, phase: 'Repo workflow', schema: LANDCHK_SCHEMA },
  )
  if (landed && landed.landed) {
    return { status: 'danger_landed', detail: `DANGER: repo workflow landed despite noLand:true — the architect review was BYPASSED. ${landed.detail || ''}`, repo }
  }
  return { status: 'failed', detail: `repo workflow did not reach ready_to_land (${c.terminal || 'unknown'})${c.detail ? ': ' + c.detail : ''}`, repo }
}

return { status: 'failed', detail: c.detail || 'unknown', repo }
```

- [ ] **Step 6: Run the full Node suite (no regressions)**

Run: `cd codex-claude && npm test`
Expected: PASS — including the new `wrap-terminal.test.mjs`. If old tests referenced the removed
codex-wrap phases/logic (e.g. a `plan-output`/composition test asserting the wrapper plans), update or
remove those assertions so the suite is green; note which you changed.

- [ ] **Step 7: Commit**

```bash
git add codex-claude/lib/wrap-terminal.mjs codex-claude/test/wrap-terminal.test.mjs codex-claude/workflows/codex-wrap.js
git commit -m "codex-claude: shrink codex-wrap to a noLand runner (+ tested terminal classifier)"
```

---

## Task 6: Rewrite `commands/codex-issue.md` (the main-thread loop)

**Files:**
- Modify: `codex-claude/commands/codex-issue.md`

This is the heart of the redesign. Replace the whole file. Frontmatter first, then the loop. Every
step below must appear as concrete instructions (exact commands + branch rules) — no vague prose.

- [ ] **Step 1: Write the frontmatter exactly**

```yaml
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
```

- [ ] **Step 2: Write the loop body** with these sections, verbatim in intent

Author the body so the MAIN AGENT performs each step itself (it has all the tools). Required content:

**Preamble:** "Run the loop for: `$ARGUMENTS`. Parse the leading token as a numeric issue number or
free-text task; honor `--dry-run` and `--base <branch>`. Define `CDX="node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs"`.
Fully autonomous: you make the judgment calls (answering ambiguity from the issue/code, deciding when
a review is clean). The only brakes are `--dry-run` and max review rounds (6)."

**0. Preflight:**
- `$CDX doctor` → if `codexVersion` null or `authPresent` false, ABORT with a clear message.
- Resolve the Plan-mode model: `CONFIG_MODEL=$(node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/config.mjs').then(m=>process.stdout.write(m.readConfiguredModel()||''),()=>{})" 2>/dev/null)`. If neither `--model` nor `$CONFIG_MODEL`, ABORT: "Plan mode needs a model — set `model=\"…\"` in ~/.codex/config.toml."
- Confirm git state; record `START=$(git rev-parse HEAD)`. Require `gh auth status` only on the numeric-issue or non-dry-run paths.

**1. Intake:** numeric → `gh issue view <N> --json number,title,body`; else free text. Create + checkout `codex/issue-<N>` (or `codex/<slug>`).

**2. Mode detection** (state which branch you take — never silent). Run the existing detection from the
old command (preserve it verbatim): scan `.claude/workflows/*.{js,mjs}` for a file that **reads**
`args.noLand` in code (open and confirm, not a comment); check git-tracked; check the
`codex-claude:generic-scaffold` tripwire. Decide:
  - reads `noLand` + numeric issue → **Workflow-engine mode** (dev step uses the repo Workflow).
    Surface the faithfulness banner (name its `meta.phases`) + tracked-ness + the unmodified-scaffold
    warning, exactly as today.
  - workflow exists but none reads `noLand` → say so, nudge `/codex-compose-setup`, use **main-thread mode**.
  - no workflow → **main-thread mode**.

**3. Architect design plan:** dispatch `codex-architect` (Task) with the task text and
`--out .codex/plans/issue-<N>.md`. Parse its first line: `STATUS: DONE` → Read the plan from
`PLAN_PATH`; `STATUS: FAILED` → ABORT (no usable plan; fail loud). Hold the design-plan text as `$DESIGN`.

**4. Claude implementation plan (read-only):** dispatch `codex-planner` (Task, `mode: "plan"`) passing
the issue text + `$DESIGN`. If its message is `STATUS: THIN`, set `$IMPL=$DESIGN`; else `$IMPL` = its
returned markdown. **You (main thread) persist** `$IMPL` to `.codex/plans/issue-<N>.claude.md` with
Write. (Quick substance check: if `$IMPL` < 80 chars or has no file/step, fall back to `$DESIGN`.)

**5. Develop (branch on mode):**
  - **main-thread mode:** implement `$IMPL` yourself, here, by DISCOVERING and RUNNING this repo's own
    development workflow — read `CLAUDE.md`/`AGENTS.md`/`.claude/` process docs/commands/agents — and
    run it as-is, **dispatching its real QA/code-reviewer subagents via `Task`** (you can — you're the
    main thread). Run its review/QA gates, not just tests. Commit on the branch; do NOT push/PR/close.
    A required gate that cannot run (missing credentials/live QA) is a fail-closed BLOCK → stop and report.
  - **Workflow-engine mode:** `Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/codex-wrap.js", args: { issue: <N>, repoWorkflowPath: "<abs matched path>", plan: <$IMPL>, base: "<--base or empty>" } })`.
    On completion: `status:"ready"` → record `branch`/`base_sha`; `status:"danger_landed"` → ABORT with
    the danger message (review bypassed); `status:"failed"` → ABORT with detail.

**6. Architect review:** compute changed files (`git diff --name-only <START or base_sha>..HEAD`).
Dispatch `codex-reviewer` (Task) with `$DESIGN` (re-inlined) + the changed files. Read its last line:
clean ONLY when it is exactly `VERDICT: NO ISSUES`. A clean verdict with no `Reviewed files:`/findings
is thin → nudge once (re-dispatch asking it to list reviewed files first), then accept. `ISSUES FOUND`
or `UNCLEAR` with findings → go to 7.

**7. Address findings (main thread, with full dev context):** invoke the **receiving-code-review**
skill on the findings — verify each against the code, fix only genuine ones, push back (in your report)
on false positives. Re-run the repo's gates the SAME way as step 5 for the mode (main-thread:
dispatch the repo's gate subagents via Task; Workflow-engine: re-run the repo's discoverable gate
commands, and state in the report which path each gate took — determinism is traded for independence
on fixes). Commit the fix delta. Increment the round counter; back to step 6 scoped to the fix delta.
Stop when clean or at max rounds (6) → do NOT push; report outstanding findings.

**8. Finish (skip if `--dry-run`):** preserve the existing landing logic verbatim — pre-finish
landing-state guard (`git ls-remote --heads origin <branch>` empty; issue still OPEN), resolve
`$DEFAULT`/`$BASE` (bare name; `dev` only if on the remote), `git push -u origin <branch>`,
`gh pr create --base "$BASE" --head "$BRANCH" --title "<title>" --body "$(printf 'Closes #%s\n\n%s\n\nArchitect review: clean after %s round(s).' "$N" "$SUMMARY" "$K")"`. Never auto-merge; never close the
issue; flag manual close when `$BASE != $DEFAULT`.

**Final report:** issue/branch; the two plan artifacts; **which dev path ran** (main-thread vs repo
Workflow) and **which gates ran natively vs via dispatched repo subagent**; review rounds + final
verdict; PR URL + whether the issue auto-closes. Report what ACTUALLY happened — never narrate an
intended architecture.

- [ ] **Step 3: Validate frontmatter + that retired agents are gone from the command**

Run: `node -e "const f=require('fs').readFileSync('codex-claude/commands/codex-issue.md','utf8'); if(/codex-orchestrator|codex-developer/.test(f)) throw new Error('still references retired agents'); for(const t of ['codex-architect','codex-planner','codex-reviewer','receiving-code-review','codex-wrap.js']) if(!f.includes(t)) throw new Error('missing '+t); console.log('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add codex-claude/commands/codex-issue.md
git commit -m "codex-claude: rebuild /codex-issue as a main-thread loop (real Task dispatch, plan-mode planner)"
```

---

## Task 7: Update the skill's orchestration section

**Files:**
- Modify: `codex-claude/skills/codex-claude/SKILL.md`

- [ ] **Step 1: Replace the "Full-issue orchestration (autonomous)" section**

Replace its body (the `codex-orchestrator`/`codex-developer` description and the old flow) with a
description of the MAIN-THREAD loop that points at the command as the source of truth. Required points:
- `/codex-issue <#|task>` runs the loop **in the main thread** (it has `Task`, Plan mode, the repo's
  real subagents). Codex is driven by thin agents: `codex-architect` (design plan), `codex-planner`
  (read-only impl plan, `mode:plan`, returns text), `codex-reviewer` (review). Development + fixes are
  main-thread, so the repo's own QA/review subagents run for real; fixes use `receiving-code-review`.
- All Codex sessions are **ephemeral**; the persisted plan is re-inlined into reviews (no persistent
  daemon). 
- **Workflow-mode repos:** when the repo's lifecycle is a composable Workflow (reads `args.noLand`),
  development runs that Workflow (noLand) via `workflows/codex-wrap.js` as the engine; everything else
  stays main-thread. Falls back to main-thread development when no composable workflow is present.
- Keep the verb reference, the manual loop, and the troubleshooting sections unchanged. Remove the
  bullet list describing `codex-orchestrator`/`codex-developer`.

- [ ] **Step 2: Verify no stale references remain**

Run: `grep -n "codex-orchestrator\|codex-developer\|black-box developer\|replayed inline" codex-claude/skills/codex-claude/SKILL.md || echo "CLEAN"`
Expected: `CLEAN`

- [ ] **Step 3: Commit**

```bash
git add codex-claude/skills/codex-claude/SKILL.md
git commit -m "codex-claude: skill describes the main-thread loop; drop nested-subagent orchestration"
```

---

## Task 8: Wording updates (doctor, compose-setup, WORKFLOW-MODE, template)

**Files:**
- Modify: `codex-claude/commands/codex-doctor.md`
- Modify: `codex-claude/commands/codex-compose-setup.md`
- Modify: `codex-claude/docs/WORKFLOW-MODE.md`
- Modify: `codex-claude/templates/implement-issue.template.js`

- [ ] **Step 1: Edit each for accuracy** (mechanics unchanged — only the narrative)

- `codex-doctor.md`: keep the mode preflight (it still detects Workflow-engine vs main-thread). Remove
  any sentence implying an orchestrator/developer subagent runs the loop; say "the loop runs in the
  main thread; composition runs the repo Workflow as the dev engine."
- `codex-compose-setup.md`: reframe composition as "make your repo's Workflow the **development
  engine** for `/codex-issue` (it runs with `noLand`, bracketed by Codex in the main thread)" instead
  of "wrap from outside." The `noLand` seam contract is unchanged.
- `docs/WORKFLOW-MODE.md`: update the architecture narrative — the main thread brackets; `codex-wrap.js`
  is now only the noLand runner; the architect plan/review/fix are main-thread. Keep the `noLand`
  contract + `ready_to_land` terminal requirement.
- `templates/implement-issue.template.js`: the `noLand` contract is unchanged; align any comment that
  references the wrapper "planning/reviewing" (it no longer does — it just runs the repo workflow).

- [ ] **Step 2: Verify the noLand contract docs still state `ready_to_land`**

Run: `grep -rn "ready_to_land\|noLand" codex-claude/docs/WORKFLOW-MODE.md codex-claude/templates/implement-issue.template.js | head`
Expected: still present (the contract is preserved).

- [ ] **Step 3: Commit**

```bash
git add codex-claude/commands/codex-doctor.md codex-claude/commands/codex-compose-setup.md codex-claude/docs/WORKFLOW-MODE.md codex-claude/templates/implement-issue.template.js
git commit -m "codex-claude: docs reflect main-thread loop + composition-as-dev-engine"
```

---

## Task 9: Full suite + end-to-end validation against the reported bug

**Files:** none new (validation only).

- [ ] **Step 1: Run the whole Node suite**

Run: `cd codex-claude && npm test`
Expected: all green (incl. `wrap-terminal.test.mjs`).

- [ ] **Step 2: Static plugin sanity**

Run: `grep -rn "codex-orchestrator\|codex-developer" codex-claude --include=*.md --include=*.js | grep -v docs/specs | grep -v docs/plans || echo "NO STALE REFS"`
Expected: `NO STALE REFS` (specs/plans may mention them historically).

- [ ] **Step 3: End-to-end on `mathkit-codex-test` (the exact reported scenario)**

In a checkout of `../mathkit-codex-test` at the reported commit (no `.claude/workflows/` → main-thread
mode), run `/codex-issue <an open issue #> --dry-run`. Assert, by watching the run:
  1. A `codex-architect` dispatch produces `.codex/plans/issue-N.md`.
  2. A `codex-planner` (`mode:plan`) dispatch produces `.codex/plans/issue-N.claude.md`.
  3. During development, the repo's **independent QA subagent is actually dispatched via `Task`**
     (visible in the run) — NOT replayed inline.
  4. `codex-reviewer` runs and returns a last-line `VERDICT:`.
  5. The final report names the **real** path (main-thread development + which gates ran via dispatched
     subagent) and does NOT claim a black-box developer.
  6. `--dry-run` stops before push/PR.

Record the observations. If any assertion fails, file the gap and fix in the relevant task before merge.

- [ ] **Step 4: Commit any fixups, then finish the branch**

```bash
git add -A && git commit -m "codex-claude: e2e validation fixups" || true
```

Then use **superpowers:finishing-a-development-branch** to decide merge/PR.

---

## Self-review notes (author)

- **Spec coverage:** retire orchestrator/developer (T1) ✓; codex-architect (T2) ✓; codex-planner
  read-only/returns-text (T3) ✓; reviewer structured + drop Grep/Glob (T4) ✓; shrink codex-wrap +
  tested classifier (T5) ✓; main-thread loop incl. mode branch, plan-mode planner, receiving-code-review,
  finish (T6) ✓; skill section (T7) ✓; wording incl. determinism/independence note (T8) ✓; E2E that
  asserts visible QA dispatch closes F2 against the exact scenario (T9) ✓.
- **Placeholders:** none — each markdown task gives full file content or an exact, command-level step
  list; the JS task is full TDD.
- **Naming consistency:** `classifyRepoResult` (T5 helper + inlined mirror) identical; plan paths
  `.codex/plans/issue-<N>.md` / `.claude.md` consistent T3/T6; verdict last-line rule identical T4/T6;
  `status:"ready"|"danger_landed"|"failed"` identical T5/T6.
```
