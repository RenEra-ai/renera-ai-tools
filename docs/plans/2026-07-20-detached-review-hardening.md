# 1.8.10 — hardening the detached Stage-2 review

Follow-up to `2026-07-20-detached-primary-stage2.md` (1.8.9), from an independent Codex review of that
release. Six findings; five were real defects in the shipped code or recipe, one was a deliberate gate.
1.8.9 was merged and cached but never used for a live review, so nothing here is a field regression.

## What was wrong

### 1. A large review was truncated and silently escaped the gate (P1)

`emit()` wrote to `process.stdout` and immediately called `process.exit()`. Under the Bash tool stdout
is a **pipe**, and pipe writes are asynchronous: everything not yet handed to the OS is discarded.

Measured: a 1 MiB review emitted **65536 bytes** — exactly one pipe buffer — losing the body's tail
**and both trailer lines**, while still exiting 0. That is the worst reachable combination. Missing
trailers mean `enforce-receiving-code-review.sh` does not recognise the output as a review at all, so
the findings are truncated *and* the enforcement hook stays silent, on an exit code that claims a clean
completed review. Precisely the failure the collector was written to make impossible.

Fixed by writing the whole payload as one chunk and awaiting the write callback before exiting, with a
60 s bound so a dead reader cannot hang the call. Pinned by a test that fails at 61666 bytes without it.

### 2. Exit 0 could certify a session nobody could place (P1)

The header promised exit 0 meant an *attested* review; only `start-head` was actually enforced. A
missing `scope`, `dirty`, `socket`, `pid`, `cwd`, `threadId` or `review.json` all still produced
`STATUS: completed` and exit 0 — sometimes with `(unresolved)` printed in the trailer it was certifying.
A plain `send` was accepted as a code review.

Two changes:

- **Identity now comes from `start.json`**, which `codex-drive start` writes itself and which always
  carries `threadId`/`pid`/`cwd`. The sidecars are jq-extracted copies, so they are cross-checks, never
  the authority — reading identity out of them meant *deleting* a sidecar skipped the check it existed
  to perform. Absence is now a mismatch, not "nothing to compare".
- **An attestation gate** blocks `completed` (never exit 0) unless `start-head`, `dirty`, `scope`,
  `pid` and a well-formed `review.json` are all present and mutually consistent. `review.json` is the
  only available evidence that a native git-scoped review ran rather than an ordinary chat turn.

### 3. The consumer recipe contradicted its own separate-call design (P1)

`BASELINE`, `CACHE_DIR` and `DRIVE` were set in one Bash call and used in later ones, where they are
unset — while the surrounding prose explained that shell variables do not survive between calls. Under
default expansion `--base ""` reviews the wrong range silently.

Resolution and start are now **one** call; `BASELINE` is printed in Stage 1 step 0 and pasted literally,
exactly like the `RUN_DIR` token. Step 9d spells out the same for fix rounds instead of saying "change
only the review line".

### 4. A failed start reported success and orphaned a daemon (P2)

No `set -e` and no cleanup trap: a rejected review or a failed `jq` was masked by the trailing
`printf`, so the call exited 0 having printed a `RUN_DIR` for a session that never got a review — with
the detached daemon still running and nobody holding its socket.

Verified before/after with a bad base ref: **old** block exits 0, prints `RUN_DIR`, leaves the daemon
alive; **new** block exits 2, prints nothing, daemon reaped by the trap.

### 5. The two-strike rule had no mechanism (P2)

`missing-probes` was initialised to 0 and never read or written again — the prose described state that
did not exist. Each poll now increments it only on the genuinely ambiguous case (a `timeout` carrying
no `lastEventAgoMs`) and resets it otherwise, printing `MISSING_PROBES` alongside the poll JSON.
`/cr --wait <run-dir>` now probes the run directory and session before polling a possibly dead socket.

### 6. Acceptance coverage (P2, partly declined)

Added: the truncation regression, plain-send rejection, unresolved-attestation refusals, scope/pid
sidecar disagreement, a missing `threadId`, and two collectors running concurrently. Backstop
collection was already covered by the `--outcome` ceiling test, and stall telemetry by the `ticks`/
`hang` cases in `detached-cli.test.mjs`.

**Declined:** "the bug report remains open". Marking it resolved is gated on the live smoke test by the
approved plan, and that gate is still correct. The report *was* amended — its two wrong claims
corrected, the shipped fix recorded, criteria 1 and 3 marked superseded — and left open pending live
verification.

## Deliberately unchanged

- `commit-review-round.mjs` — still the short-turn-only one-shot, still on the older two-field `SCOPE:`.
- Polling policy stays prose. The collector owns the terminal contract because a program must produce
  what another program parses; it is not a second drive loop.
- Ownership failures still stop **nothing**. Tearing down a session we cannot identify is how one agent
  kills another agent's review. Everything past the ownership gate is always stopped.

## Tests

271 total, 268 pass, 0 fail, 3 live-skipped (was 264/261). `test/commit-review-collect.test.mjs` covers
20 cases; `huge` was added to the mock's review-mode allowlist to emit a body larger than one pipe
buffer.

## Still open

The live smoke test in a separate boomi worktree. `${CLAUDE_PLUGIN_ROOT}` binds at session load and is
not rebound by `/plugin update`, so it needs a fresh session; `ps -eo pid,etime,command | grep
codex-drive` is the only ground truth for which version an agent is running.
