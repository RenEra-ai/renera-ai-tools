# 1.8.12 → 1.8.13 — fourth review round on the detached Stage-2 review

Round 4 of independent Codex review. Rounds 1–3 (1.8.9→1.8.12) fixed truncation, the attestation gate,
recipe variable scoping, the cleanup trap, positive ownership verification, the `kind`/`turnToken` turn
binding, the resume version floor, and full `review.json` validation. Round 4 found four smaller
lifecycle gaps — two in the collector, two in the recipes — and one allowlist omission. All fixed in
**1.8.13**. The local cache is still 1.8.9 (no live review has run), so nothing here is a field
regression.

## Round 4 findings

### 1. Teardown could be certified without PID evidence (P2)

`confirmStopped()` returns true on `!existsSync(socket) && !pidAlive(pid)`, and `pidAlive(null)` is
false — so when **both** PID records are absent (`start.json.pid` stripped *and* the `pid` sidecar
gone, `pid === null`), socket disappearance alone satisfied the check. Socket absence is a weaker
signal than process death: a swept `/tmp`, or a crash that unlinks the socket mid-shutdown, removes
the file while the app-server lives on. The collector then wrote the `teardown` marker the recipe
gates deletion on, so the run directory could be deleted over a still-live daemon.

Fixed by failing closed: `confirmStopped()` now returns false immediately when `pid === null` —
teardown is *unprovable* without a PID to check, so it is never assumed. The caller reports the true
reason ("no PID was recorded, and socket absence alone does not prove the daemon died"), retains the
run directory, and prints the recovery command. Regression: a completed review with both PID records
removed exits 2 and writes **no** `teardown` marker (verified it fails without the guard).

### 2. The persisted teardown status could contradict the final verdict (P2)

The marker was written as `confirmed ${terminal}`, and at that point `terminal` is still `'completed'`
— but the attestation gate and the round-marker write *below* it can both downgrade the emitted result
to `STATUS: failed`. So a run could carry a `teardown` file saying `confirmed completed` next to a
`STATUS: failed` trailer: a contradiction in its own evidence.

The marker exists to gate deletion on **daemon liveness**, which is orthogonal to the review verdict
(a downgraded review whose daemon is confirmed gone is still safe to delete). It now records only the
daemon fact — `confirmed stopped` — and never the review verdict, which lives in the STATUS line.
Regression: a review forced to downgrade *after* teardown is confirmed still writes the marker (the
run is deletable) but its content is `confirmed stopped`, not `confirmed completed`.

### 3. `/cr` evaluated healthy timeouts before unexpected exit codes (P2)

Round 3 reordered the poll decision list in the consumer `CLAUDE.md`/`AGENTS.md` to check terminal and
error cases FIRST, but `~/.claude/commands/cr.md` was not updated in lockstep. Its list still led with
the WORKING-timeout bullet, so a timeout-shaped response carrying `WAIT_RC` other than 0/2 could match
"WORKING" before reaching the "abort" bullet at the bottom. `cr.md` now uses the same ordering and the
same "check terminal and error cases FIRST" framing as the two consumer files.

### 4. The startup cleanup trap's `stop` was unbounded (P2)

The trap arms the instant the daemon exists, but its `stop` carried no `--timeout-ms`, and the CLI
default is an **unbounded** wait (`bin/codex-drive.mjs` applies `timeoutMs: 0`, and `lib/client.mjs`
only arms a timer when `timeoutMs > 0`). An unresponsive daemon would hang the trap indefinitely and
outlive even the outer Bash termination — the very failure the detached path exists to remove,
reintroduced one layer up. The trap now passes `--timeout-ms 10000` in all three recipes (10s is ample:
`stop` replies before teardown completes).

### 5. `/cr` used `tail -1` but omitted `Bash(tail:*)` (P3)

The runtime-resolution block runs `ls -d … | sort -V | tail -1`, but the command's `allowed-tools`
listed `sort` and `head` and not `tail` — a needless permission prompt mid-recipe. Added `Bash(tail:*)`.

## Version

**1.8.13**, floor raised in all three recipes. Findings 1 and 2 are self-contained collector fixes (no
daemon coordination), so a 1.8.13 collector runs against any daemon — but the floor is raised anyway so
consumers actually *get* the hardening rather than silently running the 1.8.12 collector.

## Tests

280 total, 277 pass, 0 fail, 3 live-skipped (was 278). `commit-review-collect.test.mjs` now covers 29
cases, adding: a completed review with **no PID on either record** (teardown unconfirmed, no marker
written) and a downgrade-after-teardown case asserting the marker reads `confirmed stopped`, not the
review verdict. Both were verified to fail against the pre-fix collector. Findings 3–5 are recipe/doc
changes, validated by inspection and lockstep diff (`CLAUDE.md` ↔ `AGENTS.md` differ only by the "Never
close on a missing step" paragraph).

## Still open

The live smoke test in a separate boomi worktree, unchanged since 1.8.9. `${CLAUDE_PLUGIN_ROOT}` binds
at session load, so it needs a fresh session after `/plugin update`.
