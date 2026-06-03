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
const LANDCHK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['landed', 'detail'], properties: { landed: { type: 'boolean' }, detail: { type: 'string' } },
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
2. Build the plan prompt text — "Architect a concrete, file-by-file plan for issue #${ISSUE} (title+body below). Inspect the relevant files. Honor this repo's own conventions in CLAUDE.md / AGENTS.md (e.g. no new dependencies, minimal diff, scope discipline) — do not propose anything that violates them. Do not change anything." followed by the issue title+body — and WRITE it to a temp file using the Write tool. Do NOT put the issue text in the shell command (it may contain backticks/$()/quotes).
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
  // The repo workflow was asked for noLand but did NOT return ready_to_land. Distinguish a clean,
  // no-mutation fail-closed from a DANGEROUS contract violation where it landed anyway (pushed/PR'd/
  // closed the issue despite noLand:true) — that would have BYPASSED the architect review.
  const landed = await agent(
    `The repo workflow for issue #${ISSUE} was called with noLand:true but did NOT return ready_to_land. Determine whether it nevertheless ALREADY LANDED (a noLand-contract violation): check \`gh pr list --search "${ISSUE} in:body" --state all --json number,url\` for a PR referencing this issue, and \`gh issue view ${ISSUE} --json state\` (the issue was OPEN when this run started). Set landed=true if a PR for this issue now exists OR the issue is CLOSED; else landed=false. In detail, give the PR url and the issue state.`,
    { label: `land-check #${ISSUE}`, phase: 'Repo workflow', schema: LANDCHK_SCHEMA },
  )
  if (landed && landed.landed) {
    return { status: 'danger_landed_despite_noland', stage: 'repo-workflow', detail: `DANGER: repo workflow landed despite noLand:true — the architect review was BYPASSED. ${landed.detail || ''}`, repo }
  }
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
1. Changed files (two-dot, the direct base→HEAD delta): \`git diff --name-only ${REPO_BASE}..HEAD\`.
2. Build the review prompt text — "Review the implementation against the plan below, then inspect the changed files on disk: <the changed files>. Judge it against this repo's own conventions in CLAUDE.md / AGENTS.md — do NOT raise findings that would violate them (e.g. demanding a new dependency the repo forbids). List concrete issues as file:line with a fix. END with a verdict on its OWN FINAL line, with NOTHING after it: exactly 'VERDICT: NO ISSUES' or 'VERDICT: ISSUES FOUND'." followed by the PLAN text — and WRITE it to a temp file using the Write tool. Do NOT put it in the shell command (it may contain backticks/$()/quotes).
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
  // gate(s) on the delta — this agent is itself a subagent and CANNOT nest Task, so a gate that is a
  // command/script is run NATIVELY via Bash and a gate that is a repo-defined SUBAGENT is REPLAYED
  // INLINE from its .md (a live/credentialed gate it can't run is BLOCKED) — (d) runs the repo's tests,
  // and commits ONLY if all green. OPS_SCHEMA: ok=true only when fix + repo review gate(s) + tests are
  // green and committed. A required gate that CANNOT run is fail-closed (GAP 3): ok=false, detail begins "BLOCKED: ".
  const v = await agent(
    `Fix these Codex architect findings on branch ${BRANCH}, then re-run THIS repo's OWN review/QA discipline on the fix, exactly as its workflow would, and commit ONLY if everything is green.

STEP A — DISCOVER this repo's development AND review process (do NOT assume it is "just run the tests"). Read every place it may be defined: CLAUDE.md, AGENTS.md, .claude/CLAUDE.md (root + nearest ancestor); .claude/*.md process docs (PIPELINE.md / WORKFLOW.md / CONTRIBUTING.md); .claude/commands/* (esp. an implement/issue/develop command); .claude/agents/* (repo-defined developer / code-reviewer / QA / tester agents); .claude/settings.json hooks; README/CONTRIBUTING. Synthesize the repo's definition-of-done: its required REVIEW/QA gate(s) AND its test/QA command.

