# A named teammate's final report is never delivered to the dispatcher — the main thread sees only a contentless idle notification, hours late

**Component:** Claude Code harness — `Agent` tool teammate mode (`taskKind: "in_process_teammate"`). **Not** a `codex-claude` defect, but it disables `/codex-issue`'s architect and review gates, and a `codex-claude`-specific secondary defect is documented below.
**Version observed:** Claude Code with Opus 5 (`claude-opus-5[1m]`); `codex-claude` 1.8.19
**Severity:** High — a dispatcher cannot receive any subagent's result within the turn that dispatched it, so every gate built on `Task`/`Agent` silently degrades to "agent appears hung", and the work is either lost or redone by hand.
**Status:** Open. No fix attempted. Workaround below is proven (it is what rescued the observed run).
**Reported:** 2026-07-25
**Reporter:** observed during `boomi-mcp-server` issue #140 (`/codex-issue 140`, session `c9bbc94a-0af6-42f3-9edf-f611109f08c3`)

---

## Summary

Six subagents were dispatched with the `Agent` tool passing **both** `name` and `subagent_type`. All
six completed their work correctly. **None of their reports reached the dispatching thread while it
was running.** The dispatcher concluded three of them had hung, abandoned them, and redid their work
by hand — roughly three hours of duplicated effort — and came within one decision of recording a
required review gate as not-run.

Two independent defects combined:

1. **Primary — the return value is discarded.** For a teammate, the agent's final assistant message
   (which the `Agent` tool documents as *"the agent's final report"*) is not returned to the
   dispatcher at all. The dispatcher receives only a contentless `idle_notification`. Four of the six
   agents reported this way; **their report bodies appear nowhere in the main thread's transcript.**
   The two that additionally called `SendMessage` did have their bodies delivered — but not until the
   next user turn, 1h13m and 3h36m later.
2. **Secondary — the `subagent_type` is silently dropped.** Passing `name` *and* a
   **plugin-namespaced** `subagent_type` (`codex-claude:*`) puts the agent in teammate mode and
   discards the type. Three agents intended to be `codex-architect` / `codex-planner` /
   `codex-impl-reviewer` ran as **generic assistants** with no plugin system prompt. An
   **unnamespaced project-local** type (`boomi-qa-tester`) survives, which is why the failure was not
   uniform and took hours to characterise.

**This is the key data point:** delivery is *asymmetric*. Lead → teammate messages arrived in **569 ms**
and **166 ms**. Teammate → lead replies, sent successfully at 16:27:02.741Z and 18:49:54.700Z, were
both delivered in a **single batched user-turn injection at 20:02:51.849Z**.

---

## Environment

| | |
|---|---|
| **Harness** | Claude Code, `Agent` tool, `taskKind: "in_process_teammate"`, `teamName: session-08df2997`, `spawnDepth: 0` |
| **Model** | `claude-opus-5[1m]` (all agents; `"model":"claude-opus-5"` in every `.meta.json`) |
| **Plugin** | `codex-claude` 1.8.19 (cache `~/.claude/plugins/cache/renera-ai-tools/codex-claude/1.8.19/`) |
| **Repo under work** | `boomi-mcp-server`, issue #140, branch `codex/issue-140` |
| **Local timezone** | EDT (UTC−4) — relevant only because notification timestamps are UTC-labelled and convert exactly; **the timestamps are correct and are not part of this bug** |
| **Artifacts** | `~/.claude/projects/-Users-gleb-Documents-Projects-Renera-boomi-mcp-server/c9bbc94a-.../subagents/agent-*.jsonl` + `agent-*.meta.json`; main transcript `…/c9bbc94a-….jsonl` |

---

## Reproduction

Dispatch a subagent with **both** `name` and `subagent_type` and wait for it in the same turn:

```
Agent({
  name: "implrev140",
  subagent_type: "codex-claude:codex-impl-reviewer",
  run_in_background: false,
  prompt: "<review task>"
})
```

Observed: the tool returns immediately with
`Spawned successfully … agent_id: implrev140@session-… The agent is now running`, and **nothing
further arrives in that turn**, regardless of how long the dispatcher waits.

### Attempt 1 — poll and wait (the documented pattern)

The dispatcher polled for **~3 hours** on `qa140c` and **~57 minutes** on `implrev140`, then gave up
and redid both agents' work in the main thread. Both agents had in fact finished long before.

