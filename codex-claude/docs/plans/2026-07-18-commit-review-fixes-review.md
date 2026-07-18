# VERDICT — sound-with-adjustments

The plan has the right overall architecture and explicitly maps all 40 findings, but it is not safe to implement literally. D2 and D4 are largely sound; D3 needs stronger consumer tests; D1 has three correctness gaps around cancellation, parked requests, and app-exit finalization.

## 1. Design decisions

### D1 — daemon lifecycle invariants: challenge

- **I1 is correct in intent.** The rejection arm at [daemon.mjs:208](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:208) duplicates finalization but omits `finalized=true`, unlike `_failTurn` at [daemon.mjs:260](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:260).

- **I1 and the app-exit exception are internally contradictory.** “Every failed turn goes through `_failTurn`” conflicts with `_failTurn` always settling requests while `_onAppExit` must not write to the dead transport. AppServer rejects pending RPCs before emitting exit at [appserver.mjs:29](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/appserver.mjs:29), so not responding after exit is correct. The finalizer needs an explicit `settleRequests:false`/transport-dead mode; otherwise either I1 or the no-write rule will be violated.

- **I2 does not fully close `daemon.mjs:359`.** Waiting until `turn/completed` to answer `turn.parked` is too late: the server may withhold completion while its server request remains unanswered. `_interrupt` currently awaits `turn/interrupt` at [daemon.mjs:359](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:359), while parked requests originate at [daemon.mjs:487](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:487). The parked request must be answered during `_interrupt`, before waiting for terminal notification. Clearing `parked` must also move `awaiting_input` back to a safe non-parked state so `_wait()` cannot dereference `null`.

- **I3 is sound.** Adding `finalized` to the decline branch prevents the terminal-to-parked resurrection currently possible at [daemon.mjs:505](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:505).

- **I4 can misfire exactly as suspected.** While the active ID is unknown, `_isStaleTurn` cannot distinguish a previous same-thread completion at [daemon.mjs:367](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:367). Immediate failed/interrupted finalization follows rev 5 at [spec:321](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/docs/specs/2026-07-16-commit-review-native-design.md:321), but allowing a second turn immediately after a locally finalized, ID-less turn lets the old completion terminate the new turn. Calling this a documented liveness trade-off does not make the new second-turn test safe.

- **The broad late-response interrupt is also unsafe.** `_onStartResponse`’s early return at [daemon.mjs:230](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:230) covers backstop finalization, app exit, immediate failed completion, and explicit local cancellation. Only the last case warrants a late interrupt. Rev 5 explicitly says a backstop-finalized late response is ignored and needs no interrupt at [spec:307](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/docs/specs/2026-07-16-commit-review-native-design.md:307). Any fire-and-forget request must also end with `.catch(() => {})`.

- **Moving the params guard is good, but the replay path should use it.** Production buffered entries previously passed `_onNotification`, so deleting the duplicate foreign-thread check is not immediately exploitable. However, claiming `_onNotification` is authoritative while replay calls `_dispatchNotification` directly at [daemon.mjs:250](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:250) is brittle. Replay notifications through `_onNotification` after clearing `awaitingResponse`; keep server requests on `_onServerRequest`.

- **Gating `reviewThreadId` on `turn.isReview` is correct.** The current `resolved` side channel at [daemon.mjs:239](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:239) is unnecessary and weaker than the recorded turn kind.

### D2 — flag validation: confirm

The shared allowlist is the right fix. `start` and `doctor` return before `toCommand` at [codex-drive.mjs:43](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/bin/codex-drive.mjs:43), while `assertKnownFlags` currently exists only inside [verbs.mjs:112](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/verbs.mjs:112). Rejecting transport flags for these two verbs is also correct because they would otherwise be silent no-ops.

Two small additions are needed:

- Validate all three boolean-only flags (`force`, `private`, `resume-latest`) with table-driven tests, including `start --help`.
- Apply `requireValue` to `--text` as well as `--id`; otherwise valueless `--text` still becomes the literal answer `"true"`.

### D3 — shared constants and drive loop: confirm concept, challenge completeness

