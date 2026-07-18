# codex-claude v1.8.5: Close the Six Remaining Issues

## Summary

- Review the intended fix range as `475cd84^..HEAD` (`2978385..HEAD`); the literal `475cd84..HEAD` excludes commit `475cd84`.
- Fix two P1 defects: waiter socket-listener retention and globally shared fallback temp filenames.
- Strengthen the three weak tests without changing CLI output or adding dependencies.
- Deliberately retain a separate 10-second interrupt cleanup grace and document that it may outlive the total work deadline.
- Position A wins for rejected starts: do not quarantine, even merely because pre-response traffic was buffered.
- Leave the accepted synchronous git chain, Bash cap, and commit-review hard deadline untouched.

## Ordered File-by-File Changes

### 1. P1 — daemon waiter lifecycle

- In [lib/daemon.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs), replace each bare waiter resolver with an idempotent `finish(result)` closure paired with a named `onClose` callback.
  - `finish` marks the waiter inactive, removes `onClose` with `sock.off('close', onClose)`, and resolves exactly once.
  - `onClose` marks it inactive and removes `finish` from `_waiters` only when found.
  - Keep disconnect behavior otherwise unchanged: a closed client has no response consumer, so remove the daemon-held waiter without attempting a socket response.
  - Keep `_resolveWaiters()` calling waiter functions; the wrapper makes normal completion detach the listener and prevents late close events from touching later waiters.
- In [test/daemon.test.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/daemon.test.mjs), import `EventEmitter` and add one unit regression test covering all waiter exits:
  - a terminal resolution leaves zero `close` listeners;
  - a disconnected waiter is removed from `_waiters`;
  - closing an old socket cannot remove a waiter registered for a later turn;
  - the surviving waiter resolves normally.

### 2. P1 — complete the seven-file fix review

- In [codex-architect.md](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/agents/codex-architect.md), replace `/tmp/cdx-plan-start.json` and `/tmp/cdx-plan-sock.txt` with sidecars derived from the already unique prompt file, such as `<the prompt file>.start.json` and `<the prompt file>.sock`. Update every subsequent `cat`/`--socket` reference.
- In [codex-impl-reviewer.md](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/agents/codex-impl-reviewer.md), similarly derive the combined fallback prompt, start JSON, and socket file from `<that temp prompt file>` rather than global `/tmp/cdx-fallback-*` names.
- Make no change to [bin/codex-drive.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/bin/codex-drive.mjs):
  - `StateStore` creates `baseDir` recursively before pruning, and pruning is also best-effort guarded, so first-run `readdirSync` cannot escape.
  - Concurrent starts use PID/timestamp-specific `.err` files; a newly written file has a fresh mtime and cannot meet the one-hour pruning threshold. Stat/unlink races are caught.
- Make no change for `_handleCommand(cmd, sock)`: the switch audit confirms only `wait` needs connection lifetime; every other verb correctly ignores `sock`.
- Keep `scripts/review-round.mjs` and `scripts/plan-round.mjs` production output unchanged.

### 3. P2(a,c) — SIGTERM liveness and positional output

- In [test/round-scripts.test.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/round-scripts.test.mjs):
  - Add a `pgrep -f` helper using the existing `execFile` import. Exit code 1 means no matches.
  - Give each SIGTERM case a unique marker argument by overriding `CODEX_DRIVE_TEST_APPSERVER`; the mock ignores the extra argument but exposes it in its process command line.
  - Poll until that marked mock app-server exists before sending SIGTERM.
  - After asserting exit code 143 and the cleanup log, poll until no marked app-server remains.
  - In `finally`, terminate only PIDs carrying that unique marker so a failing regression test does not itself leave an orphan.
  - Replace independent metadata matches with exact prefix helpers:
    - review output begins exactly `STATUS`, `PARSED_VERDICT`, `=== REVIEW ===`;
    - plan output begins exactly `STATUS`, optional exact `PLAN_FILE: <out>`, `=== PLAN ===`.
  - Apply those helpers to every successful review/plan scenario that currently checks metadata independently.
- In [test/review-round.test.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/review-round.test.mjs), add the same three-line review-prefix assertion for all fail-closed cases: `STATUS: failed`, `PARSED_VERDICT: UNCLEAR`, `=== REVIEW ===`.
- Do not copy `lastTwo()` literally. `commit-review-round` has tail trailers, while the inspected review/plan scripts and agent contracts intentionally expose metadata as a prefix before the raw body.

### 4. P2(b) — isolated private HOME

- In [test/detached-cli.test.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/detached-cli.test.mjs):
  - Change `--private writes NO global state` to create a short redirected HOME with `mkdtempSync('/tmp/cdx-h-')` and register it in `DIRS`.
  - Start the private daemon directly with that same environment, parse and register its socket before assertions, and use the redirected environment for stop.
  - Assert the redirected `HOME/.codex-drive/state.json` is absent before and after start.
  - Change the adjacent redirected-HOME private test to use the same direct `/tmp` form, avoiding macOS’s 104-byte Unix-socket limit.

