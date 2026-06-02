// Starter "implement one GitHub issue" workflow, scaffolded by /codex-compose-setup.
// Minimal and repo-agnostic: it DISCOVERS this repo's test/QA command (no runner is assumed) and is
// already composition-ready — it honors the codex-claude `noLand` contract (returns `ready_to_land`
// before landing) so /codex-issue can wrap it with a Codex architect plan + review.
// Grow it freely: add your own code-review / QA / lint steps between Implement and Land.
export const meta = {
  name: 'implement-issue',
  description: 'Implement one GitHub issue: developer brings the repo\'s own tests green, commit, then land (push + PR) — unless noLand. Fail-closed.',
  phases: [{ title: 'Preflight' }, { title: 'Implement' }, { title: 'Land' }],
}

// Inputs. `noLand` and `plan` are the codex-claude composition contract.
const ISSUE = args && typeof args === 'object' ? args.issue : args
const DRY_RUN = !!(args && typeof args === 'object' && args.dryRun)
const NO_LAND = !!(args && typeof args === 'object' && args.noLand)
const PLAN = (args && typeof args === 'object' && typeof args.plan === 'string') ? args.plan : ''
if (ISSUE == null || !/^\d+$/.test(`${ISSUE}`.trim())) {
  throw new Error('implement-issue: pass a NUMERIC GitHub issue number, e.g. {issue: 3} (optionally {dryRun:true} or {noLand:true, plan:"..."})')
}
const shellQuote = (s) => `'` + String(s).replace(/'/g, `'\\''`) + `'`

const OPS = { type: 'object', additionalProperties: false, required: ['ok', 'detail'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } }
const PRE = { type: 'object', additionalProperties: false, required: ['ok', 'reason', 'issue_state', 'issue_title', 'base_sha', 'branch', 'pre_untracked'], properties: { ok: { type: 'boolean' }, reason: { type: 'string' }, issue_state: { type: 'string' }, issue_title: { type: 'string' }, base_sha: { type: 'string' }, branch: { type: 'string' }, pre_untracked: { type: 'array', items: { type: 'string' } } } }
const VERIFY = { type: 'object', additionalProperties: false, required: ['green', 'detail', 'untracked_pre_test'], properties: { green: { type: 'boolean' }, detail: { type: 'string' }, untracked_pre_test: { type: 'array', items: { type: 'string' } } } }

const report = { issue: ISSUE, branch: null, base_sha: null, terminal: null }

phase('Preflight')
const pf = await agent(
  `PREFLIGHT for implementing GitHub issue #${ISSUE} in this git repo.${DRY_RUN ? ' DRY RUN: compute the branch name you WOULD use but do NOT create or switch branches.' : ''}
1. Working tree must be clean of TRACKED changes (so pre-existing work isn't swept into the commit): if \`git status --porcelain --untracked-files=no\` is NON-empty, set ok=false, reason="dirty_tree" and stop.
2. pre_untracked = the currently-UNTRACKED files (\`git ls-files --others --exclude-standard\`), one path per array entry ([] if none). These pre-existing files must NOT be swept into the issue commit.
3. \`gh issue view ${ISSUE} --json state,title\` -> issue_state ("OPEN"/"CLOSED"), issue_title.
4. base_sha = the CURRENT commit BEFORE creating any branch: \`git rev-parse HEAD\`.
5. branch = "issue-${ISSUE}-<slug>" (issue title slugified to kebab-case, <=40 chars). ${DRY_RUN ? 'DRY RUN: do NOT create it.' : 'If issue_state=="OPEN" and the branch does not exist (\`git rev-parse --verify <branch>\` fails), create + checkout it: \`git switch -c <branch>\`. If it already exists, ok=false, reason="branch_exists".'}
Set ok=true only if the tree is clean AND issue_state=="OPEN"${DRY_RUN ? '' : ' AND the branch is now active'}. reason on failure: dirty_tree | issue_not_open | branch_exists | error. Report every field.`,
  { label: `preflight #${ISSUE}`, phase: 'Preflight', schema: PRE },
)
if (!pf || !pf.ok) { report.terminal = `preflight_${(pf && pf.reason) || 'failed'}`; log(`FAIL: ${report.terminal}`); return report }
report.branch = pf.branch
report.base_sha = pf.base_sha
if (DRY_RUN) { report.terminal = 'dry_run_ok'; log(`DRY RUN ok: would use branch ${pf.branch} (base ${pf.base_sha}).`); return report }

phase('Implement')
let green = false
let implUntracked = []
for (let attempt = 1; attempt <= 3 && !green; attempt++) {
  await agent(
    `Implement GitHub issue #${ISSUE} ("${pf.issue_title}") in this repo. Read the full issue first: \`gh issue view ${ISSUE}\`. Follow THIS repo's conventions (its CLAUDE.md / AGENTS.md). Add or adjust the relevant tests. Do NOT commit — the pipeline commits your changes (tracked edits + the new source files you write), so write every change needed for the tests to pass to disk.${PLAN ? `\n\nAn architect proposed this plan — follow it where sound, deviate only with a stated reason:\n${PLAN}` : ''}${attempt > 1 ? '\n\nThe previous attempt was not green — diagnose the failures and fix them minimally.' : ''}`,
    { label: `dev #${ISSUE}.${attempt}`, phase: 'Implement' },
  )
  const v = await agent(
    `READ-ONLY verification. FIRST, BEFORE running anything else, capture the currently-untracked files: \`git ls-files --others --exclude-standard\` -> untracked_pre_test (one path per entry; [] if none) — this snapshots the implementation's NEW files BEFORE the test command can create artifacts. THEN DISCOVER this repo's test/QA command from its CLAUDE.md / AGENTS.md / README (do NOT assume any specific test runner), run it, and report: green = true only if it passed with zero failures/errors; detail = the exact command you ran + the last ~6 lines. Do NOT edit, stage, or commit.`,
    { label: `verify #${ISSUE}.${attempt}`, phase: 'Implement', schema: VERIFY },
  )
  green = !!(v && v.green)
  if (green) implUntracked = (v && v.untracked_pre_test) || []
  else report.terminal = 'tests_not_green'
}
if (!green) { log(`FAIL: tests_never_green`); return report }

phase('Land')
const safeTitle = String(pf.issue_title || '').replace(/["`$\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60)
// Stage exactly the implementation: all tracked edits (git add -u) + the new SOURCE files the developer
// wrote (captured BEFORE the test command ran, minus anything already untracked at preflight). This is
// complete (no under-staging) yet never sweeps pre-existing untracked work OR test artifacts (which are
// created during the test run, after the untracked_pre_test snapshot).
const preSet = new Set(pf.pre_untracked || [])
const newFiles = implUntracked.filter((p) => !preSet.has(p))
const addNew = newFiles.length ? `git add -- ${newFiles.map(shellQuote).join(' ')}\n` : ''
const commit = await agent(
  `Commit ONLY the implementation (tracked edits + the new source files staged below) — NOT test artifacts or pre-existing untracked files. Run EXACTLY this, then report ok/detail (ok=true only if every command exited 0):\n\`\`\`bash\nset -e\ngit reset -q                    # clear the index first, so nothing staged earlier (e.g. a stray git add) is committed\ngit add -u                      # tracked edits\n${addNew}git commit -m "#${ISSUE}: ${safeTitle}"\ntest -z "$(git status --porcelain --untracked-files=no)"  # all tracked changes are committed (completeness)\ngit log --oneline -1\n\`\`\`\nIf nothing is staged the commit exits non-zero — report ok=false.`,
  { label: `commit #${ISSUE}`, phase: 'Land', schema: OPS },
)
if (!commit || !commit.ok) { report.terminal = 'commit_failed'; report.detail = commit && commit.detail; return report }

// ── codex-claude composition seam: return BEFORE landing when noLand is set ───
if (NO_LAND) {
  report.terminal = 'ready_to_land'
  report.ready = true
  log(`READY_TO_LAND: #${ISSUE} on ${report.branch}; landing deferred to the caller.`)
  return report
}

const land = await agent(
  `Run EXACTLY this, then report ok/detail (ok=true only if every command exited 0):\n\`\`\`bash\nset -e\ngit push -u origin ${report.branch}\nBASE=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)\ngh pr create --base "$BASE" --head ${report.branch} --title "#${ISSUE}: ${safeTitle}" --body "Closes #${ISSUE}"\n\`\`\`\nNever auto-merge. Do NOT close the issue (the PR's Closes #N closes it on a default-branch merge).`,
  { label: `land #${ISSUE}`, phase: 'Land', schema: OPS },
)
report.terminal = (land && land.ok) ? 'success' : 'land_failed'
report.detail = land && land.detail
return report