| Agent | Finished (transcript last write, UTC) | Dispatcher gave up | Wasted |
|---|---|---|---|
| `qa140c` | 14:42:05.237Z | ~17:32Z | 2h 50m |
| `implrev140` | 17:52:48.595Z | ~19:08Z | 1h 15m |

### Attempt 2 — `SendMessage` status check

The dispatcher sent each a status check. **The outbound direction works and is fast:**

```
main → qa140c    sent 16:26:12.129Z   received 16:26:12.698Z   (569 ms)
main → implrev140 sent 18:49:17.119Z   received 18:49:17.285Z   (166 ms)
```

Both agents replied promptly (50 s and 37 s later), and both `SendMessage` calls reported explicit
success:

```json
{"success":true,"message":"Message sent to team-lead's inbox",
 "msg_id":"d7a854a0-b0d0-4a09-ace1-e589dd2f65fe",
 "routing":{"sender":"qa140c","target":"@team-lead"}}
```

**Neither reply reached the dispatcher during the turn.** No error, no queued marker, nothing.

### Control — an unnamed subagent returns normally

`architect140`'s *first* `Agent` call passed a `name` and was rejected:

> Teammates cannot spawn other teammates — the team roster is flat. To spawn a subagent instead, omit the `name` parameter.

It retried **without** `name`. That call created `agent-ab63fc5c5dadbaa13`
(`agentType: "codex-claude:codex-architect"`, `spawnDepth: 1`) — which received the real plugin system
prompt, ran the real recipe, and **returned its result normally**. This is the positive control for
both defects at once: no `name` → correct type applied → result delivered.

---

## Evidence

Line anchors are against the session subagent directory
`~/.claude/projects/-Users-gleb-Documents-Projects-Renera-boomi-mcp-server/c9bbc94a-0af6-42f3-9edf-f611109f08c3/subagents/`.

### E1 — Four of six agents' reports exist only in their own transcripts

Each agent ended with a substantial final assistant message. Grepping the **main thread's** transcript
for those exact strings returns **zero hits** for every one of them:

| Agent | Final report (first words) | Size | In main transcript? |
|---|---|---|---|
| `architect140` | "The architect plan is saved, and I closed the live-grounding gap" | — | **no** |
| `planner140` | (the full implementation plan) | — | **no** |
| `qa140` | "QA gate for #140 complete…" | 3 773 chars | **no** |
| `qa140b` | "Zero issues. Bug #173 is verified fixed…" | 4 712 chars | **no** |

The dispatcher received, for each, only an `idle_notification` carrying no report content.

### E2 — Everything arrived at once, in the next user turn

Main transcript line 1272 is a **single** `type=user` entry, timestamp **2026-07-25T20:02:51.849Z**,
containing ten `<teammate-message>` blocks: eight `idle_notification`s (12:54:52.564Z → 18:50:02.264Z)
plus the two `SendMessage` bodies. Every notification is 30–250 ms after its agent's final message —
i.e. **generated on time, delivered together, hours later.**

### E3 — Transcript mtimes corroborate completion times

`ls` mtime (EDT) vs last transcript entry (UTC) — exact ±0 s conversion, confirming each agent simply
stopped when it finished:

| Agent | mtime (EDT) | last entry (UTC) |
|---|---|---|
| `architect140` | 08:54 | 12:54:52Z |
| `planner140` | 08:57 | 12:57:55Z |
| `qa140` | 09:45 | 13:45:21Z |
| `qa140b` | 10:13 | 14:13:44Z |
| `qa140c` | 12:27 | 16:27:10Z |
| `implrev140` | 14:50 | 18:50:02Z |

### E4 — The agents believed they had reported successfully

`qa140c`'s reply: *"Status: the round is COMPLETE — nothing in flight, nothing blocking. My full report
went out just before your check-in."* Its own thinking at 16:26:25.030Z: *"No work is in flight — the
round is finished."*

Both agents also mis-estimated elapsed time in the same direction as the gap: `implrev140` said it had
posted findings *"~10 minutes ago"* when the actual interval was 56 m 14 s.

### E5 — Only the *filesystem* rescued any work

The three agents whose output survived are exactly the three that happened to write a file the
dispatcher could poll. This is coincidence, not design:

| Agent | Side-channel it wrote | Recovered? |
|---|---|---|
| `architect140` | `.codex/plans/issue-140.md` (+ captures) | yes — by polling the file |
| `qa140` | `agents/REPORT.MD` | yes — by polling the file |
| `qa140b` | `agents/REPORT.MD` | yes — by polling the file |
| `planner140` | none | **no** — dispatcher wrote its own plan |
| `qa140c` | scratchpad only | **no** — dispatcher redid the QA |
| `implrev140` | none | **no** — dispatcher drove Codex itself |