- Exporting `REVIEW_PROFILE`, `CLIENT_INFO`, `SCOPES`, and `fullSha` removes real duplication. Keeping `CLIENT_INFO.version` at `0.1.0` follows [spec:617](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/docs/specs/2026-07-16-commit-review-native-design.md:617).

- The drive-loop extraction is appropriate, but its contract must specify how `{error:...}` responses from `answer`/`approve` are handled, what happens when the total deadline is already exhausted, and that `timeoutMs=0` is never passed to `sendCommand` because zero means unbounded at [client.mjs:8](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/client.mjs:8).

- Shared first-option extraction should support `{value}` as well as `{label}`. The daemon already does so at [daemon.mjs:334](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/daemon.mjs:334), whereas all three scripts currently use only `.label`, for example [commit-review-round.mjs:156](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/scripts/commit-review-round.mjs:156).

- “Existing tests are the drift alarm” is false. [review-round.test.mjs:10](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/review-round.test.mjs:10) explicitly says it never exercises the daemon/drive path, and there is no `plan-round.test.mjs`. Drive-loop unit tests alone do not verify consumer policy closures, static re-asks, logging, or output.

### D4 — one-shot preflight: confirm with minor corrections

Using `parseArgs`, exported flag helpers, `resolveReviewTarget`, exported `SCOPES`, and scrubbed `fullSha` is correct. It closes the mismatch between raw git calls at [commit-review-round.mjs:78](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/scripts/commit-review-round.mjs:78) and authoritative validation at [git-scope.mjs:135](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/git-scope.mjs:135).

The signal handlers must be installed before `mkdtempSync`/daemon boot and guarded against re-entry. Preflight errors must continue to print `USAGE`, as required by [spec:678](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/docs/specs/2026-07-16-commit-review-native-design.md:678); calling the current `die()` at [commit-review-round.mjs:36](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/scripts/commit-review-round.mjs:36) with only `e.message` would lose that contract.

## 2. Phase ordering and finding coverage

All 40 findings appear in a `closes` list, and the main dependencies are ordered correctly: fixture capabilities before lifecycle tests, flag helpers before one-shot parser reuse, git exports before preflight, and drive-loop creation before commit-review migration.

The semantic coverage has these gaps:

1. `daemon.mjs:359` is only tested after manually injecting completion; it does not prove `_interrupt` answers the parked request soon enough to permit completion.
2. `daemon.mjs:360` is “closed” by allowing a second review, but that behavior creates the stale same-thread I4 race.
3. `daemon.mjs:171` remains accepted rather than fixed, which is transparent, but its mitigation still treats a probe timeout as proof the daemon is dead.
4. Phase 5 can regress `review-round` and `plan-round` without detection because their real drive paths lack offline consumer tests.
5. Phase 1’s full `$TMPDIR` census cannot pass as written: successful tests also leak directories in [client.test.mjs:14](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/client.test.mjs:14), [config.test.mjs:9](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/config.test.mjs:9), [review-round.test.mjs:19](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/review-round.test.mjs:19), and [state.test.mjs:9](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/test/state.test.mjs:9).
6. Phase 7 updates the SKILL interrupt contract but misses the public README row that still advertises `{error:"no_active_turn"}` at [README.md:213](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/README.md:213).

## 3. Seven declared deviations

1. **`daemon.mjs:171` sync git — disagree with the mitigation as sufficient.** Keeping sync git for v1.8.3 is defensible and matches rev 5, but raising the probe to 10 seconds merely moves the failure threshold. A timeout at [codex-drive.mjs:138](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/bin/codex-drive.mjs:138) must be treated as “possibly live; refuse replacement,” not as a stale socket eligible for state overwrite.

2. **Pre-ID local failure plus late interrupt — disagree as written.** It needs an explicit cancellation marker and an unknown-ID quarantine/restart rule; checking only `finalized` is too broad, and immediate second-turn reuse is unsafe.

3. **Skipping the combined ref+HEAD invocation — agree.** Saving one extra process does not justify complicating the validation/error contract.

4. **No >1 MiB maxBuffer regression fixture — agree.** A 64 MiB constant plus ordinary git-scope coverage is proportionate; constructing tens of thousands of files is not.

5. **`CLIENT_INFO` remains `0.1.0` — agree.** The finding is duplication, not release-version synchronization.

