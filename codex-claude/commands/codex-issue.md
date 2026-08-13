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

Run the autonomous Codex-architect ↔ Claude loop for:

> $ARGUMENTS

You run this loop **yourself, in the main thread** — you have `Task`, so the repo's own subagents run
for real (unlike a nested-subagent design, which cannot dispatch them). Parse `$ARGUMENTS`: the
leading token is the GitHub issue number (if numeric) or the free-text task; honor `--dry-run` and
`--base <branch>`. Define the CLI once:

```bash
CDX="node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs"
```

This is **fully autonomous**: you make the judgment calls (answering ambiguity from the issue/code,
approving the implementation plan, deciding when a review is clean) — the only brakes are `--dry-run`
(stop before push/PR) and the **review-round checkpoint** (default 6 → a recorded checkpoint decision
per §7, never a bare stop; never push an un-clean change). `gh` (authenticated) is required for issue
intake and the finish.

Follow the **codex-claude** skill for the exact `codex-drive` verb contract used by the helper agents.

**HARD RULE — dispatch every helper WITHOUT a `name`.** Passing `name` puts the agent in *teammate*
mode, where a plugin-namespaced `subagent_type` is **silently dropped** (it runs as a generic
assistant with none of these instructions) and its final report is **never returned to you**. In the
incident that produced this rule, three helpers ran as generic assistants and one substituted its own
model's review for the Codex gate — see `docs/bugs/subagent-messages-not-delivered-to-main-thread.md`.
This applies to **every** dispatch in this command — the architect, planner and reviewer, and the
repo's own QA/review subagents in §5 and §7: an unnamespaced project-local type does keep its
identity in teammate mode, but its report still never comes back, which is how three hours of
finished QA work was abandoned and redone. If the Task/Agent surface you have cannot omit `name`,
**abort** rather than enter teammate mode.

That rule is a mitigation, not a guarantee — the harness may still fail to load a helper's identity.
So the two Codex gates below do not trust what the helper *says* at all: **you** own the Codex
session, and `scripts/gate-attest.mjs` — run by you, against the live daemon — is the only thing that
can authorize a gate.

## 0. Preflight

- `$CDX doctor`. If `codexVersion` is null or `authPresent` is false → **abort** (Codex not installed /
  not logged in).
