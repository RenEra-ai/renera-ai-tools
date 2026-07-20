# 1.8.10 → 1.8.11 — hardening the detached Stage-2 review

Two independent Codex review rounds of the detached-review work. 1.8.10 fixed the first round (stdout
truncation, attestation gate, recipe variable scoping, cleanup trap, two-strike counter). A second
round against 1.8.10 found four more P1s — all real, all fixed here in **1.8.11**. Neither 1.8.10 nor
1.8.11 has been used for a live review yet (the local cache is still 1.8.9 pending `/plugin update`),
so nothing here is a field regression.

## Round 2 findings

### 1. Missing ownership records still certified (P1)

1.8.10's ownership checks were *conditional* — `if (startCwd && st.cwd !== startCwd)`, `if
(persistedCwd && …)`, `pid = startPid ?? sidecarPid` — so deleting a sidecar, or a start.json stripped
of `cwd`/`pid`, skipped the very check it should have failed. Absence was read as "nothing to compare"
instead of "not provable".

Restructured to **positive verification by construction**: `threadVerified` and `cwdVerified` are set
only when a recorded value existed *and* the live daemon matched it, and the attestation gate requires
both, plus start.json `cwd`/`pid`, plus all three sidecars (`socket`, `pid`, `cwd`) present and
consistent. A cwd disagreement with a matching threadId is treated as tampered state and refuses
(stops nothing) rather than attesting a `head=` for the wrong tree.

### 2. A stale review.json could certify a later chat turn (P1)

`review.json` proves a review was once *started* on the session — not that the turn being collected is
that review. A real review followed by a plain `send` left `read` returning the chat turn while the
old `review.json` still validated, so the chat turn certified as a review.

Fixed at the daemon: `_completedResult()` now reports `kind: 'review' | 'plan' | 'turn'` for the
turn being read (it reflects the current, possibly reset, turn). The collector requires
`kind === 'review'`. `review.json` is kept as the "a review was issued" signal; `kind` is the
"the turn I am reading IS that review" binding. Pinned by a test that runs review → send → collect
and asserts the chat turn is refused.

### 3. Recipes did not enforce the required version (P1)

Both recipes only checked that `codex-drive.mjs`/the collector *existed* — and 1.8.9 has them too — so
`sort -V | tail -1` silently selected 1.8.9 whenever the required version was not yet cached. The
cache directory is named for the version, so the recipes now assert a floor:
`[ "$(printf '%s\n%s\n' "$VER" "$NEED" | sort -V | head -1)" = "$NEED" ]`, failing closed with "run
/plugin update" otherwise. Verified against the live cache: 1.8.9 is rejected; 1.8.11 passes.

### 4. `/cr --wait` resume was ownership-unsafe (P1)

The resume probe was an unbounded `status` call that compared nothing. A reused socket path would let
it poll — and ultimately collect — a *different* daemon serving a *different* repo. Rewritten to bound
the probe (`--timeout-ms 10000`), compare `threadId` and `cwd` against `start.json`, and on an
ambiguous error distinguish a dead session from an unresponsive one via the recorded PID (`kill -0`)
rather than assuming dead.

## Version

**1.8.11**, floor raised in all three recipes (`boomi CLAUDE.md`/`AGENTS.md`, `~/.claude/commands/cr.md`).
The floor must be 1.8.11, not 1.8.10: the P1-2 fix splits across the collector (requires `kind`) and
the daemon (provides it), and both ship in the same version-keyed cache — so only 1.8.11 has the
matched pair. Running the 1.8.11 recipe against a 1.8.10 cache is exactly what the floor now forbids.

## Deliberately unchanged

- Ownership failures still stop **nothing** — the split between "may we stop it" (threadId) and "may we
  certify it" (cwd + kind + records) is the whole safety model.
- Polling policy stays prose; the collector owns only the terminal contract.
- `commit-review-round.mjs` remains the short-turn one-shot on the two-field `SCOPE:`.

## Tests

275 total, 272 pass, 0 fail, 3 live-skipped (was 271). `commit-review-collect.test.mjs` now covers
24 cases including the review→send launder attempt, missing/stripped cwd and pid, and two concurrent
collectors. The daemon `kind` field is additive; the full suite is green.

## Still open

The live smoke test in a separate boomi worktree — unchanged from 1.8.9/1.8.10. `${CLAUDE_PLUGIN_ROOT}`
binds at session load, so it needs a fresh session after `/plugin update`; `ps -eo pid,etime,command |
grep codex-drive` is the only ground truth for which version is running.
