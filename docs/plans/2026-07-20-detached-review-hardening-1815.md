# 1.8.14 → 1.8.15 — sixth review round on the detached Stage-2 review

Round 6 of independent Codex review. One P2, and — like round 5 — it was a consequence of the previous
round's fix: 1.8.14 added the durable `phase` verdict, but wrote it **fail-open**. Fixed in **1.8.15**.
The local cache is still 1.8.9 (no live review has run), so nothing here is a field regression.

## Round 6 finding

### Phase persistence failed open (P2)

The 1.8.14 `phase` write only warned on failure and then still emitted `STATUS: completed`, exited 0,
and left `last-reviewed-sha` advanced. Reproduced by creating `phase` as a *directory*: the write threw
`EISDIR`, but collection succeeded (exit 0) with no readable durable verdict — the exact hole the file
was added to close. A durable-evidence mechanism that fails open is worse than none: it reports success
while the evidence it promised is absent, and it violates the collector's own contract that "exit 0
means, and ONLY means, a completed, non-empty, attested review".

**Fix.** `emit()` now treats the `phase` write as part of the exit-0 claim and **fails closed**:

- On a would-be exit-0 completion whose `phase` write throws, it downgrades to `STATUS: failed` / exit
  2 rather than certify a success whose durable verdict is missing. On a path already exiting non-zero
  there is nothing to protect — it warns and keeps the failing code (the verdict is best-effort there).
- The **round marker is now advanced inside `emit()`**, after `phase` is durably on disk and only for a
  certified exit-0 completion. Moving it there (it previously ran in a separate block *before* the final
  emit) means a `phase` failure can never leave `last-reviewed-sha` advanced past an uncertifiable
  round — which would silently shrink the next review's scope. A marker write that itself fails is the
  same downgrade. This is the "avoid advancement" half of the fix, by ordering rather than by undo.

`emit()` is the single choke point every exit funnels through, so this covers every terminal path, and
`phase` is still written from the same `status` as the STATUS trailer — they cannot diverge.

## Version

**1.8.15**, floor raised in all three recipes. Pure collector behavior fix (a would-be exit 0 becomes
exit 2 when the verdict cannot be persisted) — the recipes already treat exit 2 as failure and already
document `phase`, so no recipe prose changed beyond the floor. The floor is raised so consumers get the
fail-closed collector rather than silently running the 1.8.14 fail-open one.

## Tests

282 total, 279 pass, 0 fail, 3 live-skipped (was 281). `commit-review-collect.test.mjs` now covers 31
cases, adding the reported repro: `phase` pre-created as a directory forces `EISDIR`, and the test
asserts exit 2, `STATUS: failed`, and — critically — that `last-reviewed-sha` did **not** advance.
Verified to fail against the fail-open collector (it exited 0 with the marker advanced). `CLAUDE.md` ↔
`AGENTS.md` still differ only by the "Never close on a missing step" paragraph.

## Still open

The live smoke test in a separate boomi worktree, unchanged since 1.8.9. `${CLAUDE_PLUGIN_ROOT}` binds
at session load, so it needs a fresh session after `/plugin update`.