---

## Root-cause analysis

### 1. The teammate return path drops the payload

The `Agent` tool documents the final message as the agent's report. In teammate mode that payload is
not routed to the dispatcher; only a lifecycle event is. **Inferred, not established:** the
`idle_notification` appears to be the *only* dispatcher-facing signal for a teammate, with report
content assumed to travel via `SendMessage`. If so, the tool description is wrong for teammates, and
nothing tells an agent that its final message will be discarded — four of six agents used it in good
faith.

### 2. Teammate → dispatcher delivery is deferred to a user turn

`SendMessage` bodies *do* survive, but they were injected as a `type=user` entry rather than reaching
the running assistant turn. The dispatcher-facing channel therefore has no intra-turn path at all.
This has not been measured beyond this one session and should not be treated as confirmed for other
harness versions.

### 3. Polling cannot compensate

Nothing observable to the dispatcher distinguishes "still working" from "finished 3 hours ago": no
inbox, no roster/status query, no completion file. The only reliable liveness signal in the observed
run was the **absence of a `codex app-server` process**, which is specific to codex-driving agents and
is what (correctly) prompted the dispatcher's status check.

### 4. Why the failure looked intermittent

Three of six agents *seemed* to work. All three were recovered through unrelated file side-channels
(E5). Nothing about the message path differed. This is what made the defect take hours to
characterise rather than minutes.

---

## Secondary defect — a plugin-namespaced `subagent_type` is silently dropped in teammate mode

Passing `name` **and** `subagent_type` records `taskKind: "in_process_teammate"` and, for a
**plugin-namespaced** type, records **no `customAgentType`** — the plugin system prompt is never
applied. An **unnamespaced project-local** type survives.

| Agent | Requested `subagent_type` | `customAgentType` recorded | Ran as |
|---|---|---|---|
| `architect140` | `codex-claude:codex-architect` | **absent** | generic assistant |
| `planner140` | `codex-claude:codex-planner` | **absent** | generic assistant |
| `implrev140` | `codex-claude:codex-impl-reviewer` | **absent** | generic assistant |
| `qa140`, `qa140b`, `qa140c` | `boomi-qa-tester` (project-local, no prefix) | `"boomi-qa-tester"` | correct agent |
| `agent-ab63fc5c…` (depth 1, **no `name`**) | `codex-claude:codex-architect` | n/a — `agentType` **is** the plugin type | correct agent |

**Proof the plugin prompt was absent, not merely unrecorded:**

- `codex-planner.md` declares `tools: Read`. `planner140` executed **17 Bash calls with zero tool
  errors** — impossible under that allowlist.
- `codex-impl-reviewer.md` declares `tools: Bash, Read, Write` and `skills: codex-claude`.
  `implrev140` used `ToolSearch` and `SendMessage` (outside the allowlist) and received the **full
  generic skill catalogue**, including unrelated `plugin-dev:*` skills.
- Both suspects' transcripts carry `deferred_tools_delta` + `skill_listing` attachments. The genuine
  plugin agent (`agent-ab63fc5c…`) has **zero** attachment lines.
- `implrev140` emitted `VERDICT: APPROVE WITH CHANGES`. `codex-impl-reviewer.md` permits only
  `NO ISSUES` / `ISSUES FOUND` / `UNCLEAR`, and the caller's prompt contained no `VERDICT` vocabulary
  at all — so the string came from neither the agent file nor the caller.
- Positive control: the genuine child ran the real recipe — 27 `codex-drive` occurrences, 26
  `cdx-plan` (the `mktemp -d /tmp/cdx-plan.XXXXXX` step), 2 `codex-drive.mjs doctor`, 1
  `wrong_thread_profile`.

### The consequence, and why the agent is not at fault

`implrev140` was dispatched to obtain an **independent Codex opinion**. Having no `codex-impl-reviewer`
identity, it reasonably read the prompt as "review this" and reviewed it **itself, as Opus 5** —
substituting the dispatcher's own model for the independent one the gate exists to obtain.

**It is important that this is not misread as the agent disobeying its mandate.** The agent file *is*
written fail-closed — `agents/codex-impl-reviewer.md:45-47` tells it to probe `codex-drive.mjs doctor`
and return `VERDICT: UNCLEAR` rather than fabricate a review, one of four `UNCLEAR` exits (L45-47,
L97, L160, L163). But **that mandate binds only the `codex-impl-reviewer` subagent, and `implrev140`
never was one.** It is a prompt-level instruction with no runtime enforcement, and it was never
loaded. The agent then *proactively disclosed* the substitution unprompted:

> **no Codex review turn was ever started.** … Record the additive Codex architect-review gate as
> NOT-RUN. … **This verdict is mine, not an independent model's** — do not record it as satisfying a
> Codex gate.

That disclosure is the only reason the gate substitution was caught. A less scrupulous agent — or the
same one with a less suspicious dispatcher — would have produced a plausible review that silently
replaced the gate. **A gate whose enforcement lives only in a system prompt that the harness may
silently fail to apply is not a gate.**

---

## Related defect found while investigating — `PARSED_VERDICT` is unreachable under the mandated recipe

Independent of the above, and a genuine `codex-claude` bug:

`agents/codex-impl-reviewer.md:171` instructs the agent to take its final verdict *"from the driver's
`PARSED_VERDICT:` line"*. That string is emitted **only** by `scripts/review-round.mjs` (lines 32 and
132) — the exact script the same file **bans** at lines 85-86 (*"do NOT run
`scripts/review-round.mjs`"*). The sanctioned `codex-drive.mjs read` never prints it.

```
grep -rn PARSED_VERDICT bin lib scripts agents commands
  scripts/review-round.mjs:32
  scripts/review-round.mjs:132
  agents/codex-impl-reviewer.md:171
```

Zero hits in `bin/` or `lib/`. An agent that follows the mandated recipe has no `PARSED_VERDICT` to
read and must improvise its verdict — the one step the contract most wants pinned.

---

## Impact

1. **~3 hours of duplicated work** in the observed run: the QA gate was re-executed in the main thread
   and the architect review was re-driven over `codex-drive` by hand, both reproducing results the
   abandoned agents had already produced.
2. **A required review gate was nearly recorded as not-run**, and was only rescued because the
   dispatcher drove Codex itself after giving up.
3. **`/codex-issue` is materially degraded** whenever its helper agents are dispatched with a `name`:
   the architect plan, the implementation plan and the impl-vs-plan review all lose their agent
   identity, and none of their results return.
4. **Silent, not loud.** No error is raised at any layer. Every `SendMessage` reported success; every
   agent believed it had reported; the dispatcher saw only silence.

---

## Proposed fixes, in priority order

### P1 — Deliver a teammate's final message to the dispatcher (harness)

Route the final assistant message to the dispatcher as the `Agent` tool's result, exactly as the tool
description promises. Failing that, make the `idle_notification` carry the report body.

### P2 — Deliver teammate → dispatcher messages intra-turn (harness)

The reverse direction already works in <1 s. Until it is symmetric, no dispatcher can supervise a
teammate within a turn.

### P3 — Fail loudly when a `subagent_type` cannot be applied (harness)

If `name` + `subagent_type` is unsupported for plugin-namespaced types, **reject the call** the way
teammate-spawning-teammate is already rejected:

> Teammates cannot spawn other teammates — the team roster is flat. To spawn a subagent instead, omit the `name` parameter.

That existing error is the correct model: it is exactly what caused `architect140` to retry without
`name` and get a working agent. Silently downgrading to a generic assistant is the failure mode; a
one-line refusal removes it.

### P4 — Give the dispatcher a status/inbox primitive (harness)

Any of: a roster query returning per-teammate state; a completion event the dispatcher can await; or
documenting that `run_in_background: false` does not mean "await the result".

### P5 — Make `codex-claude`'s gate agents self-attesting (plugin)

Do not rely on a system prompt that may never be applied. Have `codex-architect` /
`codex-impl-reviewer` write a small attestation file (socket id, `doctor` output, turn token, verdict)
and have `/codex-issue` **require** it. An agent that never ran Codex cannot forge one, so the gate
stops depending on the identity having loaded.

### P6 — Fix the `PARSED_VERDICT` contradiction (plugin)

Either emit `PARSED_VERDICT:` from the sanctioned `codex-drive.mjs read` path, or amend
`agents/codex-impl-reviewer.md:171` to name a source reachable under the mandated recipe.

**Trade-off:** P5 adds an artifact and a check to a path that is already long. It is worth it only
because P3 is not in this repo's control — if the harness lands P1+P3, P5 becomes belt-and-braces.

**Recommendation:** P1 + P3 are the real fixes and belong upstream. Ship **P5 + P6** in `codex-claude`
now, since they are the parts this repo owns and they make the failure detectable rather than silent.

---

## Workaround (proven — this is what rescued the observed run)

**Do not pass `name` when you need the agent's result.** Dispatch it as a plain subagent:

```
Agent({ subagent_type: "codex-claude:codex-impl-reviewer", prompt: "…" })   // no `name`
```

This applies the correct type *and* returns the result — the depth-1 control in this session did both.

If a `name` is required, drive the underlying tool yourself from the main thread. For a Codex review
that is:

```bash
DRIVE=~/.claude/plugins/cache/renera-ai-tools/codex-claude/1.8.19/bin/codex-drive.mjs
RUN_DIR="$(mktemp -d /tmp/cdx-implrev.XXXXXX)"
node "$DRIVE" start --private --cwd "$(git rev-parse --show-toplevel)" \
  --sandbox read-only --approval-policy never --ephemeral > "$RUN_DIR/start.json"
jq -er '.socket' "$RUN_DIR/start.json" > "$RUN_DIR/socket"
node "$DRIVE" send "$PROMPT" --socket "$(cat "$RUN_DIR/socket")"
# poll in SEPARATE Bash calls — a review outlives any single call:
node "$DRIVE" wait --timeout-ms 300000 --socket "$(cat "$RUN_DIR/socket")"
node "$DRIVE" stop --socket "$(cat "$RUN_DIR/socket")" --timeout-ms 10000
```

Notes:

- `--private` keeps this off the shared `~/.codex-drive` session; never `start --force`.
- `stop` must **always** run, including on the abort path.
- `send` takes a positional prompt; there is also a `review --base <sha>` verb for diff reviews, which
  is what this repo's `CLAUDE.md` Stage-2 gate uses.

**Mitigation while the bug stands:** require every dispatched agent to write its result to a file and
poll the file, not the agent. That is the only channel that worked in this session — and it worked
only by accident for the three agents that happened to use it.

---

## Acceptance criteria for a fix

1. An agent dispatched with `name` + `subagent_type` and `run_in_background: false` returns its final
   report to the dispatcher **within the dispatching turn**.
2. A teammate's `SendMessage` to the dispatcher is delivered in the same turn it is sent — measured
   against the <1 s outbound direction, not against a user turn boundary.
3. `Agent({name, subagent_type: "codex-claude:codex-impl-reviewer"})` either applies that agent's
   system prompt (verifiable: the transcript shows a `codex-drive` invocation and carries no
   `skill_listing` attachment) **or is rejected with an actionable error**. It never silently produces
   a generic assistant.
4. A `/codex-issue` run whose `codex-impl-reviewer` never reaches Codex fails the gate rather than
   emitting a verdict — verifiable by dispatching it with Codex logged out and asserting the run does
   not report a clean review.
5. `grep -rn PARSED_VERDICT` shows the string emitted by a driver the agent file permits.

---

## Out of scope / explicitly NOT bugs

- **The notification timestamps.** They are UTC-labelled (`…Z`) and convert to the local mtimes
  exactly; the 4-hour appearance is EDT = UTC−4 and nothing more. The delivery is late; the clocks are
  right.
- **The agents' own conduct.** All six did their assigned work correctly. `qa140c`'s abandoned round
  was *more* thorough than the main thread's replacement. `implrev140` volunteered that it was not
  Codex. Neither is a defect.
- **`codex-impl-reviewer.md`'s fail-closed design.** The agent file is correctly written; it simply
  was never loaded. The defect is that a prompt-level mandate has no runtime enforcement (P5), not
  that the mandate is wrong.
- **Teammates-cannot-spawn-teammates.** That refusal is correct and is the model P3 should copy.
- **`send` vs the `review` verb.** `codex-impl-reviewer` uses `send` with a self-composed prompt
  because it supplies its own plan-aware prompt; the `review` verb is used elsewhere (including this
  repo's `README.md:126` and `boomi-mcp-server`'s `CLAUDE.md` Stage-2 gate) and is not being avoided.

---

## Note for whoever files this upstream

The primary defect (P1–P4) is in the Claude Code harness, not in `codex-claude`. This is the repo's
first bug report against the harness rather than the plugin; it is filed here because `/codex-issue`
is where the failure surfaced and because P5/P6 are this repo's to fix. The full artifact set — six
subagent transcripts, their `.meta.json` files, and the main transcript containing the single batched
delivery at line 1272 — is preserved under
`~/.claude/projects/-Users-gleb-Documents-Projects-Renera-boomi-mcp-server/c9bbc94a-0af6-42f3-9edf-f611109f08c3/`.