STEP B — FIRST assert a clean tracked tree at handoff (the repo workflow returned ready_to_land, so its work is committed): if \`git status --porcelain --untracked-files=no\` is NON-empty, do NOT proceed — return ok=false with detail beginning "BLOCKED: dirty tracked tree at fix handoff" (a pre-existing tracked modification must not be swept into the fix commit by STEP E's \`git add -u\`). THEN snapshot the pre-existing untracked files to a SCRATCH FILE that survives across separate Bash calls (a shell variable would NOT persist — you run later steps in new shells): \`git ls-files --others --exclude-standard > .git/codex-wrap-pre.txt\` (\`.git/\` is never committed). STEP E excludes these so pre-existing untracked files aren't swept into the squash. THEN apply the fix the repo's way: follow the repo's documented dev procedure / its developer agent's discipline (you can't Task-dispatch that agent — apply its rules directly), otherwise implement the fix per its CLAUDE.md. Apply receiving-code-review discipline: verify each finding, fix only what is genuinely wrong, push back on the rest.

STEP C — RE-RUN the repo's OWN review/QA gate(s) on the FIX DELTA, looping until they report clean, just as the repo's workflow does. NOTE: you are a subagent and CANNOT dispatch another subagent (the Task tool cannot spawn the repo's review/QA agent from here), so run each gate the best way you actually can — and report which way (STEP E): (a) a review/QA gate that is a COMMAND or SCRIPT — run it via Bash until it passes ("natively run"); (b) a gate that is a repo-defined SUBAGENT (e.g. .claude/agents/code-reviewer.md) — you cannot dispatch it, so REPLAY IT INLINE: read that agent's instructions/criteria and apply them to the changed files, looping fix<->review until clean (cap as the repo caps it, or at 3 rounds) ("replayed inline"); (c) a gate that must EXECUTE LIVE — a QA/integration agent needing credentials, tokens, network, or a live account that you can neither run nor judge from a diff → do NOT inline-fake it: that is BLOCKED per STEP F (ok=false, detail begins "BLOCKED: "). Do NOT substitute "the tests passed" for the review/QA gate — it is a SEPARATE required step; never downgrade a missing review gate into "tests passed", and never substitute a paper read for a live gate that never ran.

STEP D — RUN the repo's discovered test/QA command (do NOT assume \`pytest\`) and confirm it passes.

STEP E — STAGE precisely, then GATE + commit. Do NOT use \`git add -A\` (it would sweep the pre-existing untracked files into the squash). Stage exactly the fix delta with EXACTLY this (it reads the Step-B scratch file, so it works across shells, and is safe for spaces in filenames):
\`\`\`bash
git add -u                                    # tracked edits/deletions from the fix
comm -23 <(git ls-files --others --exclude-standard | sort) <(sort .git/codex-wrap-pre.txt) \\
  | while IFS= read -r f; do [ -n "$f" ] && git add -- "$f"; done   # new files NOT pre-existing
rm -f .git/codex-wrap-pre.txt
\`\`\`
If AND ONLY IF the repo's review/QA gate(s) reported clean (Step C) AND tests are green (Step D): \`git commit -m\` with a short one-line message (no "Claude Code"), then return ok=true. In detail, LABEL each required gate as "natively run" or "replayed inline" (per STEP C), name the agent/command for each, and ECHO the exact test command + last lines of its output.

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
  `Land branch ${BRANCH} for issue #${ISSUE}. On ANY early-stop below, still return all LAND_SCHEMA fields: ok=false, prUrl="", base="", autoClose=false, and note=<the reason>.
0. Already-landed guard (the repo workflow must NOT have landed despite noLand): if \`gh pr list --search "${ISSUE} in:body" --state all --json url\` returns a PR for this issue, do NOT push or re-PR — return ok=false, note="already_landed: <pr url>" and stop.
1. DEFAULT=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name).
2. Resolve BASE (a BARE branch name, never origin/...): ${BASE_ARG ? `BASE="${BASE_ARG}"` : 'if `git ls-remote --heads origin dev` returns a line then BASE="dev", else BASE="$DEFAULT"'}.
3. Squash to one commit (the repo's one-commit-per-issue convention). FIRST assert the base is an ancestor of HEAD: \`git merge-base --is-ancestor ${REPO_BASE} HEAD\` — if it exits NON-zero (the branch was rebased or the base is stale/wrong), do NOT reset and do NOT push: return ok=false, note="base_not_ancestor" and stop. Otherwise squash: \`git reset --soft ${REPO_BASE} && git commit -m "#${ISSUE}: <short issue title, no 'Claude Code'>"\`.
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
