# 1.8.8 — owned-session primary path + turn activity signal

## The incident that forced this

A production `/codex-issue` run (boomi-mcp-server issue #136, plugin 1.8.7, 2026-07-19) ran the
architect's `plan-round.mjs --effort ultra` as one foreground Bash call. The Bash tool's hard 10-min
cap fired; the harness moved the process to background and SIGTERMed it ~30 s later; plan-round's
signal handler tore down its **in-process** daemon — killing a healthy 20-minute Codex plan session
mid-turn. The agent's step-4 owned-session fallback then redid everything from scratch (a fresh
`thread/start`, zero carried context) and completed in 20 m 08 s. Observable cost per ultra run:
~10 wasted minutes, an orphaned abandoned chat in the Codex UI, and full re-exploration.

Root cause is structural, not a timeout value: the ephemeral round drivers host the daemon +
app-server inside a mortal Bash-capped process, so the process's fate is the session's fate. The
drivers' own 540 s caps were blameless — the log shows the poll-interval rewait working as designed
("wait cap expired — turn still running, re-waiting").

## The fix (this release)

1. **Owned-session primary.** `agents/codex-architect.md` and `agents/codex-impl-reviewer.md` now
   drive a detached `start --private` daemon as THE path (no `*-round.mjs` invocation at all):
   socket + wall-clock anchor persisted as sidecar files of the unique prompt path (`.sock`, `.t0`),
   the turn polled with `wait --timeout-ms 300000` in separate Bash calls. No Bash cap or signal can
   reach the session; requirement: NEVER kill a working session mid-work.
2. **Turn activity signal.** `lib/daemon.mjs` stamps `lastEventAt`/`eventCount` per turn — in
   `_dispatchNotification` (each own-thread event exactly once, replay-safe), in `_onNotification`'s
   foreign-thread drop branch (ultra's delegated subagent threads are activity, or a healthy
   delegation phase would false-positive as stuck), and in `_onServerRequest` below its buffer
   branch. `status` reports additive `lastEventAgoMs` (daemon-side `Date.now()` math; raw stamps are
   not cross-process comparable) + `eventCount`.
3. **Enriched wait timeout.** `bin/codex-drive.mjs`: a timed-out `wait` issues a bounded (10 s)
   best-effort `status` probe and prints `{"status":"timeout"[,turnStatus,lastEventAgoMs,eventCount]}`
   (exit 2 unchanged) — one Bash call per poll, decision data at the decision point.
4. **Recipe decision table.** WORKING = `lastEventAgoMs < 900000` → poll again, indefinitely;
   STUCK = ≥ 15 min silence → graceful `interrupt` → `wait 30 s` → `read` (architect: no `--out` —
   a partial plan must never look approved) → `stop`; BACKSTOP = 60 min wall clock (`.t0`) → same
   graceful exit; a probe-less timeout is a strike, two strikes = stuck. In-session thin-output
   retry: architect re-asks with the **`plan` verb** (only an explicit plan turn prefers the plan
   stream), reviewer with a plain `send` (the review rides the agent-message stream).

## Deliberately unchanged

- `scripts/plan-round.mjs` / `scripts/review-round.mjs` — kept as short-turn in-process one-shots
  (docs reframed); no longer referenced by any agent recipe.
- `scripts/commit-review-round.mjs` — keeps its hard total deadline + interrupt-on-expiry: a shell
  gate must fail fast (2026-07-18-open-issues.md, "Accepted, not open").
- The 540000 caps inside the round scripts vs the recipes' 300000 polls: the former are one-shot
  client caps, the latter is the owned-session poll cadence. Do not "reconcile" them.
- Wire shapes: all new fields are additive. `_completedResult`/terminal wait shapes, `_interrupt`
  returns, `VERB_FLAGS` (no new CLI flags) untouched.

## Tests

`TICKS` mock mode (streaming heartbeat) + daemon tests pinning the stuck signature (HANGTURN: ago
grows, count still), the working signature (TICKS: count rises, ago small), per-turn reset,
replay-exactly-once (BURSTTURN → eventCount === 3), server-request + foreign-thread stamping, and a
detached-CLI test asserting the enriched timeout JSON. Suite: 247 tests, 244 pass / 3 live-skipped.
