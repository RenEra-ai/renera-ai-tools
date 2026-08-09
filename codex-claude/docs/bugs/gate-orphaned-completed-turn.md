# codex-claude: a completed 17-minute gate review was orphaned, then discarded on a verb technicality

**Filed:** 2026-08-09 · **Against:** `codex-claude` 1.8.20 · **Severity:** high (destroys completed
review work; the gate silently reports "no turn ran" when a turn ran and finished)

---

## Summary

During `/codex-issue` §6 (architect-vs-plan review, round 2) on this repo, four independent defects
compounded and a finished Codex ultra review was lost as a gate artifact:

1. The user denied a tool call **inside** the running `codex-impl-reviewer` helper, 14 minutes after
   the helper was dispatched. The dispatcher received only
   `The user doesn't want to proceed with this tool use. The tool use was rejected` on the **Agent**
   tool — text indistinguishable from a dispatch that never started. The dispatcher concluded no turn
   had been sent.
2. The turn had been sent, and it **outlived its driver by ~3 min 15 s**, completing normally. The
   plugin documents that the *daemon* survives a dead agent, but never that the *turn* runs to
   completion, and gives the dispatcher no procedure for detecting or recovering one.
3. The documented dispatcher response to a dead helper — `gate-attest collect --outcome failed`
   (`commands/codex-issue.md:145-146`, `:254`) — is a **ceiling** that unconditionally refuses
   (`scripts/gate-attest.mjs:295`). Following the recipe literally would have destroyed the review
   too, by a second and independent path.
4. The dispatcher's helper prompt said `plan --prompt-file`; `--gate review` requires a turn of kind
   `turn`, i.e. a plain `send` (`scripts/gate-attest.mjs:319`). The collector refused with
   `wrong_turn_kind` **after** it had already read the complete review into memory
   (`scripts/gate-attest.mjs:282-285`) and torn the daemon down (`:288`), and wrote nothing. That
   mapping — which gate needs which verb — appears **nowhere** in the plugin outside that one line of
   the collector and its unit test.

Net effect: one completed, verdict-bearing, policy-approved ultra review, produced at real cost, was
readable from the live daemon and then deliberately thrown away. The round is unattested. The run
directory `/tmp/cdx-gate-review.aE9ze6/` contains only `collect.lock` and `start.json` — no
`review.md`, no `attestation.json`.

---

## Environment

