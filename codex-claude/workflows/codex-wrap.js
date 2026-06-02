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
2. Run the ephemeral Plan-mode driver (it boots its own private Codex daemon, plans, and prints the plan after a '=== PLAN ===' line):
   node ${PLUGIN}/scripts/plan-round.mjs "Architect a concrete, file-by-file plan for issue #${ISSUE}: <paste the issue title+body>. Inspect the relevant files. Do not change anything."
3. If STATUS is not 'completed' OR the plan body is empty/(empty), run it ONCE more with an explicit nudge appended ("emit the full plan as plain text now").
Return: status = the STATUS line value; planText = the full plan text printed after '=== PLAN ==='.`,
  { label: `plan #${ISSUE}`, phase: 'Architect plan', schema: PLAN_SCHEMA },
)
if (!plan || !plan.planText || !plan.planText.trim() || plan.planText.trim() === '(empty)') {
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
let verdict = 'UNCLEAR'
let findings = []
while (round < MAX_ROUNDS) {
  const review = await agent(
    `Run a Codex architect review of the implementation on branch ${BRANCH} against the APPROVED PLAN below.
Steps:
1. Changed files: \`git diff --name-only ${REPO_BASE}...HEAD\`.
2. Run the ephemeral review driver (it prints a deterministic 'PARSED_VERDICT:' line, then the raw review after '=== REVIEW ==='):
   node ${PLUGIN}/scripts/review-round.mjs "Review the implementation against this plan, then inspect the changed files on disk: <list>. List concrete issues as file:line with a fix. END with a verdict on its OWN final line: exactly 'VERDICT: NO ISSUES' or 'VERDICT: ISSUES FOUND'. PLAN:\n${plan.planText}"
3. Read the driver's 'PARSED_VERDICT:' line (NO ISSUES | ISSUES FOUND | UNCLEAR) as the verdict; collect any file:line findings from the '=== REVIEW ===' body.
Return verdict, reviewedFiles, and findings[].`,
    { label: `arch-review #${ISSUE} r${round + 1}`, phase: 'Architect review', schema: REVIEW_SCHEMA },
  )
  verdict = review ? review.verdict : 'UNCLEAR'
  findings = (review && review.findings) || []
  if (verdict === 'NO ISSUES') break
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
  // Fix via the REPO's own developer agent (its conventions + receiving-code-review discipline).
  await agent(
    `Fix these Codex architect findings on branch ${BRANCH}, following THIS repo's CLAUDE.md and conventions (apply its receiving-code-review discipline; keep its tests/QA green). Do NOT commit, push, or open a PR. Findings:\n${JSON.stringify(findings, null, 2)}`,
    { label: `arch-fix #${ISSUE} r${round + 1}`, phase: 'Architect review', agentType: 'developer' },
  )
  const v = await agent(
    `Verify and commit the architect fix on branch ${BRANCH}. First DISCOVER this repo's test/QA command from its CLAUDE.md / AGENTS.md / .claude workflow (do NOT assume \`pytest\`); run it and confirm it passes. If green, \`git add -A && git commit -m\` with a short one-line message (no "Claude Code"). If not green, set ok=false. In detail, ECHO the exact command you ran plus the last lines of its output.`,
    { label: `arch-verify #${ISSUE} r${round + 1}`, phase: 'Architect review', schema: OPS_SCHEMA },
  )
  if (!v || !v.ok) {
    return { status: 'not_clean', stage: 'architect-fix', detail: (v && v.detail) || 'fix did not pass repo verification', round: round + 1, findings }
  }
  round++
}
if (verdict !== 'NO ISSUES') {
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
