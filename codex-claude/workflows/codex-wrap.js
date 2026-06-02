export const meta = {
  name: 'codex-wrap',
  description: "Wrap a repo's own no-land workflow with a Codex architect plan + review-until-clean loop, then land. For workflow-mode repos: runs the repo's real pipeline (gates intact) bracketed by Codex architect plan/review.",
  phases: [
    { title: 'Architect plan' },
    { title: 'Repo workflow' },
    { title: 'Architect review' },
    { title: 'Land' },
  ],
}

// args (passed by the /codex-issue command from the main thread):
//   { issue, repoWorkflowPath, pluginRoot, base?, dryRun?, maxRounds? }
const ISSUE = args && args.issue
const REPO_WF = args && args.repoWorkflowPath
const PLUGIN = args && args.pluginRoot
const BASE_ARG = (args && args.base) || ''
const DRY = !!(args && args.dryRun)
const MAX_ROUNDS = (args && args.maxRounds) || 6
if (!ISSUE || !REPO_WF || !PLUGIN) {
  throw new Error('codex-wrap: need args.issue, args.repoWorkflowPath, and args.pluginRoot')
}

const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'planText'],
  properties: { status: { type: 'string' }, planText: { type: 'string' } },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['NO ISSUES', 'ISSUES FOUND', 'UNCLEAR'] },
    reviewedFiles: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['file', 'issue', 'fix'],
      properties: { file: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' } },
    } },
  },
}
const OPS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'detail'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } },
}
const LAND_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['ok', 'prUrl', 'base', 'autoClose', 'note'],
  properties: {
    ok: { type: 'boolean' }, prUrl: { type: 'string' }, base: { type: 'string' },
    autoClose: { type: 'boolean' }, note: { type: 'string' },
  },
}

// ── 1. Architect plan (ephemeral Codex Plan-mode session) ─────────────────────
phase('Architect plan')
const plan = await agent(
  `Produce a Codex architect plan for GitHub issue #${ISSUE} in this repo.
Steps:
1. \`gh issue view ${ISSUE} --json title,body\` to read the issue.
2. Build the plan prompt text — "Architect a concrete, file-by-file plan for issue #${ISSUE} (title+body below). Inspect the relevant files. Do not change anything." followed by the issue title+body — and WRITE it to a temp file using the Write tool. Do NOT put the issue text in the shell command (it may contain backticks/$()/quotes).
3. Run the ephemeral Plan-mode driver (boots a private Codex daemon, plans, prints the plan after a '=== PLAN ===' line):
   node ${PLUGIN}/scripts/plan-round.mjs --prompt-file <that temp file>
4. If STATUS is not 'completed' OR the plan body is empty/(empty), rebuild the prompt file with a nudge ("emit the full plan as plain text now; do not stop after the reasoning preamble") and run ONCE more.
Return: status = the STATUS line value (e.g. 'completed'); planText = the full plan text printed after '=== PLAN ==='.`,
  { label: `plan #${ISSUE}`, phase: 'Architect plan', schema: PLAN_SCHEMA },
)
if (!plan || plan.status !== 'completed' || !plan.planText || !plan.planText.trim() || plan.planText.trim() === '(empty)') {
  return { status: 'failed', stage: 'architect-plan', detail: 'architect produced no usable plan' }
}
log(`architect plan captured (${plan.planText.length} chars)`)

// ── 2. Run the repo's OWN workflow with land suppressed ───────────────────────
phase('Repo workflow')
const repo = await workflow({ scriptPath: REPO_WF }, { issue: ISSUE, noLand: true, plan: plan.planText })
if (!repo || repo.terminal !== 'ready_to_land' || !repo.branch || !repo.base_sha) {
  return { status: 'failed', stage: 'repo-workflow', detail: (repo && (repo.terminal || JSON.stringify(repo))) || 'no result', repo }
}
const BRANCH = repo.branch
const REPO_BASE = repo.base_sha
log(`repo workflow ready-to-land on ${BRANCH} (base ${REPO_BASE})`)

