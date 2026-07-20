# 1.8.9 — detached review as the primary Stage-2 gate

## The incident that forced this

boomi-mcp-server issue #137 (plugin 1.8.8, Codex CLI 0.144.5) ran the documented Stage-2 gate,
`node "$CRR" --base "$BASELINE"`, and got `STATUS: timeout` / exit 2 after the full internal budget.
The retry the consumer's CLAUDE.md prescribes failed identically. So did a third run against a diff
**one sixth** the size — 7 files / 835 insertions versus 17 files / 4,868. The failure is
deterministic, not flaky, and not diff-size driven: at the configured effort the turn simply takes
longer than the cap.

Telemetry sampled while it ran showed a perfectly healthy turn —
`{"turnStatus":"running","lastEventAgoMs":4023,"eventCount":369}`. The one-shot was killing exactly
that case. Recovered through the owned-session fallback, the same review returned **9 findings, all
of which were genuine defects**: the review was never the problem, only the runner.

Cost per round: ~18 wasted minutes across the timeout plus its useless retry, and — because the
one-shot hosts its daemon in-process and tears it down on every exit path — the in-flight review
text was destroyed rather than left recoverable.

## Why the obvious fix is wrong

The bug report proposed aligning `commit-review-round.mjs` with its siblings: add
`onWaitExpiry: 'rewait'`, enlarge `deadlineMs`. Both halves are rejected.

It is not an accidental divergence. The hard total deadline is a recorded decision
(`2026-07-18-open-issues.md:98`, under "Accepted, not open"; reaffirmed at
`2026-07-20-owned-session-primary.md:45-46`) and is pinned by `test/drive-loop.test.mjs:308`
("rewait must never weaken deadlineMs — the one-shot gate depends on that hard bound").

More decisively, it cannot work. The same list already records *"In-process rewait cannot beat the
Bash tool cap (~10 min/call)."* Bash's ceiling is 600000 ms against the script's 540000 ms cap, so
the change buys **60 seconds** and then SIGTERM (`commit-review-round.mjs:100-118`) tears down the
in-process daemon — trading an honest `STATUS: timeout` for an unreadable destroyed session. The
problem is structural, exactly as diagnosed for the architect path in 1.8.8: a driver that hosts its
daemon inside a mortal Bash-capped process makes the process's fate the session's fate.

## The fix (this release)

1. **Detached primary.** The Stage-2 gate now runs the native review on a detached `--private`
   daemon polled in SEPARATE Bash calls — the 1.8.8 shape, extended to the `review` verb. The
   session is started with the review profile (`--sandbox read-only --approval-policy never
   --ephemeral`), without which `review` returns `{error:"wrong_thread_profile"}`
   (`daemon.mjs:215`). Session state (socket, pid, baseline, start HEAD, dirty flag, scope, pinned
   cache dir) lives in a unique `mktemp -d` run directory, never a shared path and never inside the
   reviewed repo. Policy — 5-min polls, 15-min inactivity, 60-min backstop, two missing-probe
   strikes — stays **prose**, identical to the reviewer agent's table.

2. **One narrow production helper.** `scripts/commit-review-collect.mjs` does the terminal step
   only: cross-check ownership (socket sidecar vs `start.json`, thread id, and the daemon's own
   reported cwd), `read`, `stop`, **confirm** teardown, then emit the raw review followed by
   `STATUS:` and `SCOPE: <label> head=<sha> dirty=<bool>`. It owns no polling, stall or retry logic.
   It exists because this output is what the enforcement hook parses, and a prose recipe already
   lost that contract once — the daemon-verbs fallback ended in `read --out`, one JSON line with no
   `SCOPE:`, so the review silently escaped the gate (the hook's own header still documented it as a
   KNOWN GAP). Prose is fine for policy; it is not fine for a contract another program parses.

