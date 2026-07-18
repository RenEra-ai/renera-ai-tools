# codex-claude — open issues after v1.8.5

Input for a Codex architect planning pass. Every item below was **verified against the code at
`df358fd`** (not recalled). Current state: 228 pass / 0 fail / 3 skipped (live-only); v1.8.5 deployed
and cache-verified.

Provenance: 40 findings from the original multi-agent review of the native commit-review feature
(39 fixed, 1 accepted), plus 27 findings across three independent Codex review rounds (26 fixed).
What follows is everything still open.

---

## P1 — blocks "done"

### 1. `475cd84..HEAD` has never been reviewed
- **What:** The commit that fixed all 8 findings from the last Codex review is itself unreviewed.
  The v1.8.4 review covered `33acf35..2978385`; `475cd84` (+`df358fd`, version-only) came after.
- **Scope:** 7 files, +107/−35. Touches `lib/daemon.mjs` (`_wait` signature change + `_handleCommand`
  now takes `sock`), `lib/drive-loop.mjs`, `bin/codex-drive.mjs` (`.err` pruning, `readdirSync`/
  `statSync` added), `scripts/review-round.mjs`, `scripts/plan-round.mjs`, `agents/*.md`,
  `test/detached-cli.test.mjs`.
- **Why it matters:** Every review round so far found real defects in the *previous* round's fixes —
  including fixes I was confident in. The `_wait(sock)` threading is the riskiest part: it adds a
  `close` listener per wait, and the rewait poll opens a new socket every cycle.
- **Ask:** Review that range specifically. Highest-value questions: can the new `sock.once('close')`
  listener leak or double-remove a waiter; is `_handleCommand(cmd, sock)` correct for every verb
  (only `wait` uses `sock`); can `.err` pruning race a concurrent `start` that just wrote one;
  does `readdirSync` on `store.baseDir` throw when the dir is absent on a first-ever run.

---

## P2 — real weaknesses, non-blocking

### 2. SIGTERM test does not prove the app-server died
- **File:** `test/round-scripts.test.mjs`, the "both drivers tear the daemon down on SIGTERM" test.
- **Verified:** contains **zero** references to `pgrep`/`mock-appserver`.
- **What:** It asserts exit 143 and the `SIGTERM — cleaning up` log, which proves the *handler ran* —
  but not that `daemon.stop()` did anything. Deleting the `daemon.stop()` call while keeping the
  handler would still pass, and orphaning the app-server is the exact bug this guards.
- **Ask:** Assert the mock app-server process count returns to its pre-spawn value after exit
  (before/after `pgrep -f mock-appserver`), or have the mock write a shutdown sentinel.

### 3. `--private writes NO global state` test reads the developer's real `$HOME`
- **File:** `test/detached-cli.test.mjs:94` — `join(process.env.HOME, '.codex-drive', 'state.json')`.
- **What:** The assertion compares the real state file before/after, so it is sensitive to any
  concurrent session on the machine and is testing the environment as much as the code. The sibling
  test was already fixed to use a redirected `HOME`; this one was missed.
- **Ask:** Run it under a temp `HOME` (paths must stay short — see issue 6) and assert on that.

### 4. Round-script output assertions are unordered
- **File:** `test/round-scripts.test.mjs:58-60` and similar — separate `assert.match(r.stdout, …)`
  calls for `STATUS:`, `PARSED_VERDICT:`, `=== REVIEW ===`.
- **What:** Each line is matched independently, so the trailers could be reordered, duplicated, or
  interleaved with review text and the tests stay green. `commit-review-round.test.mjs` already does
  this correctly with a `lastTwo()` helper that asserts *position* — the contract is positional
  ("trailers LAST so they survive a `tail`"), and only the one-shot's tests enforce it.
- **Ask:** Assert the drivers' output contract by position, reusing the `lastTwo()` pattern.

### 5. `interruptAndReturn` uses a fixed 10s cap, not the remaining budget
- **File:** `lib/drive-loop.mjs:78`.
- **What:** When the total budget is already exhausted, cleanup can still add up to 10s beyond it.
  Raised in the v1.8.3 daemon review; the sibling issue (unbounded `approve`/`answer`) was fixed,
  this one was not.
- **Ask:** Decide deliberately — either clamp the interrupt to the remaining budget, or document why
  cleanup is intentionally allowed to overrun (a defensible position: an interrupt that gives up
  leaves the turn running). Currently it is neither clamped nor documented.

---

## P3 — unresolved judgment call

### 6. Should the `_sendStart` rejection arm quarantine the session?
- **File:** `lib/daemon.mjs` ~line 250 (the rejection arm's `_finalizeTurn`, deliberately with no
  `quarantine`).
- **The disagreement, both from competent reviewers:**
  - *Current behaviour (design judge):* an error RESPONSE means the server never created a turn, so
    there is no orphan to confuse a later turn. Quarantining would turn a routine recoverable error
    (bad `--base`, rejected `approvalPolicy`) into a mandatory daemon restart.
  - *Challenger (daemon-half reviewer):* the original finding's own scenario is "rejects **after the
    server has begun streaming**", so a server-side turn CAN exist. No authoritative id was recorded
    and a review's `turn/started` id is deliberately ignored, so a later failed/interrupted
    completion from the rejected turn bypasses `_lastTurnId` filtering and can fail/quarantine the
    *next* turn.
- **Ask:** Adjudicate against the protocol. If the challenger is right, the fix is narrow —
  quarantine only when notifications for this turn were actually observed before the rejection
  (that state is already tracked in `turn.buffered`).

---

## Accepted, not open (do not re-litigate)

- **`daemon.mjs:171` — synchronous git chain in `_startReview`.** Converting `resolveReviewTarget` to
  async would churn every consumer and re-open busy-guard atomicity. Mitigated by: fail-closed
  liveness probe (only `ENOENT`/`ECONNREFUSED` may replace a session), two redundant `git rev-parse`
  spawns removed, `maxBuffer` bounded. Documented in the spec's rev-6 notes.
- **In-process rewait cannot beat the Bash tool cap (~10 min/call).** That is precisely why the
  owned-session fallback exists in both agent contracts.
- **`commit-review-round` keeps a hard total deadline.** A shell gate must fail fast.

## Tooling limitation worth knowing

The Codex reviewer runs in a sandbox where Unix `listen()` is denied (`EPERM`), so it can execute
only the ~31 pure unit tests and its test audits are **static**. It still found real defects every
round, but "tests look fine" from it carries less weight than a local `npm test`.