// ── 3. Architect review → fix (via the repo's own developer) → re-review ──────
phase('Architect review')
let round = 0
let inconclusiveRetries = 0
let rubberStampNudged = false   // GAP 2: at most one anti-rubber-stamp nudge for the whole loop
let verdict = 'UNCLEAR'
let findings = []
while (round < MAX_ROUNDS) {
  const review = await agent(
    `${rubberStampNudged ? "NUDGE: your previous review returned a clean verdict with NO substance (no findings, no reviewed files). This time you MUST FIRST list the exact files you actually inspected (return them in reviewedFiles), THEN give the verdict. A clean verdict with an empty reviewedFiles list will not be accepted.\n\n" : ''}Run a Codex architect review of the implementation on branch ${BRANCH} against the APPROVED PLAN (shown at the end).
Steps:
1. Changed files: \`git diff --name-only ${REPO_BASE}...HEAD\`.
2. Build the review prompt text — "Review the implementation against the plan below, then inspect the changed files on disk: <the changed files>. List concrete issues as file:line with a fix. END with a verdict on its OWN FINAL line, with NOTHING after it: exactly 'VERDICT: NO ISSUES' or 'VERDICT: ISSUES FOUND'." followed by the PLAN text — and WRITE it to a temp file using the Write tool. Do NOT put it in the shell command (it may contain backticks/$()/quotes).
3. Run the ephemeral review driver (it prints a deterministic 'PARSED_VERDICT:' line, then the raw review after '=== REVIEW ==='):
   node ${PLUGIN}/scripts/review-round.mjs --prompt-file <that temp file>
4. Read the driver's 'PARSED_VERDICT:' line (NO ISSUES | ISSUES FOUND | UNCLEAR) as the verdict; collect any file:line findings from the '=== REVIEW ===' body.
Return verdict, reviewedFiles, and findings[].

--- PLAN ---
${plan.planText}`,
    { label: `arch-review #${ISSUE} r${round + 1}`, phase: 'Architect review', schema: REVIEW_SCHEMA },
  )
  verdict = review ? review.verdict : 'UNCLEAR'
  findings = (review && review.findings) || []
  const reviewedCount = (review && review.reviewedFiles && review.reviewedFiles.length) || 0
  if (verdict === 'NO ISSUES' && findings.length === 0) {
    // GAP 2 — no rubber stamps (mirrors codex-orchestrator.md). A clean verdict with no findings AND
    // no reviewedFiles is a thin signal. Nudge exactly ONCE for the whole loop (no round++, no fix
    // dispatched) to make the architect list the files it reviewed, then re-review once; if still
    // substance-free, accept clean (no infinite loop).
    if (reviewedCount === 0 && !rubberStampNudged) {
      rubberStampNudged = true
      log('architect review clean but substance-free — nudging once to list reviewed files, then re-reviewing')
      continue
    }
    break
  }
  // A 'NO ISSUES' verdict that nonetheless lists findings is self-contradictory — never land on it.
  // It is not clean-with-no-findings (handled above), so it falls through to the fix path below
  // (findings.length > 0), where the listed issues are fixed and re-reviewed like any other.
  if (findings.length === 0) {
    // No concrete findings to act on (UNCLEAR, or 'ISSUES FOUND' with an empty list). Never dispatch an
    // empty fix — re-review ONCE; if still inconclusive, surface it instead of spinning to MAX_ROUNDS.
    if (inconclusiveRetries >= 1) {
      return { status: 'review_unclear', rounds: round, verdict, detail: 'architect review returned no actionable findings — needs a human look' }
    }
    inconclusiveRetries++
    log(`architect review inconclusive (verdict=${verdict}, no findings) — re-reviewing once`)
    continue
  }
  inconclusiveRetries = 0
  // ── Fix + re-run the repo's REAL gates on the fix delta, then commit (GAP 1) ──
  // One merged agent owns the whole discipline so an un-reviewed change can't leak between a separate
  // "fix" and "verify". It (a) DISCOVERS this repo's dev/review process from the SAME places the
  // subagent-mode developer does, (b) APPLIES the fix that way, (c) RE-RUNS the repo's OWN review/QA
  // gate(s) on the delta — dispatching the repo's review/QA agent(s) via Task and looping until clean,
  // exactly as the repo's workflow would — (d) runs the repo's tests, and commits ONLY if all green.
  // OPS_SCHEMA: ok=true only when fix + repo review gate(s) + tests are green and committed. A required
  // gate that CANNOT run is fail-closed (GAP 3): ok=false, detail begins "BLOCKED: ".
  const v = await agent(
    `Fix these Codex architect findings on branch ${BRANCH}, then re-run THIS repo's OWN review/QA discipline on the fix, exactly as its workflow would, and commit ONLY if everything is green.

STEP A — DISCOVER this repo's development AND review process (do NOT assume it is "just run the tests"). Read every place it may be defined: CLAUDE.md, AGENTS.md, .claude/CLAUDE.md (root + nearest ancestor); .claude/*.md process docs (PIPELINE.md / WORKFLOW.md / CONTRIBUTING.md); .claude/commands/* (esp. an implement/issue/develop command); .claude/agents/* (repo-defined developer / code-reviewer / QA / tester agents); .claude/settings.json hooks; README/CONTRIBUTING. Synthesize the repo's definition-of-done: its required REVIEW/QA gate(s) AND its test/QA command.

STEP B — APPLY the fix the repo's way. If it defines a developer agent or a documented dev procedure, follow that (dispatch the repo's developer agent via the Task tool if one exists); otherwise implement the fix directly per its CLAUDE.md. Apply receiving-code-review discipline: verify each finding, fix only what is genuinely wrong, push back on the rest.

STEP C — RE-RUN the repo's OWN review/QA gate(s) on the FIX DELTA, looping until they report clean, just as the repo's workflow does. If the repo defines a code-reviewer / QA / tester agent (e.g. in .claude/agents/*), DISPATCH IT VIA THE Task TOOL on the changed files and loop developer<->reviewer/QA until that gate reports clean (cap as the repo caps it, or at 3 rounds). If the gate is a command/script, run it until it passes. Do NOT substitute "the tests passed" for the review/QA gate — it is a SEPARATE required step. If the Task tool cannot dispatch the repo's review/QA agent (unavailable here or dispatch fails): the inline fallback applies ONLY to a gate whose discipline can be FULLY judged from the changed files on disk (e.g. a static code-reviewer) — read that agent's instructions/criteria from the discovered docs and apply them inline to the changed files, and run any review/QA command the repo defines. But if the required gate must actually EXECUTE — a live/integration/QA gate that needs credentials, tokens, network, or a live account (it cannot be judged from a diff) — and you can neither dispatch it nor run it for real, do NOT inline-fake it: that is BLOCKED per STEP F (ok=false, detail begins "BLOCKED: "). Never downgrade a missing review gate into "tests passed", and never substitute a paper read for a live gate that never ran.

STEP D — RUN the repo's discovered test/QA command (do NOT assume \`pytest\`) and confirm it passes.

STEP E — GATE + commit. If AND ONLY IF the repo's review/QA gate(s) reported clean (Step C) AND tests are green (Step D): \`git add -A && git commit -m\` with a short one-line message (no "Claude Code"), then return ok=true. In detail, name which repo review gate(s)/agent(s) you ran and ECHO the exact test command + last lines of its output.

STEP F — FAIL CLOSED (do not commit, do not land). Return ok=false if: any finding could not be genuinely resolved; the repo's review/QA gate still reports issues after its loop cap; tests are not green; OR a REQUIRED gate CANNOT RUN — e.g. a live QA/integration agent whose prerequisites are absent (missing credentials/tokens/env, no network, a tester agent that reports BLOCKED). A gate that cannot run is BLOCKED, never "skip and pass": set ok=false and start detail with "BLOCKED: " naming the gate and why. Never report ok=true with a skipped or BLOCKED required gate.
Findings:\n${JSON.stringify(findings, null, 2)}`,
    { label: `arch-fix #${ISSUE} r${round + 1}`, phase: 'Architect review', schema: OPS_SCHEMA },
  )
  if (!v || !v.ok) {
    return { status: 'not_clean', stage: 'architect-fix', detail: (v && v.detail) || 'fix did not pass the repo\'s own review/QA gate or tests', round: round + 1, findings }
  }
  round++
}
if (verdict !== 'NO ISSUES' || findings.length > 0) {
  // Land ONLY on a genuinely clean final review (clean verdict AND no outstanding findings). A clean
  // break (line ~118) always has findings === [], so the happy path proceeds; loop exhaustion with a
  // trailing contradictory 'NO ISSUES'-with-findings verdict correctly falls here, not into Land.
  return { status: 'not_clean', stage: 'architect-review', rounds: round, verdict, findings }
}
log(`architect review clean after ${round} fix round(s)`)