### 5. P2(d) — deliberate interrupt cleanup grace

- In [lib/drive-loop.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/drive-loop.mjs), retain the fixed `INTERRUPT_TIMEOUT_MS`.
  - Document at the constant, `deadlineMs` JSDoc, and `interruptAndReturn` that the total deadline bounds turn work, while interruption is a separate bounded cleanup grace of up to 10 seconds.
  - Explain that passing an exhausted/zero budget to `sendCommand` means “no timeout,” while skipping or immediately abandoning interruption can leave the server turn running.
- In [test/drive-loop.test.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/drive-loop.test.mjs), update the existing zero-budget test comment to state the contract: no further wait is attempted, but one cleanup interrupt is still required. Do not add a slow 10-second timing test.

### 6. P3 — rejected starts remain recoverable

- Keep the current non-quarantine behavior in [lib/daemon.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs).
  - Rewrite the rejection and finalized-turn comments to remove the contradictory claim that a supported app-server continues a turn after returning a JSON-RPC error.
  - State that pre-response buffering handles notification/success-response observation order; it does not establish ownership when the authoritative response is an error.
  - Retain finalization as defensive protection against stray or malformed late traffic.
- Position A is supported by the [official app-server lifecycle](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) and [turn processor](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/request_processors/turn_processor.rs): validation/submission failures return errors before a turn is established; successful submission produces a normal start response. This also matches the repository’s existing native-review design specification.
- In [test/daemon-review.test.mjs](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/daemon-review.test.mjs):
  - Tighten the existing rejected-start test with a deferred rejection.
  - While the response is pending, feed a same-thread nonterminal notification so `turn.buffered` is non-empty, then reject.
  - Assert the turn is failed/finalized, late traffic cannot resurrect it, and `restartRequired` remains false.
  - Remove the duplicated `finalized` assertion.
  - This explicitly rejects Position B’s proposed `turn.buffered.length` quarantine heuristic: without an authoritative ID, buffered traffic does not prove it belongs to the rejected request.

## Test and Review Gates

| Check | Required failure trigger proving non-vacuousness |
|---|---|
| Waiter lifecycle unit test | Removing listener detachment, close-side waiter removal, or idempotence allows a listener/waiter leak or removes the successor waiter. |
| SIGTERM app-server process check | Deleting `daemon.stop()` from either signal handler still exits 143 but leaves the marked mock alive, failing the post-exit poll. |
| Private HOME test | Removing the private-state guard in `codex-drive.mjs` creates redirected `state.json`, failing the absence assertion. |
| Review/plan prefix assertions | Reordering headers, inserting body text between them, or moving the delimiter makes exact prefix comparison fail. |
| Fail-closed review prefix assertions | Reordering or omitting failed/UNCLEAR/delimiter output fails even if those strings appear elsewhere. |
| Rejected-start test | Adding unconditional quarantine or the proposed `turn.buffered.length` quarantine sets `restartRequired`, failing the test; bypassing `_finalizeTurn` fails finalization/resurrection assertions. |
| Zero-budget cleanup test | Removing the interrupt call after deadline exhaustion leaves the recorded interrupt count at zero. |
| Agent fallback static check | Restoring any fixed `/tmp/cdx-plan-*` or `/tmp/cdx-fallback-*` sidecar makes `rg` find a forbidden shared path. |

Run, in order:

1. Targeted suite from `codex-claude`:
   `node --test test/daemon.test.mjs test/daemon-review.test.mjs test/drive-loop.test.mjs test/detached-cli.test.mjs test/round-scripts.test.mjs test/review-round.test.mjs`
2. Full `npm test`.
3. `git diff --check 2978385..HEAD`.
4. Confirm no shared fallback paths with:
   `rg -n '/tmp/cdx-(plan|fallback)-(start|sock|prompt)' codex-claude/agents`
   and require no matches.
5. After the candidate fixes are committed, independently review the complete intended range:
   `node codex-claude/scripts/commit-review-round.mjs --cwd "$PWD" --base 2978385`
   Require a completed status, the expected base/head scope, and no unresolved findings.

## Interfaces and Assumptions

- No dependencies, CLI flags, JSON wire shapes, output ordering, state schema, or version metadata change.
- No work is planned for the three “Accepted, not open” decisions.
- No applicable `CLAUDE.md` or `AGENTS.md` exists at the inspected HEAD; the brief’s explicit no-dependency, minimal-diff, and scope-discipline rules are therefore treated as binding.
- The planning sandbox could not establish a fresh full-suite baseline because Unix socket binding returned `EPERM`; acceptance requires the normal-host test runs above.