6. **Broader answer validation — agree.** Requiring `--id`, exactly one answer source, and a positive integer option improves the public contract; add nonblank `--text` validation.

7. **Repeated flags remain last-wins — agree.** This matches `parseArgs` at [verbs.mjs:3](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/lib/verbs.mjs:3) and removes the one-shot divergence without inventing another parser policy.

## 4. Missed spec or convention conflicts

- Rev 5 says `review-round.mjs` and `plan-round.mjs` are out of scope beyond effort defaults at [spec:776](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/docs/specs/2026-07-16-commit-review-native-design.md:776). Migrating them is justified by finding `commit-review-round.mjs:141`, but it must be declared as an additional deviation and covered by rev-6 notes and tests.

- The proposed broad late interrupt conflicts with rev 5’s backstop rule to ignore late responses.

- Rev 5 says superseded responses are “logged and dropped” at [spec:692](/Users/gleb/Documents/Projects/Renera/renera-ai-tools/codex-claude/docs/specs/2026-07-16-commit-review-native-design.md:692), but the daemon has no logging path and the plan adds none. Rev 6 should say “dropped” unless logging is deliberately introduced.

- “Every server request gets exactly one response” must be qualified as “while the transport remains writable.” App exit is a legitimate transport-loss exception.

- The shared helper’s deadline must use a monotonic elapsed-time source and must interrupt immediately when no positive budget remains; otherwise rounding to zero recreates the unbounded-wait bug being fixed.

## 5. Concrete adjustments

1. **Phase 2, `daemon.mjs`:** make `_failTurn`/the terminal finalizer accept an explicit transport policy. `_onAppExit` must use the same finalizer with request settlement disabled and local buffered/parked state cleared.

2. **Phase 2, `_interrupt`:** send/queue `turn/interrupt`, answer and clear any parked request immediately, normalize `awaiting_input` to a non-parked state, then await the interrupt RPC. Add a test proving the response is emitted before any `turn/completed`.

3. **Phase 2, unknown-ID finalization:** retain previous known turn IDs for pre-response stale filtering. If a locally finalized pre-response turn has no authoritative ID, mark the session `restart_required` and refuse new turns until restart; replace the unsafe “second review accepted immediately” assertion. Only an explicit cancel marker may trigger a late best-effort interrupt, always with a rejection handler.

4. **Phase 2, replay:** replay buffered notifications through `_onNotification`, not `_dispatchNotification`, so the params and foreign-thread guards truly remain authoritative. Add foreign and malformed buffered-entry tests.

5. **Phase 2, `bin/codex-drive.mjs`:** keep the 10-second probe if desired, but distinguish connection-refused/not-found from timeout or malformed response. Only definite absence may replace state; timeout must fail closed without overwriting `state.json`.

6. **Phase 5, `drive-loop.mjs`:** specify and test action-response errors, `{label}`/`{value}` option extraction, monotonic total-budget arithmetic, immediate timeout at zero remaining budget, and exact drain-count semantics. Add offline subprocess tests for both migrated consumers, including approval policy, question handling, static re-ask, output, and cleanup.

7. **Phase 1 verification:** either clean every `cdx-*` directory created by the full test suite or narrow the census to the prefixes in scope. Compare mock-process counts before/after rather than requiring globally empty `pgrep` output in a shared workspace. Ensure helpers clean up even when daemon startup itself throws before returning.

8. **Phase 3, flags:** test `start --help`, `--force no`, `--private no`, and `--resume-latest no`; validate nonblank `--text`; isolate start/doctor tests under a temporary `HOME` when asserting no state mutation.

9. **Phase 4, `fullSha`:** define explicit errors at every caller after changing failure to `null`, especially `HEAD`, so no caller reaches `.slice()` or builds a target from `null`.

10. **Phase 6, one-shot:** preserve `USAGE` on every usage/preflight failure; install idempotent SIGINT/SIGTERM cleanup before resource creation; keep exit 130/143 after cleanup completes.

11. **Phase 7, docs/spec:** update both SKILL and README interrupt contracts, declare the review/plan driver migration as an eighth deviation from rev 5, qualify the request-response invariant for transport death, and reconcile “logged and dropped” with the actual implementation.
