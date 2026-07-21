# 1.8.13 → 1.8.14 — fifth review round on the detached Stage-2 review

Round 5 of independent Codex review. One P2 remained, and it was a direct consequence of the round-4
fix: decoupling the `teardown` marker to record only `confirmed stopped` (so it could not contradict a
downgraded verdict) removed the verdict's only durable trace. Fixed in **1.8.14**. The local cache is
still 1.8.9 (no live review has run), so nothing here is a field regression.

## Round 5 finding

### No durable final verdict was persisted (P2)

After round 4, the retained run directory recorded daemon liveness (`teardown` = `confirmed stopped`)
and, on success, the round marker (`last-reviewed-sha`) — but the final `completed|failed|timeout`
verdict lived only in the collector's stdout. If that stdout was lost (a dropped turn, a truncated
capture), the retained directory could not establish what the collection concluded.

This is out of compliance with the **approved recovery contract**, which explicitly lists a `phase`
file in the persisted set (`docs/plans/2026-07-20-commit-review-detached-primary-fix.md:80`: "Persist
`cwd`, `baseline`, `last-reviewed-sha`, … `scope`, and `phase`"). That file was never implemented.

**Fix.** The collector now writes the final verdict to `<state-dir>/phase` from inside `emit()` — the
single choke point every exit funnels through. Two properties fall out of that placement:

- **It cannot diverge from stdout.** `phase` and the `STATUS:` trailer are written from the same
  `status` argument in the same function, so whatever the trailer says, the file says.
- **It records the FINAL verdict, not an optimistic one.** `emit()` is called with the already-downgraded
  `unhappy` value on the attestation-gate and round-marker failure paths, so a turn that read as
  `completed` but failed attestation persists `phase = failed`, exactly as the trailer reports.

It is written *before* the flush, so it is on disk even when the flush is the very thing lost.
`teardown` still records only daemon liveness (orthogonal to the verdict — a failed review whose daemon
is gone is still safe to delete); `phase` records the verdict. Both consumer recipes now document
reading `phase` for recovery.

## Version

**1.8.14**, floor raised in all three recipes. The `phase` file is additive and forensic (deletion is
still gated on `teardown`), but the recovery contract in each recipe now references it, so the floor is
raised to keep the documented contract and the shipped collector in lockstep.

## Tests

281 total, 278 pass, 0 fail, 3 live-skipped (was 280). `commit-review-collect.test.mjs` now covers 30
cases, adding one that collects a completed review and a downgraded-to-failed review and asserts, for
both, that `phase` exists and equals the emitted `STATUS:` verdict — the downgrade case proving `phase`
is written from `emit()` past every downgrade, not at read time. Verified to fail against the pre-fix
collector (`phase` absent). `CLAUDE.md` ↔ `AGENTS.md` still differ only by the "Never close on a missing
step" paragraph.

## Still open

The live smoke test in a separate boomi worktree, unchanged since 1.8.9. `${CLAUDE_PLUGIN_ROOT}` binds
at session load, so it needs a fresh session after `/plugin update`.
