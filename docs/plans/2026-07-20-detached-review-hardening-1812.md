# 1.8.11 → 1.8.12 — third review round on the detached Stage-2 review

Round 3 of independent Codex review. Rounds 1–2 (1.8.9→1.8.11) fixed truncation, the attestation gate,
recipe variable scoping, the cleanup trap, the two-strike counter, positive ownership verification, and
the `kind` turn-binding. Round 3 found the `kind` binding was necessary but not sufficient, plus three
more real gaps. All fixed in **1.8.12**. The local cache is still 1.8.9 (no live review has run), so
nothing here is a field regression.

## Round 3 findings

### 1. `kind` proves the category, not the invocation (P1)

The round-2 fix required the collected turn to be `kind:'review'`, but review A then review B are
*both* `kind:'review'`. Reproduced: run review A (scope X, `review.json` captured), run review B (scope
Y) on the same session, collect — the collector read B's body and labeled it with A's scope and dirty
state, exit 0.

Fixed with a **per-turn token**. The daemon already has `gen`, a per-daemon monotonic id assigned
synchronously in `_beginTurn` (unlike `turn.id`, which the app-server assigns asynchronously and is
null when `_startReview` returns). `_startReview` now returns it as `turnToken` (so `review.json`
captures the exact invocation) and `_completedResult` exposes it (so `read` reports the *current*
turn's token). The collector requires both present and equal — review B carries a higher token than
`review.json` recorded for A, so it is refused rather than mislabeled. A test runs review A → review B →
collect and asserts the mismatch; verified it fails without the daemon change.

### 2. `/cr --wait` resume bypassed the version floor (P1)

A fresh start floor-checks the resolved cache, but resume executed `$(cat cache-dir)/…` directly — the
version that *started* the run, which could be a pre-fix 1.8.9. So an old run could resume and collect
with the vulnerable collector. Resume now re-asserts the same `sort -V` floor against the persisted
cache-dir and refuses a run started by a too-old runtime.

### 3. `review.json` was half-validated (P1)

Only `ok` and `scope` were checked; dropping `status:"running"` still certified. The collector now
requires the full record the `review` verb emits — `ok:true`, `status:"running"`, a non-empty `scope`,
and an integer `turnToken` — before `review.json` counts as proof of a native review.

### 4. Resume ownership was weaker than the collector (P2)

The resume probe compared only threadId/cwd from the live daemon. It now bounds the `status` probe
(`--timeout-ms 10000`), requires the `socket`/`pid`/`cwd` sidecars to be present and to agree with
`start.json` (the authority), and distinguishes a dead daemon from an unresponsive one via `kill -0`
on the recorded PID — the same discipline the collector applies.

## Revived P2 lifecycle gaps

- **Cleanup trap installed after the jq calls** → moved to fire the instant the daemon exists, reading
  the socket straight from `start.json` so a failing sidecar extraction can't leak the daemon.
- **Teardown evidence not persisted** → the collector writes `"$RUN_DIR/teardown"` (`confirmed
  <status>`) only after it has *proven* the daemon is gone.
- **Deletion allowed merely "after collection"** → the recipe now gates run-directory removal on that
  `teardown` file; its absence marks exactly the directories that still own a live daemon.
- **Unexpected `wait` exit codes evaluated too late** → the poll decision list now checks terminal and
  error cases before the keep-polling cases.
- **`/cr` allowlist** → added `basename`, `sort`, `head`, `kill`.
- **Fix rounds re-resolve the cache** → left as-is, and documented as deliberate: each run directory
  starts/polls/collects its own floor-checked daemon, so re-resolving is self-consistent even if
  `/plugin update` lands between rounds. This one was not a defect.

## Version

**1.8.12**, floor raised in all three recipes. It must be 1.8.12, not 1.8.11: the token binding splits
across the daemon (emits `turnToken`) and the collector (requires it), and only 1.8.12 ships the
matched pair.

## Tests

278 total, 275 pass, 0 fail, 3 live-skipped (was 275). `commit-review-collect.test.mjs` now covers 27
cases including review-A-then-B, a stripped `status`, and a stripped `turnToken`. The daemon `turnToken`
field is additive; the full suite is green.

## Still open

The live smoke test in a separate boomi worktree, unchanged since 1.8.9. `${CLAUDE_PLUGIN_ROOT}` binds
at session load, so it needs a fresh session after `/plugin update`.
