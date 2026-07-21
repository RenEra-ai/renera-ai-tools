# 1.8.18 → 1.8.19 — tenth review round on the detached Stage-2 review

Round 10 of independent Codex review. Two P2s (recovery-reader provenance + a stale plan step) and one
P3 (a tracked link to a git-ignored doc). Fixed in **1.8.19**. The plugin cache is at 1.8.18; no live
review has yet run against the detached path, so nothing here is a field regression.

## Round 10 findings

### The recovery reader checked equality, not validity or provenance (P2)

1.8.18's reader accepted a completion when `last-reviewed-sha` equalled `start-head`. But equality alone
is weak: a matching not-a-SHA, matching non-hex text, and a **symlinked** record (`statSync` follows the
link) all read as completed. Hardened:

- **Symlinks rejected** — the reader uses `lstatSync`, not `statSync`, so a symlinked record fails
  `isFile()` even when it resolves to a regular file (a symlink has no provenance; it can aim anywhere).
- **Canonical SHA required** — `start-head` (and therefore the marker, which must equal it) must match
  `^(?:[0-9a-f]{40}|[0-9a-f]{64})$`. A matching placeholder is no longer a completion.
- **Teardown provenance required** — completion additionally requires `teardown` = `confirmed stopped`.
  The collector writes that only after proving the daemon was torn down, and always before the marker,
  so a marker without it is not a genuine finished run.
- **Validated at the write side too** — the collector now refuses to certify (and so never writes the
  marker) when `start-head` is not a canonical SHA, rather than emitting garbage the reader must reject.

### The plan still copied the prior marker into new rounds and wrote nonterminal `phase` values (P2)

The 1.8.9 design sketch copied the previous round's `last-reviewed-sha` into a new run directory and
drove `phase` through a lifecycle state-machine (`initialized`/`started`/`running`/`failed-start`).
Under the shipped single-record model the copied marker is a false-completion vector — with an
uncommitted fix, HEAD is unchanged, so the copied SHA equals the new `start-head` and recovery would
report completed before the review ran. The whole sketch is superseded, so it now carries a prominent
top banner (do-not-follow, with the specific traps called out), and the concrete `last-reviewed-sha`
copy is removed in favor of "read the prior SHA into the new `baseline`; never copy the marker."

### P3 — a tracked link to a git-ignored doc

The bug report referenced the correct design-doc filename, but `docs/` is git-ignored and that doc was
untracked, so the link broke in a clean checkout. Force-added
`2026-07-20-commit-review-detached-primary-fix.md` (the same pattern used for the hardening docs), so
every tracked reference now resolves.

## Version

**1.8.19**, floor raised in all three recipes. Collector + reader behavior change (stricter completion
provenance), so the floor keeps the recovery contract and the shipped scripts in lockstep.

## Tests

299 total, 296 pass, 0 fail, 3 live-skipped (was 295). `commit-review-status.test.mjs` grew to 14 cases:
a matching marker without teardown ⇒ unknown; a non-SHA marker equal to a non-SHA start-head ⇒ unknown;
a **symlinked** marker resolving to a valid SHA file ⇒ unknown (teeth-checked against `statSync`, which
follows the link). `commit-review-collect.test.mjs` gained a case asserting a non-canonical `start-head`
blocks certification and writes no marker. `CLAUDE.md` ↔ `AGENTS.md` still differ only by the "Never
close on a missing step" paragraph.

## Still open

The live smoke test in a separate boomi worktree, unchanged since 1.8.9. `${CLAUDE_PLUGIN_ROOT}` binds
at session load, so it needs a fresh session after `/plugin update`.