// ── 4. Land — push + PR (default-branch aware; never closes the issue) ────────
phase('Land')
if (DRY) {
  log('DRY RUN: stopping before push/PR.')
  return { status: 'dry_run_clean', branch: BRANCH, rounds: round, plan: plan.planText.slice(0, 400) }
}
const land = await agent(
  `Land branch ${BRANCH} for issue #${ISSUE}.
1. DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name).
2. Resolve BASE (a BARE branch name, never origin/...): ${BASE_ARG ? `BASE="${BASE_ARG}"` : 'if `git ls-remote --heads origin dev` returns a line then BASE="dev", else BASE="$DEFAULT"'}.
3. Squash to one commit (the repo's one-commit-per-issue convention): \`git reset --soft ${REPO_BASE} && git commit -m "#${ISSUE}: <short issue title, no 'Claude Code'>"\`.
4. \`git push -u origin ${BRANCH}\`.
5. \`gh pr create --base "$BASE" --head ${BRANCH} --title "<issue title>" --body "$(printf 'Closes #%s\\n\\n%s' "${ISSUE}" "<one-line summary>")"\` — capture the PR URL.
6. Do NOT close the issue. autoClose = (BASE == DEFAULT). If BASE != DEFAULT, note that issue #${ISSUE} must be closed manually (Closes #N only auto-closes on a default-branch merge). Never auto-merge.
Return ok, prUrl, base, autoClose, note.`,
  { label: `land #${ISSUE}`, phase: 'Land', schema: LAND_SCHEMA },
)
if (!land || !land.ok) {
  return { status: 'land_failed', branch: BRANCH, detail: (land && land.note) || 'push/PR failed' }
}
return {
  status: 'success', branch: BRANCH, prUrl: land.prUrl, base: land.base,
  rounds: round, issueAutoCloses: land.autoClose, note: land.note,
}