- Confirm a Plan-mode model is configured (the architect's driver reads it from `~/.codex/config.toml`):
  ```bash
  CONFIG_MODEL=$(node -e "import('${CLAUDE_PLUGIN_ROOT}/lib/config.mjs').then(m=>process.stdout.write(m.readConfiguredModel()||''),()=>{})" 2>/dev/null)
  ```
  If `$CONFIG_MODEL` is empty → **abort**: "Plan mode needs a model — set `model = \"…\"` in
  ~/.codex/config.toml."
- Record the starting commit: `START=$(git rev-parse HEAD)`. Require `gh auth status` only on the
  paths that need it: a numeric issue (for `gh issue view`) or a non-`--dry-run` run (the finish
  pushes + opens a PR). A free-text `--dry-run` needs no `gh`.

## 1. Intake

- Numeric → `gh issue view <#> --json number,title,body`. Free text → use as-is.
- Create + checkout the working branch: `codex/issue-<#>` (or `codex/<short-slug>`).

## 2. Detect the repo's development mode (state which branch you take — never silent)

Scan for a composable Claude Code **Workflow** that the dev step can run as an engine:

```bash
ls .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null
grep -l "noLand" .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null
grep -l "codex-claude:generic-scaffold" .claude/workflows/*.js .claude/workflows/*.mjs 2>/dev/null
git ls-files --error-unmatch <matched-file> 2>/dev/null && echo tracked || echo UNTRACKED
```

Decide and **say which branch you took**:
- A file that actually **reads** `args.noLand` in code (open it and confirm — a bare comment mention
  doesn't qualify) **and** a numeric issue → **Workflow-engine mode** (§5 develops via that workflow).
  Surface, so the substitution is never silent: a **faithfulness banner** naming the workflow's own
  `meta.phases` (which may differ from your `CLAUDE.md`/`AGENTS.md` prose) and whether the file is
  **git-tracked** (untracked → reproducibility risk: a `git clean`/fresh clone flips it to main-thread
  mode). **Unmodified-scaffold tripwire:** if the matched file still contains
  `codex-claude:generic-scaffold`, it is the untouched generic starter that runs **no** real gates —
  warn loudly and prefer main-thread mode (or fixing the scaffold first).
- A workflow exists but none reads `noLand` (or a free-text task) → say so and nudge:
  "This repo has `.claude/workflows/<file>` but it's not composition-ready (no `noLand` seam) — run
  **`/codex-compose-setup`** for the higher-fidelity engine. Proceeding in **main-thread mode**."
- No composable workflow → **main-thread mode**. Say: "No composable workflow detected — main-thread mode."

## 3. Architect design plan (Codex, read-only) — you own the session

**You** start the Codex session and **you** collect the result; the helper only drives the turn.

**Shell variables do NOT survive between Bash calls** (only the working directory does), and the
steps below are separate calls with a Task dispatch in the middle. So each call **prints** the paths
it mints and every later call uses those **literal absolute paths**. Substitute them as you go.

1. **Mint the two directories** (one Bash call):
   ```bash
   ROOT=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
   RUN=$(mktemp -d /tmp/cdx-gate-architect.XXXXXX)      # STATE — yours alone; never given to the helper
   SHARE=$(mktemp -d /tmp/cdx-gate-prompts.XXXXXX)      # PROMPTS — the only path the helper learns
   printf 'ROOT=%s\nRUN_DIR=%s\nPROMPT_DIR=%s\n' "$ROOT" "$RUN" "$SHARE"
   ```
   The split is load-bearing: `start.json` is the collector's root of trust, and the helper is a
   process that can write files. If it knew `RUN_DIR` it could overwrite that record with one for a
   session of its own — so it never learns the path.
2. **Write both prompts in full, before dispatching** (Write tool, into `<PROMPT_DIR>`):
   `<PROMPT_DIR>/prompt` = the architect brief + the issue/task text (the body the codex-architect
   agent documents). `<PROMPT_DIR>/retry` = the complete re-ask ("Approvals are unavailable in this
   read-only planning session … emit the FULL file-by-file plan as plain text NOW …"). The daemon
   accepts **only** these two, so a nudge the helper invents is refused — write the retry properly,
   not as a stub.
3. **Hash them and start the gate session** (one Bash call, literal paths):
   ```bash
   SHA() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
   node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs start --private --cwd "<ROOT>" --gate architect \
     --gate-prompt-sha256 "$(SHA "<PROMPT_DIR>/prompt")" \
     --gate-retry-prompt-sha256 "$(SHA "<PROMPT_DIR>/retry")" > "<RUN_DIR>/start.json"
   cat "<RUN_DIR>/start.json"
   ```
   Keep that stdout **verbatim** — the collector checks the live daemon against it. Take `socket`
   from the printed JSON as the literal `<GATE_SOCKET>`. `--gate architect` binds the session to
   **`plan` turns**: the daemon refuses any other verb before it runs, instead of the collector
   discovering the mismatch after a completed turn (`docs/bugs/gate-orphaned-completed-turn.md`).
4. **Dispatch the codex-architect subagent (Task, no `name`)** passing the literals `GATE_SOCKET`,
   `PROMPT_PATH=<PROMPT_DIR>/prompt`, `RETRY_PROMPT_PATH=<PROMPT_DIR>/retry`. It returns
   `STATUS: READY` or `STATUS: FAILED`; either way it leaves the daemon running for you.
   **Your dispatch prompt MUST name the verb: `plan --prompt-file` — for the retry too.** The
   collector certifies an architect gate only from a turn of kind `plan`, and the daemon enforces it
   up front (`{error:"wrong_gate_turn_kind","expected":"plan"}` on a plain `send`). Do not
   paraphrase the verb away: an instruction that names no verb is how a helper once drove a gate
   with the wrong one.
5. **Collect — this, not the helper's word, is the gate:**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-attest.mjs collect --state-dir "<RUN_DIR>" --gate architect \
     --outcome completed --cwd "<ROOT>" --artifact "<RUN_DIR>/plan.md" --prompt "<PROMPT_DIR>/prompt" \
     --salvage "<RUN_DIR>/plan.unattested.md"
   ```
   **A Task that errored, was interrupted, or was denied says nothing about the turn** — the daemon
   is detached and the turn runs to completion regardless (`docs/bugs/gate-orphaned-completed-turn.md`:
   a turn once outlived its dead helper and finished). Before declaring the round dead, probe:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs status --socket "<GATE_SOCKET>"
   ```
   `turnStatus:"completed"` → the round is collectable: run the collect above, `--outcome completed`.
   `running` → keep polling `wait --timeout-ms 300000 --socket "<GATE_SOCKET>"` in fresh Bash calls
   until terminal, then collect. Only when the **turn itself** failed, or you are abandoning it, use
   `--outcome failed` (or `timeout`) — the daemon still gets torn down, and the round then cannot be
   certified. Either way, every refusal taken past the collect lock leaves `<RUN_DIR>/refusal.json`
   behind (`scripts/gate-attest-status.mjs --state-dir "<RUN_DIR>"` reads it back if stdout was lost).
6. **Branch on the collector's JSON only.** `ok:true` → copy the artifact **and its record**:
   ```bash
   mkdir -p .codex/plans
   cp "<RUN_DIR>/plan.md" .codex/plans/issue-<#>.md            # a slug for free-text
   cp "<RUN_DIR>/attestation.json" .codex/plans/issue-<#>.attest.json
   rm -rf "<RUN_DIR>" "<PROMPT_DIR>"
   ```
   Hold `.codex/plans/issue-<#>.md` as `$PLAN_PATH` and Read it as `$DESIGN` (the §4 planner's input;
   §6 re-inlines the bytes). The attestation is the durable evidence README/SKILL advertise — copy it
   before deleting the run dir. `ok:false` → **abort** with "Codex architect gate unattested
   (`<reason>`)"; never improvise a plan, and never treat a `STATUS: READY` as evidence on its own.
   If the collector reported `stopped:false`, **keep both directories** and surface the recovery line
   it printed on stderr: something still owns a live daemon. If it salvaged
   (`salvaged` in the JSON), `<RUN_DIR>/plan.unattested.md` preserves the refused turn's text as
   evidence for the abort report — it is **NOT** an artifact: never treat it as `$PLAN_PATH`, never
   copy it into `.codex/plans/`.

## 4. Claude implementation plan (read-only, plan-mode)

Dispatch the **codex-planner** subagent **with `mode: "plan"`** (Task), passing the issue text and
`$DESIGN`. Its returned message is Claude's own file-by-file implementation plan. If it is exactly
`STATUS: THIN` (or is < 80 chars / has no file or step), set `$IMPL = $DESIGN`; otherwise `$IMPL` =
its returned markdown. **You (main thread) persist** `$IMPL` with Write to
`.codex/plans/issue-<#>.claude.md`. (The planner is read-only — it returns text; you save it.)

## 5. Develop — branch on mode

**Main-thread mode:** implement `$IMPL` **yourself, here**. First DISCOVER this repo's own development
workflow — read `CLAUDE.md`, `AGENTS.md`, `.claude/` process docs / commands / agents — then RUN it
as-is, however many internal steps it has, **dispatching its real QA / code-reviewer / tester
subagents via `Task`** (you can — you are the main thread). Run its **review/QA gates**, not just its
tests — and a gate counts **whether it's a dispatched subagent OR a command the repo names** (e.g. a
`CLAUDE.md` step that runs an independent Codex review via its own gate script): run that one
too, with the **exact tool the repo specifies**. **The repo's own Codex/AI review gate MUST run here**;
the §6 architect-vs-plan review is **additive and does NOT "stand in for" it** — different goals (the
repo's gate judges the code, §6 judges impl-vs-plan), so never drop the repo's own review just because
§6 also calls Codex. **One exception to batching:** whatever this repo's gates are (a Codex/AI review, a
custom review subagent, or just tests), do **not** dispatch **any** of them in the same (parallel)
message as the §6 architect review — that pairing is deliberately sequential (§6 must judge a delta the
repo's gates have *already* cleared), even though the two look independent; see **§6 *Sequencing*** for
the hard barrier. (Running the repo's *own* gates in parallel with **each other** is still fine — only
the §6 review is fenced off.) Commit on the branch as the repo's workflow dictates, but **stop before any landing step**
(no push / PR / close — you own integration in §8). A **required** gate that cannot run (missing
credentials/live QA/network) is a **fail-closed block** → stop and report; never land a change whose
required gate was skipped.

**Workflow-engine mode:** run the repo's deterministic workflow as the development engine via the wrapper:
```
Workflow({ scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/codex-wrap.js",
  args: { issue: <#>, repoWorkflowPath: "<abs path to the matched .claude/workflows file>",
          plan: "<$IMPL>", base: "<--base value or empty>" } })
```
It runs in the background; on completion branch on its `status`: `ready` → record `branch` + `base_sha`
(use `base_sha` as the review base below); `danger_landed` → **abort** with its danger message (the
repo landed despite `noLand` — the review was bypassed; manual inspection needed); `failed` → **abort**
with its `detail`.

## 6. Architect review (Codex, against the design plan)

This review is **additive** — it does **not** replace or "stand in for" any Codex/AI review gate the
repo's own workflow already ran in §5 (two reviews, two goals — by design, not redundant: the repo's
gate judges the code on its own merits; this one judges the implementation against the **architect's
design plan**). If the repo defines its own Codex review, **both** run — never collapse them into one.

**Sequencing — one Codex review at a time (hard barrier).** Start this review **only after** the
repo's own gate(s) for this round have **finished and come back clean, and you have read that result** —
not merely been dispatched or queued. This holds in **every** mode and for **any** gate the repo
defines: **main-thread mode** → the repo's review/QA subagents/commands from §5 (or the §7 re-run)
returned clean; **Workflow-engine mode** → the §5 Workflow returned **`status: ready`** (or the §7
discoverable-gate re-run came back clean). §6 must judge a delta that has *already passed* the repo's
gates this round. **Never dispatch any of the repo's own gates for this round — tests, a custom
review/QA subagent, or a Codex/AI review command — in the same (parallel) message as this architect
review.** Keep **at most one Codex review turn in flight**, too — but the same-message ban holds **even
when the repo's gate is not a Codex turn** (e.g. a custom `code-reviewer` or plain `pytest`): the
single-Codex-session reason is *sufficient, not necessary* — §6 must always judge a delta the repo's
gatekeeper has **already** returned CLEAN, whatever tool that gatekeeper is. The harness's "make all the
independent calls in the same block" guidance does **not** apply to these staged gates — they look independent but
are deliberately sequential, and the single global Codex session (one in-flight turn; see the
**codex-claude** skill) makes concurrent Codex turns unsafe by design. It didn't collide before only
because the two tools happened to use separate backends — an implementation detail, not a guarantee.

Compute the changed files: `git diff --name-only <START | base_sha>..HEAD` (use `base_sha` in
Workflow-engine mode, `$START` in main-thread mode). Then run the **same dispatcher-owned seam as §3**,
per round, in a fresh run dir (`mktemp -d /tmp/cdx-gate-review.XXXXXX`):

1. **Mint a fresh state dir and prompt dir for THIS round** exactly as §3 step 1 (`mktemp -d
   /tmp/cdx-gate-review.XXXXXX` and `/tmp/cdx-gate-prompts.XXXXXX`), and print both — same rule, same
   reason: the helper never learns the state dir. Use the printed literals below.
2. **Write the brief** to `<PROMPT_DIR>/brief` (Write tool): what to review, the changed-file list,
   and "END with a verdict on its OWN FINAL line: exactly 'VERDICT: NO ISSUES' or 'VERDICT: ISSUES
   FOUND'". Then **assemble the prompt in Bash so the plan is copied, not retyped**:
   ```bash
   { cat "<PROMPT_DIR>/brief"; printf '\n\n=== ARCHITECT DESIGN PLAN (verbatim) ===\n'; cat "$PLAN_PATH"; } > "<PROMPT_DIR>/prompt"
   ```
   You **MUST NOT** summarize, compress, drop sections from, reorder, or re-author the plan — doing so
   lets a load-bearing constraint silently vanish before the review ever sees it, which is why this is
   a `cat` and not a Write. You **MAY** append the issue's acceptance criteria under a **separate**
   `=== ISSUE ACCEPTANCE CRITERIA ===` header, never merged into the plan block. Write
   `<PROMPT_DIR>/retry` (the complete re-ask) too.
3. Hash both and start the gate session exactly as §3 step 3 — **but with `--gate review`, not
   `--gate architect`** — saving stdout verbatim to `<RUN_DIR>/start.json`; take the socket from it.
   `--gate review` binds the session to **plain `send` turns** (the daemon refuses `plan` up front).
4. Dispatch the **codex-impl-reviewer** subagent (Task, **no `name`**) with the literal
   `GATE_SOCKET`, `PROMPT_PATH=<PROMPT_DIR>/prompt`, `RETRY_PROMPT_PATH=<PROMPT_DIR>/retry`. It
   reviews and reports; it stops nothing.
   **Your dispatch prompt MUST name the verb: `send --prompt-file` — for the retry too.** The
   collector certifies a review gate only from a turn of kind `turn` (a plain `send`), and the
   daemon enforces it up front (`{error:"wrong_gate_turn_kind","expected":"send"}` on `plan`). The
   incident behind this rule (`docs/bugs/gate-orphaned-completed-turn.md`) was a dispatcher prompt
   that said `plan` for a review gate: the 17-minute turn completed and was then unattestable.
5. Collect:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-attest.mjs collect --state-dir "<RUN_DIR>" --gate review \
     --outcome completed --cwd "<ROOT>" --artifact "<RUN_DIR>/review.md" \
     --prompt "<PROMPT_DIR>/prompt" --plan "$PLAN_PATH" --salvage "<RUN_DIR>/review.unattested.md"
   ```
   **Dead-helper rule, same as §3 step 5: probe before declaring.** A Task that errored, was
   interrupted, or was denied says nothing about the turn — it survives its driver and completes.
   `status --socket "<GATE_SOCKET>"` first: `completed` → collect with `--outcome completed`;
   `running` → keep `wait`-polling; only a turn you know failed (or are abandoning) gets
   `--outcome failed|timeout`. Passing **both**
   `--prompt` and `--plan` is what makes the record's "reviewed against this plan" claim checkable:
   the collector verifies `--prompt` is the PRIMARY brief, that the session actually ran it (the
   daemon records which approved prompts started turns — so this holds even when the in-session
   retry is the turn that certifies), **and** that the plan's bytes are inside it — a round where
   the inlining was skipped fails the gate instead of quietly attesting a review that never saw
   the plan.

**Decide from the collector's JSON, not from the helper's last line.** The findings you act on come
from `<RUN_DIR>/review.md` — the daemon's own words, which the collector wrote. Keep the round's
directories until you have consumed the findings (§7 reads that file); remove them at the end of the
round, or keep them if `stopped:false`:

- `ok:true` + `parsedVerdict: "NO ISSUES"` → **clean**. (A clean verdict with no `Reviewed files:`
  line and no findings is a thin signal → run one more round asking for the file list first; if still
  substance-free, accept clean.)
- `ok:true` + `parsedVerdict: "ISSUES FOUND"` → §7.
- `ok:true` + `parsedVerdict: "UNCLEAR"` **with concrete findings** in `<RUN_DIR>/review.md` → §7. Codex
  really ran and produced actionable findings; they are worth fixing even though the verdict line
  never landed.
- `ok:true` + `UNCLEAR` with **no** findings → **abort** as an unusable Codex result. Do not burn a
  review round on nothing.
- `ok:false` → **abort** with "Codex review gate unattested (`<reason>`)". This is **not** a finding
  and must **never** enter §7 — it means the gate did not run, and iterating on it would burn every
  remaining round exactly as the incident did. `stopped:false` → keep the round's directories and
  surface the recovery line. If the JSON carries `salvaged`, `<RUN_DIR>/review.unattested.md`
  preserves the refused turn's text — it is **NOT** a gate artifact: never read it as findings,
  never hand it to §7, never copy it over `review.md`; it exists only as evidence for the abort
  report and for deciding whether to re-run the round. A refusal also leaves `<RUN_DIR>/refusal.json`
  (readable later with `scripts/gate-attest-status.mjs`).

## 7. Address findings (you, with full development context)

Invoke the **receiving-code-review** skill on the findings in `<RUN_DIR>/review.md` (the collector-written
review — the helper's summary is a convenience, that file is the record): verify each against the code,
fix only genuinely-wrong things, and **push back (in your report) on false positives** with technical
reasoning — do not implement blindly. Then **re-run this repo's own review/QA gates on the fix**:
- main-thread mode → dispatch the repo's gate subagents (Task) / run its gate commands as in §5,
  **including re-running the repo's own Codex/AI review gate on the fix delta with the exact tool the
  repo names — §6 never substitutes for it on any round** (many repos require their own Codex gate on
  every fix round, scoped to the delta);
- Workflow-engine mode → re-run the repo's **discoverable** gate commands on the fix delta (you have
  `Task` + `Bash`), since a full re-run of the deterministic Workflow per fix is unnecessary.
  **Discover the gate set from the matched workflow file §2 detected and §5 ran — the abs
  `repoWorkflowPath` (`.claude/workflows/*.js` **or** `*.mjs`), NOT `codex-wrap.js`'s opaque single `Repo
  workflow` phase:** open it and enumerate **every** review/QA/AI-review stage it executes — its
  `developer⇄reviewer` loop, any **internal Codex/AI review** loop, its
  tests — plus any `CLAUDE.md`/`AGENTS.md` gate the workflow defers to; those (not just shell `test`
  commands) are the **required** set. Re-run **each** on the fix delta with its exact tool — a named
  command natively, a repo subagent via `Task`, the repo's own Codex/AI review with the tool the repo
  names (**§6 never substitutes for it on any round** — same rule as main-thread, lines above). Run each
  gate **independently against the fix on the current branch** — its review/QA subagent via `Task`, its
  Codex/AI review and its tests against the changed files — **not** by re-running the workflow's
  *implement*/preflight steps: those reject the existing branch / dirty tree and re-implement the issue
  from the **original** plan instead of validating the just-applied fix, so a full-pipeline re-run is
  **not** a usable fallback here. **If a required gate is so entangled with the implement step that it
  cannot be run independently on the current branch, do NOT skip it** — treat it as a **fail-closed
  block**. A required gate you can neither enumerate from the workflow nor run on the fix delta
  (entangled-with-implement, or missing credentials/live QA/network) is a **fail-closed block** → stop
  and report; never advance to §6 with a §5 gate unrun. **State in the final report which path each gate
  took** (native command / dispatched repo subagent / fail-closed block) — fixes trade the Workflow's
  determinism for gate independence; that's intended for a small fix delta.

Commit the fix delta (no landing). **Hard barrier — the repo's gate must finish CLEAN before §6:** run
the repo's own gate(s) above to **completion** and confirm **CLEAN** *before* you return to §6. Do
**not** dispatch the §6 architect review concurrently with — or before — **any** of the repo's own
gates for this round (tests, a custom review/QA subagent, or a Codex/AI review command); keep **one
Codex review turn in flight at a time** (per §6). This is the exact spot where "batch the
independent calls" tempts a parallel dispatch — resist it: these gates only *look* independent. Then
increment the round counter and return to §6 **scoped to the fix delta** (tell the reviewer to review
only the newly changed files). Exit the loop when clean. The max review rounds (default 6) is a
**checkpoint, never a hard stop** — reaching it can never strand applied work: a committed fix delta
that has not yet had its delta-scoped §6 re-review gets that one review **first** (an applied fix's
validation is owed unconditionally, round budget or not). Only then record ONE checkpoint decision:
if the repo's own process docs (`CLAUDE.md`/`AGENTS.md`) define round/checkpoint semantics, follow
them (continue another window / defer to a filed follow-up / escalate); otherwise stop without
pushing and report the outstanding findings, the current state, and the recorded decision. Never push
an un-clean change, and never end the run with the latest fix delta unreviewed at HEAD.

## 8. Finish — integrate (skip entirely if `--dry-run`)

- **Pre-finish landing guard.** `git ls-remote --heads origin <branch>` must be **empty** and, for a
  numeric issue, `gh issue view <#> --json state` must still be **OPEN**. If the branch is already
  pushed or the issue already closed → the developer landed prematurely → **do not push/re-PR**;
  abort with `DANGER: landed before review — manual inspection needed` and the current state.
- Ensure everything is committed. Resolve the default branch and base (a **bare** name, never
  `origin/…`): `$DEFAULT = gh repo view --json defaultBranchRef -q .defaultBranchRef.name`; `$BASE` =
  `--base` if given, else `dev` if it exists **on the remote** (`git ls-remote --heads origin dev | grep -q .`),
  else `$DEFAULT`. Record whether `$BASE == $DEFAULT`.
- `git push -u origin <branch>`.
- Set `$PLAN_SUMMARY` to a 1–2 sentence summary of what shipped (derive it from `$IMPL`). Build the
  PR body with **real newlines**:
  ```bash
  BODY=$(printf 'Closes #%s\n\n%s\n\nArchitect review: clean after %s round(s).' "$NUM" "$PLAN_SUMMARY" "$K")
  gh pr create --base "$BASE" --head "$BRANCH" --title "<issue title or task>" --body "$BODY"
  ```
  (Drop the `Closes #N` line for a free-text task with no issue.) Capture the PR URL.
- **Never auto-merge; never close the issue directly.** `Closes #N` auto-closes only on a merge into
  the **default branch**: `$BASE == $DEFAULT` → leave it (the merge closes it); `$BASE != $DEFAULT`
  (e.g. `dev`) → it will **not** auto-close — leave it OPEN and **flag a manual close** in the report.

## Final report (report what ACTUALLY happened — never narrate an intended architecture)

- **Issue/task** and branch; the two plan artifacts (`.codex/plans/issue-<#>.md` and `…claude.md`).
- **Which development path ran** — main-thread (you ran the repo's workflow) or Workflow-engine (the
  repo Workflow) — and **which gates ran how**: a native command vs a **dispatched repo subagent**
  (name it). This is the fidelity record: the human can see the repo's real lifecycle executed.
- **Architect Q&A** you auto-answered (via the helper agents) with rationale; any findings you pushed
  back on and why.
- **Rounds**: how many review rounds and the final verdict.
- **Outcome**: PR URL + whether the issue **auto-closes** (`$BASE == $DEFAULT`) or **needs a manual
  close**. Or — if you stopped early — exactly why and the current state (branch, commits, outstanding
  findings). Be honest about anything you could not get clean or any gate that could not run.

In both modes the loop never auto-merges and never closes the issue itself. You DO drive `codex-drive`
yourself for the two gate seams (§3/§6 `start` + `gate-attest collect`) — that ownership is the gate —
but you do NOT drive the plan/review TURNS: the `codex-architect` / `codex-impl-reviewer` subagents poll
those on the socket you hand them, and
isolate their verbose wait-loops from this conversation.
