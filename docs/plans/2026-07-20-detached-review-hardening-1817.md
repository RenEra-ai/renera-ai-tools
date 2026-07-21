# 1.8.16 → 1.8.17 — eighth review round on the detached Stage-2 review

Round 8 of independent Codex review. One P2 (and one P3 doc nit). The P2 closes the last residue of the
multi-write `phase`/marker consistency saga (rounds 5–7) at the root, by collapsing the success claim to
a single authoritative record. Fixed in **1.8.17**. The plugin cache has been updated to 1.8.16; no live
review has yet run against the detached path, so nothing here is a field regression.

## Round 8 findings

### The reconciliation write could itself fail, re-opening a false success (P2)

1.8.16 wrote `phase = completed` first, then the marker `last-reviewed-sha`; on a marker failure it
downgraded to `STATUS: failed` and **rewrote** `phase` to `failed`. But that rewrite was itself best-
effort. Under a **correlated** failure — a read-only filesystem, `ENOSPC`, or `EIO` that strikes both
writes — the marker write fails, the downgrade fires, and the reconcile write *also* fails, leaving the
durable `phase = completed` next to a `STATUS: failed` trailer. A recovery reader trusting `phase` still
infers a false success. The flaw is structural: any design with a tentative `completed` token plus a
separate marker has a window where a second failure can't walk the token back.

**Fix — one authoritative atomic record.** The success claim is now a **single atomic write**:
`last-reviewed-sha`, whose *content* is the reviewed SHA (the next round's baseline) and whose *very
existence* is the `completed` verdict. There is no separate `completed` token anywhere:

- A **completed** round writes only `last-reviewed-sha` (one `atomicWrite`). If it fails, nothing on
  disk claims completion; the collector downgrades to failed / exit 2.
- A **failed/timeout** round (including a downgrade) writes `phase`, which now records **only** `failed`
  or `timeout`, never `completed`.

So even a correlated double failure (both writes throw) leaves the directory with no `last-reviewed-sha`
and no `completed` token — recovery reads *not complete*, which is the truth. The whole class of
"`phase` contradicts the marker" bugs is gone because there is nothing left to contradict: one record,
one write, one meaning. Recovery protocol (documented in all three recipes): `last-reviewed-sha` present
⇒ completed (its content is the SHA); else read `phase` for failed/timeout; neither ⇒ no result was
recorded, treat as not complete.

The recipe fix-loop is unchanged — it already reads `last-reviewed-sha` for the next baseline, which is
now also the completion authority.

### P3 — stale cache note

`hardening-1816.md` said the local cache was still 1.8.9; it is 1.8.16 after the `/plugin update`s.
Corrected in that doc, and this doc states the accurate status.

## Version

**1.8.17**, floor raised in all three recipes. Collector behavior change (a completed round is certified
by a single record; `phase` is unhappy-only), so the floor is raised to keep the recovery contract and
the shipped collector in lockstep. No recipe fix-loop change; the recovery documentation was updated in
all three recipes.

## Tests

283 total, 280 pass, 0 fail, 3 live-skipped. `commit-review-collect.test.mjs` holds at 32 cases: the
round-5/6 phase tests were rewritten for the single-record model, and a **correlated double-write
failure** test was added (pre-create both `last-reviewed-sha` and `phase` as directories → every write
throws → exit 2, `STATUS: failed`, and no readable completion record — no false success). The recovery
test asserts a completed round writes **no** `completed` token to `phase`; verified it fails against a
collector that writes the old tentative token. `CLAUDE.md` ↔ `AGENTS.md` still differ only by the "Never
close on a missing step" paragraph.

## Still open

The live smoke test in a separate boomi worktree, unchanged since 1.8.9. `${CLAUDE_PLUGIN_ROOT}` binds
at session load, so it needs a fresh session after `/plugin update`.