3. **Fail-closed everywhere it matters.** `--outcome` is a ceiling, never a promoter: a turn that
   finishes during an abort cannot be laundered into a clean review. A blank body on a `completed`
   turn is a downgrade, not a pass. An unconfirmed teardown downgrades a would-be completion and
   prints a recovery command, because `stop` responds *before* the app-server actually dies. An
   ownership mismatch stops **nothing** — tearing down a session we cannot identify is how one agent
   kills another's review and orphans its own. Only a confirmed-clean completion advances
   `last-reviewed-sha`.

4. **Dirty-tree review preserved.** An earlier draft required a clean worktree. That would have
   broken the consumer's entire fix sub-loop, which reviews uncommitted fixes through `auto` scope
   by design (`boomi-mcp-server/CLAUDE.md:87-88`), and which `git-scope.mjs:192` actively steers
   callers toward. The trailer attests `head=<start HEAD> dirty=<true|false>` from the **recorded**
   state instead — deliberately not a content hash, and deliberately not recomputed at collect time,
   so an edit made mid-review cannot rewrite what the attestation claims.

## Deliberately unchanged

- `scripts/commit-review-round.mjs` — still a short-turn one-shot with a hard total deadline and
  interrupt-on-expiry. A one-shot gate must fail fast, and no achievable cap increase beats the
  outer Bash ceiling. Its regression is now *stricter*, not relaxed (below).
- `lib/drive-loop.mjs`, the daemon/client wire shapes, `VERB_FLAGS`. No new CLI flags: the recipe is
  built entirely from existing verbs, which is what let it be prose.
- The bug report's acceptance criteria 1 and 3 are **superseded**: the long reproduction must
  complete through the detached path, not through `$CRR`, and `$CRR` does not gain a timeout knob
  that would still lose to the Bash cap. Criteria 2 (a genuinely wedged turn still terminates on a
  bounded honest timeout) and 4 (consumer retry guidance revisited) remain required and are met.
- The Codex `supports_reasoning_summaries` cache warning stays out of scope. It is upstream, and
  surfacing it is not a recipe change: `bin/codex-drive.mjs:242-244` spawns the detached daemon with
  `stdio:'ignore'` while `lib/appserver.mjs:21` gives the app-server `['pipe','pipe','inherit']`, so
  its stderr inherits into `/dev/null`. That needs a runtime-observability design of its own.

## Tests

Two new `--review-mode` fixtures on the allowlisted `review/start` axis, which previously had no way
to model liveness at all: `ticks` (heartbeat via `item/reasoning/delta` — deliberately outside
protocol.mjs's `NOTIFY` map, so it stamps activity without contaminating the review body) and `hang`
(silent forever). `noresponse` was *not* reused: it streams every notification and withholds only
the JSON-RPC response, so it exercises the daemon's completion backstop rather than stall detection.

`test/commit-review-collect.test.mjs` (13 tests) drives the real detached CLI end-to-end and pins the
collector: positional trailer ordering against a `statusinbody` decoy, blank-completed downgrade, the
`--outcome` ceiling, `dirty=` attested from recorded state after a mid-review mutation, ownership
refusals (socket / thread / cwd) that leave the daemon running, missing `start.json` as a
trailer-less exit 1, and the unconfirmed-teardown downgrade — the last made testable in ~1s by a new
`CODEX_DRIVE_TEST_TEARDOWN_MS` seam, gated fail-closed behind `CODEX_DRIVE_TEST_MODE=1` like its
siblings.

`test/detached-cli.test.mjs` gains the end-to-end liveness pins: a `ticks` review surviving **≥2**
client-side wait expiries with `eventCount` rising and `lastEventAgoMs` small, then completing
uninterrupted with its real text; a `hang` review whose `eventCount` freezes while silence ages; two
concurrent private sessions where stopping one leaves the other responsive; and a check that
reviewing a repo — clean or dirty — leaves its `git status` byte-identical.

`test/commit-review-round.test.mjs`'s cap-expiry regression was tightened from
`timeout || failed` (which could not detect a regression in either direction) to exactly
`STATUS: timeout` plus the `total wait budget exhausted` stderr, switching the fixture from
`noresponse` to `hang` so the client cap — not a backstop race — is unambiguously what ends it.

Suite: 264 tests, 261 pass / 3 live-skipped.
