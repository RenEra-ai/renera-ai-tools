# `commit-review-round.mjs` deterministically times out — the one-shot review path is unusable

**Component:** `codex-claude` plugin — `scripts/commit-review-round.mjs`
**Version observed:** codex-claude **1.8.8**, Codex CLI **0.144.5**
**Severity:** High — the documented primary Stage-2 review path never succeeds
**Status:** Fix shipped in codex-claude **1.8.11** (structural fix landed 1.8.9; hardened through 1.8.10–1.8.11 over two review rounds) — pending live verification (see [Resolution](#resolution))
**Reported:** 2026-07-20
**Reporter:** observed during `boomi-mcp-server` issue #137

---

## Summary

`commit-review-round.mjs` is the documented primary Stage-2 review runner (consuming repos call it via
`node "$CRR" --base "$BASELINE"` from their `CLAUDE.md` completion workflow). On real-world diffs it
**deterministically** exits with `STATUS: timeout` / exit code 2, having interrupted a Codex turn that
was healthy and actively streaming. It is not a flaky failure and it is not primarily diff-size driven:
shrinking the diff ~6x reproduced the identical timeout.

The impact is that every consumer silently degrades to the owned-session `codex-drive.mjs` fallback,
which completes the *same* review reliably. Any workflow that treats `STATUS: timeout` as fatal — the
correct reading of the script's own output contract, which documents exit 2 as "no trustworthy review" —
is hard-blocked. And because the one-shot hosts its own daemon and tears it down on exit, the
in-flight review text is destroyed rather than left recoverable.

The root cause is a two-line divergence from the script's own sibling drivers, described in
[Root-cause analysis](#root-cause-analysis) below. The mitigation the engine needs already exists in the
shared drive loop; `commit-review-round.mjs` is the only one of the three drivers that does not opt into it,
*and* it additionally imposes a hard total deadline that would override that opt-in anyway.

---

## Environment

| Item | Value |
| --- | --- |
| codex-claude plugin | 1.8.8 (`/Users/gleb/.claude/plugins/cache/renera-ai-tools/codex-claude/1.8.8/`) |
| Codex CLI | 0.144.5 |
| Auth | `authPresent: true` |
| Platform | macOS, darwin 25.5.0 |
| Repo under review | `boomi-mcp-server`, issue #137 |
| Bash wrapper timeout | 600000 ms (10 min) — did **not** fire; the script's own cap did |

---

## Reproduction

### Attempt 1 — large diff (17 files, 4,868 insertions / 6 deletions)

```bash
node "$CRR" --base 365342990b85f1ee248b18483347cf4ff231501b
```

Ran for the full internal budget, then:

```
[commit-review] total wait budget exhausted — interrupting
STATUS: timeout
SCOPE: branch diff against 365342990b85f1ee248b18483347cf4ff231501b (3653429) head=a26e882e0806f9614b82e93936b064a7db1419d9
```

Exit code **2**. The Bash wrapper cap was 600000 ms, so the script's own ~540 s cap fired first — the
harness did not kill it.

### Attempt 2 — small diff, same result (7 files, 835 insertions / 36 deletions)

About one sixth the size of attempt 1:

```bash
node "$CRR" --base a26e882e0806f9614b82e93936b064a7db1419d9
```

```
[commit-review] total wait budget exhausted — interrupting
STATUS: timeout
SCOPE: branch diff against a26e882e0806f9614b82e93936b064a7db1419d9 (a26e882) head=0c335dc189f5da89ff2fc09d37347145521d8bc7
```

**This is the key data point.** A ~6x smaller diff timed out identically. The turn simply takes longer
than the cap at the configured reasoning effort; diff size is not the dominant variable.

### Control — the fallback completes the same review, every time

```bash
S=$(node "${CD}bin/codex-drive.mjs" start --private --cwd "$PWD" \
      --sandbox read-only --approval-policy never --ephemeral | jq -r .socket)
node "${CD}bin/codex-drive.mjs" review --base "$BASE" --socket "$S"
node "${CD}bin/codex-drive.mjs" wait --timeout-ms 540000 --socket "$S"   # repeated, each its own call
node "${CD}bin/codex-drive.mjs" read --out .codex/review.md --socket "$S"
node "${CD}bin/codex-drive.mjs" stop --socket "$S"
```

On attempt 1 the fallback needed **two** `wait` polls and returned a substantive review — **9 findings,
all of which were verified as genuine defects**. The review quality is high; only the runner is broken.

Telemetry sampled during the waits showed a healthy, streaming turn:

```json
{"status":"timeout","turnStatus":"running","lastEventAgoMs":4023,"eventCount":369}
```

`turnStatus: running` with the last event only ~4 s old and 369 events accumulated is a working turn,
not a stuck one. **The one-shot kills exactly this case.**

---

## Root-cause analysis

Read from the installed 1.8.8 sources. Line anchors are against
`/Users/gleb/.claude/plugins/cache/renera-ai-tools/codex-claude/1.8.8/`.

### 1. Where the budget is defined

`scripts/commit-review-round.mjs:64-65`:

```js
let WAIT_TIMEOUT_MS;
try { WAIT_TIMEOUT_MS = testWaitMs() ?? 540000; } catch (e) { die(e.message, 1); }
```

540000 ms (9 minutes), hardcoded as the fallback default.

### 2. It is applied as BOTH the per-wait cap and the total deadline

`scripts/commit-review-round.mjs:141-155`:

```js
const res = await driveTurn(socketPath, {
  waitTimeoutMs: WAIT_TIMEOUT_MS,
  deadlineMs: WAIT_TIMEOUT_MS,        // TOTAL, not per-wait
  ...
```

Because `deadlineMs === waitTimeoutMs`, the **first** per-wait expiry is simultaneously total-budget
exhaustion. There is no headroom whatsoever: the turn gets exactly one 9-minute window and is then killed.

### 3. The mitigation exists in the shared engine — and this driver is the only one that skips it

`lib/drive-loop.mjs:49-54` documents `onWaitExpiry`, added in direct response to this exact class of failure:

```
 *  - onWaitExpiry    'interrupt' | 'rewait' (default 'interrupt'). 'rewait' turns the per-wait cap
 *                    into a POLL INTERVAL: expiry logs and waits again instead of killing the turn.
 *                    A slow turn is not a dead turn — the fixed cap killed two healthy ~10-minute
 *                    Codex reviews in one day, while a 21-minute one completed fine under manual
 *                    re-waits. deadlineMs exhaustion STILL interrupts regardless of this mode, so
 *                    an explicit total budget is never weakened.
```

Comparing the three drivers:

| Driver | `deadlineMs` | `onWaitExpiry` | Outcome on a slow turn |
| --- | --- | --- | --- |
| `scripts/plan-round.mjs:61-66` | *not passed* (`null`) | `'rewait'` | polls until the caller's own lifetime ends |
| `scripts/review-round.mjs:79-84` | *not passed* (`null`) | `'rewait'` | polls until the caller's own lifetime ends |
| `scripts/commit-review-round.mjs:141-155` | **`WAIT_TIMEOUT_MS`** | **omitted → `'interrupt'`** | **killed at 9 min** |

`commit-review-round.mjs` is the sole driver that both omits `onWaitExpiry: 'rewait'` (inheriting the
`'interrupt'` default from `lib/drive-loop.mjs:66`) **and** imposes a hard `deadlineMs`. Note these are
two independent defects — per the doc comment above, adding `rewait` alone would **not** fix it, since
deadline exhaustion interrupts regardless of mode, and here the deadline coincides with the first expiry.

### 4. Which branch produced the observed message — proof the deadline is the killer

`lib/drive-loop.mjs:116-126`:

```js
const outOfBudget = deadlineMs != null && (performance.now() - startedAt) >= deadlineMs;
if (outOfBudget) return interruptAndReturn('timeout', 'total wait budget exhausted');
if (onWaitExpiry === 'rewait') {
  log('wait cap expired — turn still running, re-waiting');
  continue;
}
return interruptAndReturn('timeout', 'wait cap expired');
```

The observed log was `total wait budget exhausted — interrupting`, **not** `wait cap expired`. That is
the `outOfBudget` branch at line 119 — i.e. the total `deadlineMs` fired, which is the branch that
ignores `rewait`. This confirms the diagnosis directly from the emitted string rather than by inference.

### 5. The budget is not configurable by any supported means

The only override is `testWaitMs()` (`lib/test-appserver.mjs:49-61`), reading `CODEX_DRIVE_TEST_WAIT_MS`,
and it is fail-closed behind `CODEX_DRIVE_TEST_MODE=1` (`lib/test-appserver.mjs:52-54`):

```js
if (!inTestMode(env)) {
  throw new Error(`${TEST_WAIT_MS_ENV} is set but ${TEST_MODE_ENV}=1 is not; refusing to shorten the wait cap`);
}
```

The file's own header calls this a "TEST-ONLY seam … Undocumented in user-facing help on purpose"
(`lib/test-appserver.mjs:1-16`). There is **no `--timeout-ms` flag**: `ALLOWED_FLAGS` is
`['base', 'scope', 'cwd']` (`scripts/commit-review-round.mjs:32`), and any other flag is rejected by
`assertOnlyFlags` at line 52. So an operator has no sanctioned way to raise the cap.

*(Aside, inferred: setting `CODEX_DRIVE_TEST_MODE=1` + `CODEX_DRIVE_TEST_WAIT_MS=<large>` would
numerically raise both values, since both derive from `WAIT_TIMEOUT_MS`. This is an abuse of a test seam
in a production review path and should not be recommended as a workaround.)*

### 6. The daemon is hosted inside the one-shot, so the turn dies with it

`scripts/commit-review-round.mjs:123-132` constructs a `Daemon` on a temp socket in a temp dir; `teardown()`
(lines 100-104) stops it in the `finally` at line 161-163, and the `SIGTERM`/`SIGINT` handlers (lines
110-118) do the same. The script is explicitly designed never to touch `~/.codex-drive/state.json`
(header, lines 9-10).

The consequence: when the deadline fires, the interrupt cancels the turn *and* the daemon is destroyed.
There is no socket left to reconnect to and no way to `read` the partially-complete review. A healthy turn
369 events deep is discarded with nothing salvageable — whereas the fallback's detached session survives
its driver and remains readable.

### 7. Why a healthy turn gets interrupted

The loop has no liveness signal. `driveTurn` decides purely on elapsed wall-clock time and never asks
whether the turn is progressing — even though the daemon already computes exactly that. `lib/daemon.mjs:156-162`
exposes per-turn `turnStatus`, `lastEventAgoMs` and `eventCount`, and `bin/codex-drive.mjs:121` already
consumes them on the CLI `wait` path:

```js
if (st && !st.error) extra = { turnStatus: st.turnStatus, lastEventAgoMs: st.lastEventAgoMs, eventCount: st.eventCount };
```

`lib/drive-loop.mjs` never reads any of it. The data needed to distinguish "stuck" from "working"
is present, plumbed, and simply unused by the driver that most needs it.

---

## Secondary defect: Codex model-metadata cache cannot renew

During the one-shot run, Codex emitted this on stderr **five times over ~3.5 minutes**:

```
ERROR codex_models_manager::manager: failed to renew cache TTL: missing field `supports_reasoning_summaries` at line 86 column 5
```

Notes:

- This is emitted by **Codex itself** (`codex_models_manager`), not by the plugin. It likely warrants an
  upstream report against the Codex CLI (0.144.5).
- **Inferred, not established:** a model-metadata cache that cannot renew its TTL may be forcing repeated
  re-fetches, which could contribute to overall turn slowness. This has not been measured and should not
  be treated as confirmed. It is plausibly a contributing factor to *why* turns exceed the cap, but the
  cap logic in [Root-cause analysis](#root-cause-analysis) is a defect independently of it.
- Regardless of origin, the plugin should not let a repeated internal error stream past silently and then
  surface only as an opaque timeout. At minimum it should be detected and surfaced in the failure output.

---

## Why the prescribed retry advice does not help

Consuming repos' `CLAUDE.md` (e.g. `boomi-mcp-server`, Stage 2 step 6) prescribes:

> If Codex hangs, crashes, times out, or returns no usable output: **retry the one-shot once.**

This is ineffective here. The failure is **deterministic, not flaky** — it is a fixed wall-clock budget
against a turn that reliably exceeds it, reproduced across two runs whose diffs differed ~6x in size. The
retry therefore burns another full ~9 minutes and fails identically, delaying the working fallback by
roughly 18 minutes per review round. In a multi-round fix loop that cost recurs every round.

The advice was written for transient failures and should be amended to route straight to the fallback on
`STATUS: timeout` (as distinct from `failed`), until the runner is fixed.

---

## Proposed fixes, in priority order

### P1 — Stop killing healthy turns (the actual bug)

Align `commit-review-round.mjs` with its own sibling drivers. Both changes are required:

```js
const res = await driveTurn(socketPath, {
  waitTimeoutMs: WAIT_TIMEOUT_MS,
  deadlineMs: TOTAL_BUDGET_MS,     // must be > waitTimeoutMs, or null
  onWaitExpiry: 'rewait',          // ← currently missing entirely
  ...
```

`onWaitExpiry: 'rewait'` alone is insufficient — `deadlineMs` exhaustion interrupts regardless of mode
(`lib/drive-loop.mjs:118-119`), and today the deadline coincides with the first wait expiry. Either drop
`deadlineMs` (matching `review-round.mjs`, bounding the run by the caller's Bash cap plus the existing
SIGTERM teardown) or set it to a genuinely larger total than the per-wait poll interval.

### P2 — Make the budget configurable through a supported knob

Add `--timeout-ms` to `ALLOWED_FLAGS` (`scripts/commit-review-round.mjs:32`), and/or honour a
non-test env var such as `CODEX_REVIEW_TIMEOUT_MS`. Today the only override is a deliberately
test-gated seam, so operators cannot tune this without abusing `CODEX_DRIVE_TEST_MODE=1`.

### P3 — Interrupt on stuck, not on slow

Have `lib/drive-loop.mjs` consult the liveness telemetry the daemon already exposes
(`lib/daemon.mjs:156-162`) before interrupting, exactly as `bin/codex-drive.mjs:121` does. A turn with
`turnStatus: "running"` and a small `lastEventAgoMs` should be re-waited; a turn whose `lastEventAgoMs`
exceeds some stall threshold (with no `eventCount` movement) is genuinely wedged and *should* be killed.
This makes the timeout semantically correct rather than merely longer, and would have prevented both
observed failures — `lastEventAgoMs: 4023` is unambiguously alive.

### P4 — Do not host the daemon inside the one-shot, or make the turn recoverable

Either run the turn on a detached session that outlives the driver, or — on deadline expiry — print the
socket path and *skip* the teardown so the caller can `read --out` and `stop` manually. Today an
interrupted review is unrecoverable (see root cause §6), which is the difference between a 9-minute delay
and 9 minutes of wasted model spend.

### P5 — Internal auto-fallback

On timeout, transparently continue against an owned detached session (the documented fallback sequence)
so callers receive a review rather than exit 2. Lower priority than P1-P4 because it papers over the
cap rather than fixing it, and it complicates the script's deliberately honest exit-code contract
(header, lines 12-18) — but it would make the primary path reliable for every existing consumer without
requiring each repo to change its `CLAUDE.md`.

### P6 — Lower the review reasoning effort on the one-shot path

If the one-shot is meant to be the fast gate, running it at a lower effort than the interactive/architect
paths would bring turn duration under the cap. **Trade-off:** the timed-out review, once recovered via the
fallback, produced 9 findings that were *all* genuine defects — so the current effort level is delivering
real value and should not be reduced without measuring the loss in finding quality.

---

## Workaround

Use the owned detached private session. This has succeeded on every attempt:

```bash
CD="/Users/gleb/.claude/plugins/cache/renera-ai-tools/codex-claude/1.8.8/"

S=$(node "${CD}bin/codex-drive.mjs" start --private --cwd "$PWD" \
      --sandbox read-only --approval-policy never --ephemeral | jq -r .socket)

node "${CD}bin/codex-drive.mjs" review --base "$BASE" --socket "$S"

# repeat, each as its own call, until it resolves:
node "${CD}bin/codex-drive.mjs" wait --timeout-ms 540000 --socket "$S"

node "${CD}bin/codex-drive.mjs" read --out .codex/review.md --socket "$S"
node "${CD}bin/codex-drive.mjs" stop --socket "$S"   # ALWAYS
```

Notes:

- `--private` / `--socket` keep this off the shared `~/.codex-drive` session. Never use `start --force`,
  which would stop an unrelated live daemon.
- `stop` must **always** run. A real orphaned daemon was found earlier in the same session, left by an
  agent that died before stopping.
- **Resilience note:** that orphan was fully recoverable — `stop --socket <path>` cleaned it up, and its
  completed turn was still readable via `read --out`. This is precisely the property the one-shot lacks
  (root cause §6): because the detached daemon outlives its driver, a completed-but-uncollected review is
  not lost. It is a good argument for P4.

---

## Acceptance criteria for a fix

1. `node "$CRR" --base <sha>` completes with `STATUS: completed` on a diff that currently times out
   (both reproduction cases above).
2. A genuinely wedged turn still terminates with a bounded, honest `STATUS: timeout` — the fix must not
   reintroduce the unbounded-wait class of bug that `deadlineMs` was originally added to prevent
   (`lib/drive-loop.mjs:38-43`).
3. The timeout budget is settable through a documented, non-test-gated mechanism.
4. Consuming repos' `CLAUDE.md` retry guidance is revisited once the failure is no longer deterministic.

---

## Resolution

Shipped in codex-claude **1.8.9** (`docs/plans/2026-07-20-detached-primary-stage2.md`) and hardened
through **1.8.11** over two follow-up Codex review rounds
(`docs/plans/2026-07-20-detached-review-hardening-1811.md`). The reported symptom is real and
reproduced, but **two central claims of this report are wrong**, and the fix took a different shape as
a result:

- **Not a two-line divergence from the sibling drivers.** `commit-review-round.mjs:141-155` passes
  `deadlineMs: WAIT_TIMEOUT_MS` — the *same* 540000 as `waitTimeoutMs` — and omits `onWaitExpiry`, so
  the first per-wait expiry *is* total-budget exhaustion (`lib/drive-loop.mjs:116-119`). That is a
  recorded decision (`docs/plans/2026-07-18-open-issues.md:98`, under "Accepted, not open"; reaffirmed
  at `2026-07-20-owned-session-primary.md:45-46`) pinned by `test/drive-loop.test.mjs:308`, not an
  oversight.
- **The prescribed P1 fix cannot work.** Bash's ceiling is 600000 ms against the script's 540000 ms
  cap, so adding `rewait` plus a larger deadline buys ~60 seconds and then SIGTERM
  (`commit-review-round.mjs:100-118`) destroys the in-process daemon — trading an honest
  `STATUS: timeout` for an unreadable session. No in-process driver can outlive the tool call hosting
  it; that is the actual constraint.

**What shipped instead:** Stage 2's primary path is now a **detached `--private` session polled across
separate Bash calls**, so no Bash cap and no signal can reach the review, terminated by a new
`scripts/commit-review-collect.mjs` that owns the enforcement contract. `commit-review-round.mjs` is
unchanged and re-documented as short-turn-only.

Against the criteria above: **1 and 3 are superseded** — the one-shot is no longer the primary path, so
its budget is no longer the thing that must stretch. **2 holds** on the new path (a wedged turn ends via
the 15-minute silence rule or the 60-minute wall-clock backstop, both honest and bounded). **4 is done**:
the retry advice is removed, and re-running a timed-out review is now explicitly prohibited.

**Still open:** the live smoke test of criterion 2 on a real long review. This report should not be
marked Resolved until that runs.
