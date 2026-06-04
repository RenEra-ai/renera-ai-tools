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
  // Asked for noLand but did NOT return ready_to_land → caller must check whether it landed anyway.
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
