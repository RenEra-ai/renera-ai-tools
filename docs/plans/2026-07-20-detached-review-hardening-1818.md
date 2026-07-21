# 1.8.17 → 1.8.18 — ninth review round on the detached Stage-2 review

Round 9 of independent Codex review. One P2 (recovery predicate + a stale plan step) and one P3 (a
dangling doc reference). Fixed in **1.8.18**. The plugin cache is at 1.8.17; no live review has yet run
against the detached path, so nothing here is a field regression.

## Round 9 findings

### Recovery treated marker *existence* as completion (P2)

1.8.17 made `last-reviewed-sha`'s existence the `completed` verdict, and the recovery prose said
"`last-reviewed-sha` present ⇒ completed." But *present* is too weak: a **directory** is present (the
exact shape the correlated-double-failure path leaves behind), and so is an empty file or a stale
placeholder. A recovery reader following the prose would report success over a directory-shaped marker
and ignore `phase=failed`. Worse, the original design sketch
(`2026-07-20-commit-review-detached-primary-fix.md`) *pre-created* the marker
(`cp baseline last-reviewed-sha`) and `phase` (`initialized`), which under the existence rule would make
a fresh run read as complete **before any review ran**.

**Fix.**

- **A shipped, executable recovery reader** — `scripts/commit-review-status.mjs --state-dir <dir>` —
  prints `completed | failed | timeout | unknown`. It counts a round `completed` **only** when
  `last-reviewed-sha` is a *regular, readable file whose content equals the recorded `start-head`* (the
  reviewed SHA). `statSync().isFile()` rejects a directory; the content check rejects an empty file or a
  placeholder. `failed`/`timeout` come from `phase`; anything else is `unknown` (not complete, never
  success). Recovery is no longer prose — it is a program with the predicate baked in.
- **All three recipes** now invoke the reader instead of eyeballing existence, and state the
  regular-file-equals-`start-head` rule explicitly.
- **The stale pre-creation step is removed** from the design doc, with a note that the shipped model
  writes neither marker at startup and validates content, not existence.

### P3 — dangling doc reference

The bug report cited `docs/plans/2026-07-20-detached-primary-stage2.md`, which never existed; the real
1.8.9 design doc is `2026-07-20-commit-review-detached-primary-fix.md`. Reference corrected.

## Version

**1.8.18**, floor raised in all three recipes — the recipes now reference `commit-review-status.mjs`,
which only 1.8.18 ships, so the floor keeps the documented recovery step and the shipped script in
lockstep.

## Tests

295 total, 292 pass, 0 fail, 3 live-skipped (was 283). New `test/commit-review-status.test.mjs` (11
cases) drives the shipped reader against hand-built run directories: a regular marker equal to
`start-head` ⇒ completed; a **directory** marker ⇒ unknown (with `phase=failed` ⇒ failed); a
content-mismatched or empty marker ⇒ not completed; a missing `start-head` ⇒ unknown; unrecognized
`phase` ⇒ unknown. `commit-review-collect.test.mjs` gained two end-to-end assertions tying the reader to
the collector's real output — the correlated-double-failure run reads `unknown`, and real completed/
failed runs read `completed`/`failed`. `CLAUDE.md` ↔ `AGENTS.md` still differ only by the "Never close on
a missing step" paragraph.

## Still open

The live smoke test in a separate boomi worktree, unchanged since 1.8.9. `${CLAUDE_PLUGIN_ROOT}` binds
at session load, so it needs a fresh session after `/plugin update`.
