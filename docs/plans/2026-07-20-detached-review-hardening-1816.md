# 1.8.15 → 1.8.16 — seventh review round on the detached Stage-2 review

Round 7 of independent Codex review. One P2, again a residue of the previous round: 1.8.15 made the
`phase` write fail closed, but wrote `phase` *before* the round marker, so a marker-write failure left
`phase` claiming `completed` next to a downgraded `STATUS: failed`. Fixed in **1.8.16**. The plugin
cache has since been updated to 1.8.16, but no live review has yet run against the detached path, so
nothing here is a field regression.

## Round 7 finding

### A marker-write failure contradicted the durable phase (P2)

1.8.15 wrote `phase = completed` first, then advanced `last-reviewed-sha`. If the marker write failed,
`emit()` correctly downgraded stdout to `STATUS: failed` / exit 2 — but never corrected `phase`, which
still read `completed`. Reproduced by creating `last-reviewed-sha` as a directory: the marker write
threw, stdout said failed, and the durable `phase` said completed. A recovery reader trusting `phase`
would conclude the round completed when it did not — the exact contradiction the `phase` file exists to
prevent.

**Fix.** A would-be exit-0 completion is now certified only if **both** the durable verdict **and** the
round marker reach disk, and on either failure `emit()` downgrades **and rewrites `phase` to the final
verdict**:

- `phase` is written tentatively as `completed`, then the marker is written. If the marker write throws,
  the verdict downgrades to failed/exit 2 and `phase` is rewritten to `failed`, so the durable record and
  the STATUS trailer can never disagree.
- The marker is the **last** write, so a marker success implies nothing after it can fail — the marker
  never outlives its certification, and no marker ever needs undoing (the round-6 "don't advance the
  marker on a failed round" guarantee still holds, now by construction).

Both writes now go through a small **atomic writer** (`atomicWrite`): write to a sibling `<name>.tmp`,
then `rename` over the target. `rename(2)` is atomic on a POSIX filesystem, so recovery never reads a
torn file, and a failed write leaves only the temp — which the writer removes. That is what makes the
reviewer's "clean up any partial marker" concern moot: there is never a partial marker to clean.

## Version

**1.8.16**, floor raised in all three recipes. Pure collector behavior fix (the durable `phase` now
always matches the emitted verdict, and both durable files are written atomically) — the recipes already
treat exit 2 as failure and document `phase`, so no recipe prose changed beyond the floor. The floor is
raised so consumers get the corrected collector rather than the 1.8.15 one that could contradict itself.

## Tests

283 total, 280 pass, 0 fail, 3 live-skipped (was 282). `commit-review-collect.test.mjs` now covers 32
cases, adding the reported repro: `last-reviewed-sha` pre-created as a directory forces the marker write
to fail, and the test asserts exit 2, `STATUS: failed`, `phase` == `failed` (not `completed`), and that
no `.tmp` partial survives. Verified to fail against the 1.8.15 collector (`phase` remained `completed`).
`CLAUDE.md` ↔ `AGENTS.md` still differ only by the "Never close on a missing step" paragraph.

## Still open

The live smoke test in a separate boomi worktree, unchanged since 1.8.9. `${CLAUDE_PLUGIN_ROOT}` binds
at session load, so it needs a fresh session after `/plugin update`.