| | |
|---|---|
| Plugin | `codex-claude`, cache copy `/Users/gleb/.claude/plugins/cache/renera-ai-tools/codex-claude/1.8.20/` |
| Plugin version source | the cache **directory name** (`1.8.20`); `.claude-plugin/plugin.json` carries **no** `version` field, and `package.json:3` says `"version": "0.1.0"` (the vendored `codex-drive` engine, not the plugin) |
| Codex CLI | `0.144.5`, `authPresent: true`, 1051 threads (from the helper's own `doctor` call) |
| OS | macOS (Darwin 25.6.0), Node at `/usr/local/bin/node` |
| Repo | `/Users/gleb/Documents/Projects/Renera/boomi-mcp-server`, branch `codex/issue-146`, HEAD `00779fc`, review delta `845bda1..00779fc` |
| Flow | `/codex-issue` §6, dispatcher-owned gate seam |

Exact commands, in order (paths verbatim):

```bash
# 1. dispatcher, ~14:16:28Z
node .../1.8.20/bin/codex-drive.mjs start --private --cwd /Users/gleb/Documents/Projects/Renera/boomi-mcp-server \
  --gate-prompt-sha256       754a40c4bf467747a1f5aae8f0d7dfa45e7d239d579d267d843372ec853f582f \
  --gate-retry-prompt-sha256 321f5ab9b1e6abb1991ebf8f38f64e5f3967e28e842807a68dabc647ac2fe3bd \
  > /tmp/cdx-gate-review.aE9ze6/start.json

# 2. helper subagent, 14:17:15Z  — THE DEFECTIVE LINE: `plan`, not `send`
node .../1.8.20/bin/codex-drive.mjs plan --prompt-file /tmp/cdx-gate-prompts.3RZMEY/prompt \
  --effort ultra --socket /Users/gleb/.codex-drive/d-59590-mslvym0y.sock

# 3. helper, 14:17:23Z / 14:22:38Z / 14:27:46Z  — the third call was denied
node .../1.8.20/bin/codex-drive.mjs wait --timeout-ms 300000 --socket /Users/gleb/.codex-drive/d-59590-mslvym0y.sock

# 4. dispatcher, 15:02:20Z — evidence capture
node .../1.8.20/bin/codex-drive.mjs status --socket /Users/gleb/.codex-drive/d-59590-mslvym0y.sock
node .../1.8.20/bin/codex-drive.mjs read   --socket /Users/gleb/.codex-drive/d-59590-mslvym0y.sock --parsed-verdict

# 5. dispatcher, 15:02:52Z — the refusal
node .../1.8.20/scripts/gate-attest.mjs collect --state-dir /tmp/cdx-gate-review.aE9ze6 --gate review \
  --outcome completed --cwd /Users/gleb/Documents/Projects/Renera/boomi-mcp-server \
  --artifact /tmp/cdx-gate-review.aE9ze6/review.md \
  --prompt /tmp/cdx-gate-prompts.3RZMEY/prompt \
  --plan /Users/gleb/Documents/Projects/Renera/boomi-mcp-server/.codex/plans/issue-146.md
```

---

## Observed sequence

All timestamps UTC, from the Claude Code session transcripts (local time is UTC−4; the file mtimes in
`/tmp` read 4 hours earlier).

**14:16:28Z** — `start` spawns the detached daemon (pid 59591). Derived from `ps` `ELAPSED 45:56` at
the 15:02:24Z capture. `start.json`, verbatim:

```json
{"ok":true,"threadId":"019fe6e1-dacd-7dc1-b9a1-855cc486f746","socket":"/Users/gleb/.codex-drive/d-59590-mslvym0y.sock","pid":59591,"cwd":"/Users/gleb/Documents/Projects/Renera/boomi-mcp-server","private":true,"gatePromptSha256":["754a40c4bf467747a1f5aae8f0d7dfa45e7d239d579d267d843372ec853f582f","321f5ab9b1e6abb1991ebf8f38f64e5f3967e28e842807a68dabc647ac2fe3bd"]}
```

**14:16:50.346Z** — dispatcher issues `Agent` (`toolu_01SSTp4EDkaFiNsPLJUzvpTj`),
`subagent_type: "codex-claude:codex-impl-reviewer"`, `run_in_background: false`, no `name`. Its
prompt's step 1 reads, verbatim:

```
1. `plan --prompt-file "$PROMPT_PATH" --effort ultra --socket "$GATE_SOCKET"`
```

…while its step 4 reads `send --prompt-file "$RETRY_PROMPT_PATH"`. The dispatcher's own prompt is
internally inconsistent about the verb.

**14:16:59.632Z** — the helper starts. Its transcript is
`…/50742425-5ce3-4f26-81cd-1ba5bc5c0f9b/subagents/agent-a7c03b767254a2c3a.jsonl`;
`agent-a7c03b767254a2c3a.meta.json` records
`{"agentType":"codex-claude:codex-impl-reviewer","description":"§6 architect-vs-plan review r2","toolUseId":"toolu_01SSTp4EDkaFiNsPLJUzvpTj","spawnDepth":1}`.

**14:17:03Z** — helper: *"I'm in external gate mode."* (phrasing unique to
`agents/codex-impl-reviewer.md:26`).

**14:17:06Z** — helper verifies the prompt hashes match the gate policy, and `doctor`:

```json
{"codexVersion":"0.144.5","authPresent":true,"threads":1051}
```

**14:17:15.942Z → 14:17:17.744Z** — helper sends the turn with **`plan`** and gets:

```json
{"ok":true,"status":"running"}
```

**14:22:26.501Z** — poll 1 result, `ELAPSED_MIN=5`:

```json
{"status":"timeout","turnStatus":"running","lastEventAgoMs":180,"eventCount":1269}
```

**14:27:41.619Z** — poll 2 result, `ELAPSED_MIN=10`:

```json
{"status":"timeout","turnStatus":"running","lastEventAgoMs":3926,"eventCount":3724}
```

**14:27:46.131Z** — helper issues poll 3 (identical `wait` command).

**14:31:07.397Z** — poll 3 comes back, in the **helper's** transcript, as:

```
The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file
edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to
tell you how to proceed.
```

followed at 14:31:07.402Z by `[Request interrupted by user for tool use]`. The helper's transcript
ends there — 22 lines total.

**14:31:07.398Z** — the **dispatcher** receives that same text as the `tool_result` for its `Agent`
call. No agent report, no partial output, no indication that 14 minutes of driving had occurred.

**~14:34:22Z** — the Codex turn completes. Derived: `lastEventAgoMs: 1682526` (28 min 2.5 s) measured
at the 15:02:24.5Z status reply. **The turn outlived its driver by ≈3 min 15 s and ran ≈17 min 5 s in
total.** Consistent with the user's independent observation in the Codex UI ("chat created 42 min
[ago]… finished in 16 min").

**14:57:14Z** — user: *"are you still working?"*. The dispatcher reports a **live Codex daemon
holding a socket with no turn sent (pid 59591)** and asks how to proceed. This is the failure in one
line: the dispatcher's model of the session was exactly inverted.

**15:01:35Z** — the user pastes the findings they had read in the Codex UI, proving the review
existed.

**15:02:24.539Z** — evidence capture. `status.json`, verbatim:

```json
{"threadId":"019fe6e1-dacd-7dc1-b9a1-855cc486f746","turnStatus":"completed","parked":null,"cwd":"/Users/gleb/Documents/Projects/Renera/boomi-mcp-server","lastEventAgoMs":1682526,"eventCount":5712,"restartRequired":false}
```

`read.json` (5567 bytes; `message` is 5350 chars / ~459 words — **not** ~5000 words as first
estimated):

```json
{"status":"completed","message":"I'll audit the specified 43-commit delta strictly against the reproduced design plan … VERDICT: ISSUES FOUND","kind":"plan","turnToken":1,"cwd":"/Users/gleb/Documents/Projects/Renera/boomi-mcp-server","parsedVerdict":"ISSUES FOUND"}
```

`ps.txt`:

```
  PID ELAPSED COMMAND
59591   45:56 /usr/local/bin/node …/1.8.20/bin/codex-drive.mjs __daemon {"socketPath":"/Users/gleb/.codex-drive/d-59590-mslvym0y.sock","resume":null,"cwd":"/Users/gleb/Documents/Projects/Renera/boomi-mcp-server","profile":null,"private":true,"gatePromptPolicy":{"allowed":["754a40c4…","321f5ab9…"]}}
```

**15:02:44.872Z** — first `collect`, with a *relative* `--plan`:

```
[gate-attest] --plan must be an absolute path (got '.codex/plans/issue-146.md')
{"ok":false,"reason":"usage","stopped":false}
```

This is correct and harmless: the absolute-path check (`scripts/gate-attest.mjs:128-130`) runs
**before** the never-released lock is taken (`:146-150`), so the retry below was still possible.

**15:02:55.065Z** — second `collect`, absolute paths:

```
[gate-attest] review gate requires kind 'turn', the turn was 'plan'
[gate-attest] refusing to attest: wrong_turn_kind
{"ok":false,"reason":"wrong_turn_kind","stopped":true}
```

**After:** pid 59591 gone, `/Users/gleb/.codex-drive/` holds only the (Jul 18) `state.json` — the
private session never wrote to it, by design (`bin/codex-drive.mjs:307-309`).
`/tmp/cdx-gate-review.aE9ze6/` holds `collect.lock` (0 bytes) and `start.json`, and nothing else.

---

## Root cause

### PROVEN

**P1 — the helper ran, and it is what sent the prompt.** The subagent transcript
`agent-a7c03b767254a2c3a.jsonl` contains the `plan --prompt-file` Bash call at 14:17:15.942Z and its
`{"ok":true,"status":"running"}` reply, plus two successful `wait` polls. Nothing else in the session
touched that socket. The `meta.json` `toolUseId` matches the dispatcher's `Agent` call exactly.

**P2 — the denial hit the helper mid-flight, not the dispatch.** The helper produced 20 transcript
entries between 14:16:59Z and 14:27:46Z. The rejection text appears in the helper's transcript as the
result of its **third `wait`**, and in the dispatcher's transcript as the result of the **Agent**
call, both stamped 14:31:07.39xZ — 14 min 17 s after the dispatch. A dispatch that was never approved
cannot have produced 20 entries and two completed 5-minute polls.

**P3 — the turn survived its driver and completed.** `turnStatus: "completed"`, `eventCount: 5712`
(up from 3724 at the last poll the helper saw), `parsedVerdict: "ISSUES FOUND"`, and a message ending
in a well-formed `VERDICT: ISSUES FOUND` line. The daemon is spawned `detached: true, stdio: 'ignore'`
and `child.unref()`ed (`bin/codex-drive.mjs:276-278`, `:305`), so it is structurally independent of
every Claude-side process.

**P4 — the dispatcher had no signal.** The `tool_result` text is the only thing it received. The
plugin's sole instruction for this case is `commands/codex-issue.md:145-146` ("Use `--outcome failed`
(or `timeout`) if the Task errored or you gave up on it") and `:254`. Nothing in
`commands/codex-issue.md`, `skills/codex-claude/SKILL.md`, or either agent definition tells a
dispatcher to probe `status --socket` before declaring a round dead. `skills/codex-claude/SKILL.md:284-285`
comes closest — *"An orphaned daemon (agent died before `stop`) is closed manually with
`stop --socket <the .sock sidecar>`"* — but that is a **cleanup** instruction: it neither states that
the turn keeps running nor that its result is readable. The "the turn survives" language elsewhere
(`SKILL.md:278-283`, `agents/codex-architect.md:80-82`, `agents/codex-impl-reviewer.md:62-63`) is
uniformly about surviving **Bash calls**, never about surviving the agent.

**P5 — the documented recovery would have destroyed the review anyway.** Had the dispatcher followed
`codex-issue.md:145-146` / `:254` and passed `--outcome failed`, `scripts/gate-attest.mjs:295` refuses
with `declared_failed` before reaching any other check. `--outcome` is a deliberate ceiling
(`:292-296`) and the reasoning behind it is sound for *certification*; the defect is that the ceiling
also destroys the *text*, and that it is the only prescribed response to a dead helper.

**P6 — the `wrong_turn_kind` mapping is undocumented outside the collector.** `grep` over the whole
plugin finds `wrong_turn_kind` / `expectedKind` only at `scripts/gate-attest.mjs:319-322` and in
`test/gate-attest.test.mjs:228-241`. `commands/codex-issue.md` — the file a dispatcher writing a
helper prompt actually reads — **never names the verb** at §3 step 4 (`:137-139`) or §6 step 4
(`:246-247`). The correct verb exists only inside the agent definitions
(`agents/codex-architect.md:42` → `plan`; `agents/codex-impl-reviewer.md:36`, `:47`, `:53`, `:189` →
`send`), and neither explains that the *collector* keys on it. `skills/codex-claude/SKILL.md:226-227`
documents `plan` and `send` symmetrically with respect to `--prompt-file` and says nothing about
attestation.

**P7 — the review text was in the collector's hands when it discarded it.** `gate_snapshot` returns
identity **and** result in one reply (`lib/daemon.mjs:176-185`); `scripts/gate-attest.mjs:282-285`
copies `message` into `snapshot`; teardown happens at `:288`; only then, at `:319-322`, does the kind
check fire. Exactly **one** of the collector's certification checks failed. Every other one passed:
outcome ceiling (`:295-296`), a real turn with a prompt hash and `turnToken ≥ 1` (`:300`), the hash on
the allowlist (`:305`), not a retry-only session (`:312`, `turnToken` was 1 = the primary prompt),
`status === 'completed'` (`:315`), non-empty (`:323`).

**P8 — a sibling collector in the same plugin already salvages.** `scripts/commit-review-collect.mjs`
hits the analogous "the collected turn is the wrong kind" gap at `:427-429` and still calls
`emit(unhappy, reviewText, 2)` (`:445`), which prints the full review followed by `STATUS: failed`
(`:224-227`). It also records the outcome durably (`phase`, `:219-222`) with a dedicated recovery
reader, `scripts/commit-review-status.mjs`. `gate-attest.mjs` has neither: on refusal it writes
nothing at all — confirmed by the surviving run directory, which holds only `collect.lock` and
`start.json`.

**P9 — nothing in the plugin can find a live `--private` daemon.** `lib/doctor.mjs:39-45` returns only
`{codexVersion, authPresent, threads}`. `--private` sessions deliberately skip
`StateStore.writeState` (`bin/codex-drive.mjs:307-309`), so `~/.codex-drive/state.json` never mentions
them; the existing-session probe in `startDaemon` (`bin/codex-drive.mjs:218`) reads that file and is
skipped entirely for private starts. `lib/daemon.mjs` contains no idle timer, TTL, or reaper — its
only timers are the 5 s unref'ed response backstop (`:13`, `:469-479`) and a 500 ms unsubscribe race
in `stop()` (`:829-830`). The single on-disk trace of a live private daemon is its socket file in
`StateStore.baseDir` (`lib/state.mjs:6-9`), and the only sweep of that directory prunes `*.sock.err`
files older than an hour (`bin/codex-drive.mjs:266-272`) — never `.sock` files, and never with a
liveness probe.

### INFERRED (stated as inference)

**I1 — the exact user action.** The transcripts show a denial arriving at 14:31:07 on the helper's
third `wait` and, simultaneously, on the parent's `Agent` call. Whether the user clicked "deny" on the
inner Bash call or interrupted the whole agent, I cannot determine — the transcript records the same
text either way. Either way the denial was **14 minutes after** dispatch, so no reading of it supports
"the dispatch never ran".

**I2 — whether the harness can distinguish the two cases.** The dispatcher had one sample of one
message. I cannot say from this evidence whether Claude Code emits different text for a pre-execution
Agent denial versus a mid-flight interruption. If it does not, that is a harness-side gap, not a
plugin defect — but the plugin's recipe is what turns it into lost work, and the plugin *can* close it
unilaterally (see FIX 3).

**I3 — whether `plan` mode changed the review's content.** In a `plan` turn the daemon prefers the
`item/plan/delta` / `item/completed{type:'plan'}` stream over the agent-message buffer
(`lib/daemon.mjs:739-742`, `:755`), which is precisely why `_startTurn` marks `isPlan` only for an
explicit plan mode (`:236-239`). Whether the 5350-char message came from `planText` or from
`turn.buffer` is now unrecoverable — the daemon is stopped and nothing logged the channel. So the kind
check is **not** a pure formality: sending a review as a plan turn genuinely risks a plan/checklist
item shadowing the review's `VERDICT` line. In this instance the verdict did land, so no content loss
is demonstrated.

**I4 — why the helper used `plan` despite its own definition saying `send`.** The helper's opening
line ("I'm in external gate mode") is lifted from `agents/codex-impl-reviewer.md:26`, so the agent
definition was almost certainly loaded, and it contradicted the dispatcher's step 1. The most
economical explanation is that the explicit per-task instruction outranked the agent's standing
recipe. This matters for the fix: **strengthening the agent file alone is not sufficient**, because
the agent had the correct instruction and did not follow it.

---

## Impact

- **One completed ultra Codex review (≈17 min of GPT-5.6-class compute) is unattestable.** The text
  survives only in two unofficial places: `/tmp/cdx-idle-evidence/read.json`, captured ad hoc by the
  dispatcher, and a hand-copy the user made from the Codex UI. Neither is a gate artifact.
- **`/codex-issue` §6 round 2 for issue #146 is not gate-attested.** Per
  `commands/codex-issue.md:274-277`, an `ok:false` collect is an **abort**, explicitly *"not a finding"*
  that must never enter §7 — so the loop's own rules forbid acting on the findings that were in fact
  produced.
- **The dispatcher confidently told the user the opposite of the truth** ("a live Codex daemon holding
  a socket with no turn sent"), and would have proposed tearing down a finished review as cleanup.
- **Two independent paths lead to the same loss.** Wrong verb → `wrong_turn_kind`; correct verb but
  the documented dead-helper response → `declared_failed`. A dispatcher that did everything the
  documentation says would still have lost the review.
- **Orphan exposure.** pid 59591 held its socket for 46 minutes. It was reaped only because the
  dispatcher chose to run `collect`, whose teardown is unconditional past the ownership gate
  (`scripts/gate-attest.mjs:288`). Had the dispatcher accepted "the daemon is idle, stop it later" or
  simply moved on, nothing in the plugin would ever have surfaced it, and the socket plus a live
  `codex app-server` child would have persisted until reboot.
- **No durable trace of the refusal.** `gate-attest` writes nothing on any refusal path, so a lost
  stdout would leave no evidence that the round even happened — unlike its sibling collector, which
  writes `phase` and ships `commit-review-status.mjs` to read it back.

---

## Suggested fixes

Ordered by how early they stop the loss.

### FIX 1 — bind the gate's turn kind at `start` and refuse the wrong verb before the turn runs *(prevents the whole incident)*

The daemon already refuses an unapproved **prompt** at turn start, at zero cost, and the collector's
comment at `scripts/gate-attest.mjs:305-307` calls the post-hoc hash check "defence in depth" precisely
because the daemon front-stops it. The turn **kind** has no such front-stop, so it is only discovered
17 minutes and one full review later. Close the asymmetry:

- `lib/verbs.mjs` — `parseGatePromptPolicy()` (`:102-128`): accept `--gate <architect|review>` and
  return `{allowed, gate}`. Add `gate` to `VERB_FLAGS.start` (`:169-170`).
- `bin/codex-drive.mjs` — `startDaemon()`: carry it in the daemon payload (`:274-275`) and echo it in
  the `start` record next to `gatePromptSha256` (`:313-314`), so the collector can cross-check it.
- `lib/daemon.mjs` — record it in the constructor beside `gatePromptPolicy` (`:46-48`), and enforce it
  in `_startTurn()` immediately after the prompt-hash check (`:217-220`): a `review` gate rejects
  `mode === 'plan'`; an `architect` gate rejects a plain send. Return a distinct error, e.g.
  `{error:'wrong_gate_turn_kind', expected:'send'}`. This is a synchronous refusal before `_beginTurn`
  — no `gen` spent, no turn started, exactly like the prompt gate.
- `lib/daemon.mjs` — add `gate` to the `gate_snapshot` reply (`:176-185`), and in
  `scripts/gate-attest.mjs` cross-check `--gate` against it in the identity block (`:269-280`),
  alongside the existing prompt-policy set comparison (`:276-279`).

Cost of the mistake drops from "a 17-minute review, discarded" to "one CLI call fails in
milliseconds".

### FIX 2 — state the gate↔verb rule where the dispatcher reads *(cheap; would also have caught it)*

- `commands/codex-issue.md` §3 step 4 (`:137-139`) and §6 step 4 (`:246-247`): name the verb the
  helper must use and say why — *"the helper must drive the architect gate with `plan --prompt-file`
  and the review gate with `send --prompt-file`; `gate-attest collect` keys on the turn kind and
  refuses the other with `wrong_turn_kind` (`scripts/gate-attest.mjs:319`)."* The dispatcher writes
  its own helper prompt from this file; today the file leaves the verb entirely to the agent
  definition.
- `skills/codex-claude/SKILL.md:226-227`: the `plan` / `send` rows list every error a turn can return
  but not the downstream attestation consequence. Add `wrong_turn_kind` to the `read`/gate discussion,
  or note on the `kind` field description (`:232`) which gate accepts which value.

Per **I4**, treat this as necessary but not sufficient — pair it with FIX 1.

### FIX 3 — teach the dispatcher to probe before declaring a round dead *(recovers this exact case)*

- `commands/codex-issue.md:145-146` and `:254`: before choosing `--outcome failed|timeout`, require
  `codex-drive.mjs status --socket "$GATE_SOCKET"`. If `turnStatus` is `completed`, the round is
  **collectable with `--outcome completed`** — the helper's death is not the turn's. Add explicitly:
  *"a Task that errored, was interrupted, or was denied says nothing about the turn; the daemon is
  detached and the turn runs to completion regardless."*
- `skills/codex-claude/SKILL.md:284-285`: extend the orphaned-daemon note from "stop it" to
  "**the turn keeps running and finishes**; probe `status --socket`, and if it completed, `read` /
  collect it before stopping." This is the fact that already exists as tribal knowledge in this repo's
  memory (`codex-turn-survives-subagent-death`) and is absent from the plugin.

### FIX 4 — `gate-attest collect` should salvage the text it is refusing to certify

**Proposal.** In `scripts/gate-attest.mjs`, every refusal from `:295` onward runs with
`snapshot.message` already in memory (`:282-285`). Before each such `refuse(...)`, write it to a
clearly non-authoritative path — `${artifactPath}.unattested`, or an explicit `--salvage <path>` — and
name that path on stderr. Do **not** write `attestation.json`, do **not** change the exit code, do
**not** touch `artifactPath` itself.

**For.**
- The plugin already does this, for the same refusal class, in `scripts/commit-review-collect.mjs:427-429`
  → `:445`. Two collectors in one plugin with opposite policies on "wrong kind" is an inconsistency,
  not a considered difference.
- The certification guarantee is carried entirely by the **exit-0 line** — the script says so itself
  (`:420-422`: *"a gate is authorized by THIS exit-0 line, in the turn that ran it"*). A file that is
  not `artifactPath`, with no attestation beside it, cannot be mistaken for authorization; the
  `preexisting_artifact` guard (`:334`) keeps the real path exclusive either way.
- The alternative is worse in practice: the dispatcher recovers the text by hand (as here) or from the
  Codex UI, with no provenance at all. Salvage gives an *attributable* copy on the very path the
  collector controls.
- The lock is never released (`:146-150`), so "just run collect again" is **not** a recovery. If the
  text is not written during this invocation it is gone with the daemon.

**Against.**
- The file header's threat model (`:6-30`) is that anything not collected from a live daemon is
  forgeable. An unattested file sitting in the run directory is a thing a later step could pick up by
  mistake — and `/codex-issue` §6/§7 reads findings from a **file path** (`commands/codex-issue.md:260-261`,
  `:281`), so a mis-typed path is a realistic way to feed an uncertified review into the fix loop. The
  `.unattested` suffix mitigates but does not eliminate this.
- For the `declared_failed` / `declared_timeout` ceiling specifically (`:295-296`), the dispatcher has
  *already decided* the round is dead; handing back a readable review invites re-litigating that
  decision, which is exactly what the ceiling exists to prevent.

**Recommendation.** Salvage on the *structural* refusals — `wrong_turn_kind`, `empty_result`,
`unusable_plan`, `prompt_mismatch` — where the dispatcher's intent was a real round and the failure is
mechanical. Keep `declared_failed` / `declared_timeout` discarding, since there the dispatcher's own
declaration is the reason. Gate the whole behaviour behind an explicit `--salvage <path>` so it is
never a silent side effect. `test/gate-attest.test.mjs:228-241` asserts only `reason` and `stopped`,
so this change does not break the existing test — it needs new assertions.

### FIX 5 — give `gate-attest` a durable outcome record and a recovery reader

`scripts/commit-review-collect.mjs:193-227` persists `phase` before flushing stdout precisely because
"stdout is a pipe a dropped turn can lose", and `scripts/commit-review-status.mjs` reads it back.
`gate-attest.mjs` has neither; its refusals leave a run directory that is indistinguishable from one
where collect was never run (verified: `/tmp/cdx-gate-review.aE9ze6/` = `collect.lock` + `start.json`).
Write a `refusal.json` (`{reason, stopped, collectedAt}`) on every refusal past the lock, using the
existing `atomicWrite` (`:368-387`), and ship the reader.

### FIX 6 — make live `--private` daemons discoverable

`lib/doctor.mjs` — `doctorReport()` (`:39-45`) should enumerate live daemons, not just Codex health.
The machinery already exists: `startDaemon` already scans `store.baseDir` for housekeeping
(`bin/codex-drive.mjs:266-272`). Extend `doctorReport()` to list `*.sock` in
`join(homedir(), '.codex-drive')`, probe each with `{cmd:'status'}` on a short timeout, and report
`{socket, pid, threadId, turnStatus, cwd, lastEventAgoMs}` per responder — plus prune sockets whose
`connect` yields `ENOENT`/`ECONNREFUSED`. That single change would have shown the dispatcher a
`turnStatus: "completed"` session at 14:57Z, when it was instead telling the user the daemon was idle,
and it gives `/codex-doctor` and any human a way to find orphans.

A TTL or reaper inside `lib/daemon.mjs` is **not** recommended: an ultra turn is expected to be silent
for long stretches (`lib/daemon.mjs:663-667` exists precisely to keep delegated-subagent silence from
reading as death), so any idle timer risks killing the turns the detached design exists to protect.
Visibility, not automatic termination, is the right lever.

### FIX 7 — minor: dangling doc reference in the shipped cache

Six shipped files cite `docs/bugs/subagent-messages-not-delivered-to-main-thread.md`
(`README.md:60`, `scripts/gate-attest.mjs:7`, `skills/codex-claude/SKILL.md:166`,
`commands/codex-issue.md:47`, `commands/codex-review.md:25`, `agents/codex-architect.md:26`,
`agents/codex-impl-reviewer.md:31`) as the rationale for the entire dispatcher-owned gate design. The
cache copy ships `docs/plans`, `docs/specs` and `docs/WORKFLOW-MODE.md` only — `docs/bugs/` is absent,
so every one of those references is unresolvable for anyone reading the installed plugin. Either ship
the file or inline a two-sentence summary at `scripts/gate-attest.mjs:7`.

---

## Evidence appendix

### Files

| Path | Contents |
|---|---|
| `/tmp/cdx-idle-evidence/start.json` | the `start` record (quoted in full above) |
| `/tmp/cdx-idle-evidence/status.json` | `turnStatus: "completed"`, `eventCount: 5712`, `lastEventAgoMs: 1682526` |
| `/tmp/cdx-idle-evidence/read.json` | 5567 bytes; `status: completed`, `kind: "plan"`, `turnToken: 1`, `parsedVerdict: "ISSUES FOUND"`, message 5350 chars |
| `/tmp/cdx-idle-evidence/ps.txt` | pid 59591, `ELAPSED 45:56`, full `__daemon` payload incl. `"private":true` and the gate policy |
| `/tmp/cdx-idle-evidence/drive-dir.txt` | `d-59590-mslvym0y.sock` + `state.json` — the socket was the daemon's only trace |
| `/tmp/cdx-gate-review.aE9ze6/` | **after** the refusal: `collect.lock` (0 B), `start.json`. No `review.md`, no `attestation.json`. |
| `/tmp/cdx-gate-prompts.3RZMEY/` | `brief` (6209 B), `prompt` (47216 B), `retry` (1016 B) — hashes verified by the helper against the gate policy |
| `…/50742425-…/subagents/agent-a7c03b767254a2c3a.jsonl` | the helper's complete 22-line transcript |
| `…/50742425-…/subagents/agent-a7c03b767254a2c3a.meta.json` | `{"agentType":"codex-claude:codex-impl-reviewer","description":"§6 architect-vs-plan review r2","toolUseId":"toolu_01SSTp4EDkaFiNsPLJUzvpTj","spawnDepth":1}` |
| `…/50742425-5ce3-4f26-81cd-1ba5bc5c0f9b.jsonl` | dispatcher transcript; `Agent` at 14:16:50.346Z, rejection at 14:31:07.398Z, collects at 15:02:44 / 15:02:55 |

`~/.codex-drive/` after the fact: `state.json` only, mtime **Jul 18** — untouched by the private
session, confirming `bin/codex-drive.mjs:307-309`. pid 59591 is gone; teardown was confirmed by the
collector (`stopped: true`).

### Timing arithmetic

| Fact | Derivation |
|---|---|
| daemon start ≈ 14:16:28Z | 15:02:24.5Z − `ELAPSED 45:56` |
| turn start 14:17:17.7Z | `{"ok":true,"status":"running"}` reply |
| last event ≈ 14:34:22Z | 15:02:24.5Z − `lastEventAgoMs 1682526` (28 m 2.5 s) |
| turn duration ≈ 17 m 5 s | 14:34:22 − 14:17:17 |
| driver died 14:31:07.4Z | rejection timestamp |
| **turn outlived driver ≈ 3 m 15 s** | 14:34:22 − 14:31:07 |
| event growth after the last poll the helper saw | 3724 → 5712 (+1988) |

### Plugin source references used

`bin/codex-drive.mjs:218`, `:266-272`, `:276-278`, `:305`, `:307-309`, `:313-314` ·
`lib/daemon.mjs:13`, `:46-48`, `:176-185`, `:209-243`, `:217-220`, `:236-239`, `:469-479`, `:523-538`,
`:663-667`, `:739-756`, `:829-830` ·
`lib/state.mjs:6-9` · `lib/doctor.mjs:39-45` · `lib/verbs.mjs:102-128`, `:140-147`, `:168-182` ·
`scripts/gate-attest.mjs:6-30`, `:128-130`, `:146-150`, `:269-280`, `:282-285`, `:288`, `:292-296`,
`:300-326`, `:334`, `:368-387`, `:420-426` ·
`scripts/commit-review-collect.mjs:193-227`, `:263-268`, `:335-345`, `:403-447` ·
`commands/codex-issue.md:137-139`, `:145-146`, `:246-247`, `:254`, `:260-277`, `:281` ·
`agents/codex-architect.md:26`, `:42`, `:80-82`, `:140` ·
`agents/codex-impl-reviewer.md:26`, `:31`, `:36`, `:47`, `:53`, `:62-63`, `:189` ·
`skills/codex-claude/SKILL.md:166`, `:226-227`, `:232`, `:278-285` ·
`test/gate-attest.test.mjs:216-241` · `README.md:60`

### What could not be determined

1. Whether the user denied the helper's inner Bash call or interrupted the agent as a whole (**I1**).
2. Whether Claude Code's `tool_result` text differs between a pre-execution Agent denial and a
   mid-flight interruption — one sample only (**I2**).
3. Whether the review text arrived on the plan stream or the agent-message stream, i.e. whether
   `plan` mode altered the content (**I3**). The daemon is stopped; nothing recorded the channel.
4. Why the helper preferred the dispatcher's `plan` over its own definition's `send` (**I4**) — only
   the most economical explanation is offered.
