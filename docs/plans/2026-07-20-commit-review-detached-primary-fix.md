# v1.8.9 — Make Detached Review the Primary Stage-2 Gate

> **⚠️ SUPERSEDED — historical design sketch (1.8.9). Do NOT follow the shell blocks below.**
> The shipped model diverged materially over rounds 1.8.10–1.8.19 (see the
> `2026-07-20-detached-review-hardening-18xx.md` docs). Read `scripts/commit-review-collect.mjs`,
> `scripts/commit-review-status.mjs`, and the consumer recipe as authoritative. In particular, the
> sketches here are wrong in ways that would reintroduce fixed bugs:
> - **Markers are never pre-created.** These blocks `cp baseline last-reviewed-sha` and copy the prior
>   round's `last-reviewed-sha` into a new run directory. Under the shipped model `last-reviewed-sha`'s
>   existence (as a regular file whose content equals `start-head`) *is* the completed verdict — so
>   pre-creating or copying it makes a fresh run read as complete before any review runs, and with an
>   uncommitted fix (HEAD unchanged) the copied SHA even equals the new `start-head`. A new round reads
>   the prior SHA into its `baseline`; it does not copy the marker.
> - **`phase` is not a lifecycle state-machine.** These blocks write `initialized`/`started`/`running`/
>   `failed-start`. The shipped `phase` holds ONLY `failed` or `timeout` (completion lives in
>   `last-reviewed-sha`), and the collector writes exactly one terminal value at the end.
> - Recovery is done by `scripts/commit-review-status.mjs`, which validates marker content and
>   provenance — never by eyeballing file existence.

## Summary

Replace the one-shot-first Stage-2 workflow with the existing detached private-session primitives.
Long reviews run as `start --private` → native `review` → bounded `wait` polls in separate Bash
calls, so an individual Bash timeout cannot destroy a healthy Codex turn. Keep
`commit-review-round.mjs` unchanged as a short-turn compatibility tool; increasing its internal
deadline cannot beat the caller's roughly 600-second Bash ceiling and would trade an honest timeout
for SIGTERM teardown of its in-process daemon.

The production architecture is **prose polling recipes over the existing CLI**, not a new polling
orchestrator. Add one deliberately narrow production helper, `scripts/commit-review-collect.mjs`,
for the terminal step only: it reads the detached result, validates that a claimed completion is
non-empty, stops the owned daemon, and emits the single hook-visible raw-review/`STATUS:`/`SCOPE:`
contract. This exception makes the security- and hook-critical terminal contract executable and
testable without moving polling policy into another long-lived wrapper.

Preserve the consumer's existing **dirty working-tree re-review** capability. An uncommitted fix
continues to use native auto scope; a committed fix uses `--base <last-reviewed-sha>`. Requiring a
commit for every fix would rewrite the established fix loop and add review-only commit noise. The
terminal scope therefore attests the captured start `HEAD` and explicitly records
`dirty=true|false`; it does not claim that dirty content is represented by a commit SHA. Agents must
not mutate the worktree while its review is active, but this release does not add a worktree-content
fingerprint or reject an intentionally dirty tree.

The originating bug report's acceptance criteria 1 and 3 are superseded: the long reproduction is
required to complete through the new primary detached path, not through `$CRR`, and `$CRR` does not
gain a misleading timeout knob that still loses to the outer Bash cap. Criteria 2 (bounded honest
termination for a genuine wedge) and 4 (consumer retry guidance updated) remain required.

## Implementation Changes

### Terminal collection helper

- Add `codex-claude/scripts/commit-review-collect.mjs` with this interface:

  ```text
  commit-review-collect.mjs --state-dir <absolute-run-dir> --outcome <completed|timeout|failed>
  ```

- The helper reads `start.json`, `socket`, `scope`, `start-head`, `dirty`, `cwd`, and the task
  metadata from the unique state directory. Before trusting the result, it cross-checks the socket
  and thread against `start.json` and requires the daemon-reported `cwd` to equal the persisted
  canonical repository path. It then uses 10-second bounded existing `status`, `read`, and `stop`
  operations and allows up to 30 seconds for teardown confirmation; it owns no start, review,
  polling, question, approval, stall, or retry logic.
- `--outcome completed` emits `STATUS: completed` only when `read.status === "completed"`, the
  message is non-blank, all ownership/attestation checks pass, and cleanup is confirmed. Any blank,
  failed, interrupted, malformed, unreadable, or mismatched result becomes `STATUS: failed`.
  `--outcome timeout` and `--outcome failed` may emit non-empty partial text but never upgrade to a
  successful status, even if completion races the caller's abort decision.
- Buffer output until the stop attempt finishes. Because the stop response precedes full daemon
  teardown, confirm within a bounded interval that the socket is unreachable and the recorded
  daemon PID is dead. A cleanup failure downgrades a would-be completion to `STATUS: failed`, exits
  2, retains the state directory, and prints the exact recovery command to stderr. A confirmed stop
  records the terminal state; a successful completion also writes the captured `start-head` to
  `last-reviewed-sha` for the next review round.
- Standard output is only the raw review text, followed by these exact final two lines:

  ```text
  STATUS: completed|timeout|failed
  SCOPE: <captured daemon scope> head=<captured start HEAD> dirty=<true|false>
  ```

  Diagnostics go to stderr. Exit 0 means only a stopped, completed, non-empty review; exit 1 is
  helper usage/preflight; exit 2 is timeout, failure, missing attestation, or incomplete cleanup.
  Once a session has started, a runtime failure still emits the terminal pair, using `(unresolved)`
  for any unavailable attestation field; it can never emit a successful status.
- Do not delete the state directory in the helper. Keep its baseline, last-reviewed SHA, terminal
  record, and cleanup evidence available until the enclosing task finishes; then remove only state
  directories whose daemon is confirmed stopped.

### Sidecar ownership and recovery

- At the start of each logical task, mint `mktemp -d /tmp/cdx-review.XXXXXX`. This absolute path is
  the task's resume token and is printed explicitly. Never use a shared `.codex/review*` path and
  never infer ownership from the global `~/.codex-drive/state.json`.
- Persist `cwd`, `baseline`, `last-reviewed-sha`, `cache-dir`, `start-head`, `dirty`, `t0`,
  `missing-probes`, `start.json`, `socket`, `pid`, `review.json`, `scope`, and `phase`. The baseline
  is written before implementation starts because it cannot be reconstructed reliably at review
  time. Persisting the selected cache path prevents an upgrade during a long turn from silently
  switching later calls to a different plugin build. A later review round uses a new unique
  directory and copies `baseline` and `cache-dir` from the prior completed round, reading the prior
  reviewed SHA into its own `baseline` — it does NOT copy `last-reviewed-sha` (whose existence is the
  completion verdict).
- Shell variables are conveniences within one call only. Every later call is given the literal
  printed run directory and rereads values from files.
- Retrying or collecting the **same logical review** reuses its recorded run directory. Probe its
  socket with `status`:
  - A status response whose `threadId` and canonical `cwd` match `start.json`/`cwd` means the daemon
    is live; resume its current turn. A mismatch is an ownership failure: retain both sessions and
    stop neither automatically.
  - A client probe timeout is indeterminate and is treated as a missing-telemetry strike, never as
    permission to replace or kill the session.
  - A sidecar is stale only when the socket is definitively absent/refused **and** the recorded PID
    is no longer alive. Mark it failed, retain its evidence, and start a new unique run only after an
    explicit retry decision.
  - If the PID is alive or the failure is ambiguous, fail closed and surface the run directory; do
    not start another same-task review or use `--force`.
- A genuinely separate concurrent task gets its own `mktemp` directory and private socket. It may
  coexist; neither task ever stops, overwrites, or resumes the other's session. `/cr --background`
  prints the resume token, and `/cr --wait <run-dir>` attaches only to that token.

The resume probe is also a separate bounded call; its raw exit and JSON are retained for the rules
above:

```bash
RUN_DIR="<printed /tmp/cdx-review.XXXXXX path>"
CACHE_DIR="$(cat "$RUN_DIR/cache-dir")"
DRIVE="${CACHE_DIR}/bin/codex-drive.mjs"
PROBE_RC=0
PROBE_JSON="$(node "$DRIVE" status --timeout-ms 10000 \
  --socket "$(cat "$RUN_DIR/socket")")" || PROBE_RC=$?
printf '%s\nPROBE_RC=%s\n' "$PROBE_JSON" "$PROBE_RC"
```

### Exact detached recipe

Capture and persist the task baseline before any implementation work:

```bash
CACHE_DIR="$(ls -d ~/.claude/plugins/cache/renera-ai-tools/codex-claude/*/ 2>/dev/null \
            | sort -V | tail -1)"
[ -n "$CACHE_DIR" ] && [ -d "$CACHE_DIR" ] \
  || { echo "codex-claude cache copy not found" >&2; exit 1; }
CACHE_DIR="${CACHE_DIR%/}"
DRIVE="${CACHE_DIR}/bin/codex-drive.mjs"
COLLECT="${CACHE_DIR}/scripts/commit-review-collect.mjs"
[ -f "$DRIVE" ] && [ -f "$COLLECT" ] \
  || { echo "detached review runtime missing in $CACHE_DIR" >&2; exit 1; }

RUN_DIR="$(mktemp -d /tmp/cdx-review.XXXXXX)" || exit 1
git rev-parse --show-toplevel > "$RUN_DIR/cwd"
git rev-parse HEAD > "$RUN_DIR/baseline"
printf '%s\n' "$CACHE_DIR" > "$RUN_DIR/cache-dir"
printf 'RUN_DIR=%s\n' "$RUN_DIR"
```

> **Superseded (see the 1.8.10–1.8.18 hardening docs).** This sketch pre-created `last-reviewed-sha`
> (`cp baseline last-reviewed-sha`) and `phase` (`initialized`). Under the shipped single-authoritative-
> record model those markers must NOT be pre-created: `last-reviewed-sha`'s existence as a regular file
> holding the reviewed SHA *is* the completed verdict, and `phase` holds only `failed`/`timeout` — so a
> pre-created marker would make a fresh run read as complete before any review ran. The recipe writes
> neither at startup; the collector writes exactly one of them at the end, and the recovery reader
> (`scripts/commit-review-status.mjs`) validates the marker's content rather than its existence.

At review time, use the printed run directory literally and start the native review with the exact
required profile. The example is the first review against the recorded baseline:

```bash
set -euo pipefail
RUN_DIR="<printed /tmp/cdx-review.XXXXXX path>"
CACHE_DIR="$(cat "$RUN_DIR/cache-dir")"
DRIVE="${CACHE_DIR}/bin/codex-drive.mjs"
SOCKET=""
SESSION_OWNED=0

abort_start_failure() {
  rc=$?
  trap - EXIT
  if [ "$SESSION_OWNED" -eq 1 ]; then
    node "$DRIVE" interrupt --socket "$SOCKET" >/dev/null 2>&1 || true
    node "$DRIVE" wait --timeout-ms 30000 --socket "$SOCKET" >/dev/null 2>&1 || true
    node "$DRIVE" stop --socket "$SOCKET" >/dev/null 2>&1 || true
  fi
  printf 'failed-start\n' > "$RUN_DIR/phase"
  exit "$rc"
}
trap abort_start_failure EXIT

git rev-parse HEAD > "$RUN_DIR/start-head"
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  printf 'true\n' > "$RUN_DIR/dirty"
else
  printf 'false\n' > "$RUN_DIR/dirty"
fi
date +%s > "$RUN_DIR/t0"
printf '0\n' > "$RUN_DIR/missing-probes"

node "$DRIVE" start --private --cwd "$PWD" \
  --sandbox read-only --approval-policy never --ephemeral > "$RUN_DIR/start.json"
jq -er '.socket' "$RUN_DIR/start.json" > "$RUN_DIR/socket"
SOCKET="$(cat "$RUN_DIR/socket")"
SESSION_OWNED=1
jq -er '.pid' "$RUN_DIR/start.json" > "$RUN_DIR/pid"
printf 'started\n' > "$RUN_DIR/phase"

node "$DRIVE" review --base "$(cat "$RUN_DIR/baseline")" \
  --socket "$SOCKET" > "$RUN_DIR/review.json"
jq -er '.scope' "$RUN_DIR/review.json" > "$RUN_DIR/scope"
printf 'running\n' > "$RUN_DIR/phase"
trap - EXIT
printf 'RUN_DIR=%s\n' "$RUN_DIR"
```

For later rounds, only the `review` line changes:

- Uncommitted fix: `node "$DRIVE" review --socket "$SOCKET"` (auto resolves the dirty working
  tree).
- Committed fix: `node "$DRIVE" review --base "<prior round's reviewed SHA>" --socket "$SOCKET"`.
- A new round receives a new `mktemp` directory and reads the prior round's reviewed SHA (from the
  prior `last-reviewed-sha`) into its own `baseline`, plus its pinned `cache-dir`, before capturing its
  own start state. It does NOT copy `last-reviewed-sha` into the new directory — that file's existence
  is the completion verdict, so a copied marker would make the new run read as already complete.

Poll in separate Bash calls. Capture the raw wait exit because a client-side timeout is deliberately
exit 2 in `bin/codex-drive.mjs`; normalize the enclosing poll call only after preserving the JSON:

```bash
RUN_DIR="<printed /tmp/cdx-review.XXXXXX path>"
CACHE_DIR="$(cat "$RUN_DIR/cache-dir")"
DRIVE="${CACHE_DIR}/bin/codex-drive.mjs"
SOCKET="$(cat "$RUN_DIR/socket")"

WAIT_RC=0
WAIT_JSON="$(node "$DRIVE" wait --timeout-ms 300000 --socket "$SOCKET")" || WAIT_RC=$?
printf '%s\n' "$WAIT_JSON"
printf 'WAIT_RC=%s\n' "$WAIT_RC"
printf 'ELAPSED_SECONDS=%s\n' "$(( $(date +%s) - $(cat "$RUN_DIR/t0") ))"

if printf '%s' "$WAIT_JSON" | jq -e \
   'has("lastEventAgoMs") and (.lastEventAgoMs | type == "number")' >/dev/null; then
  printf '0\n' > "$RUN_DIR/missing-probes"
else
  STRIKES=$(( $(cat "$RUN_DIR/missing-probes") + 1 ))
  printf '%s\n' "$STRIKES" > "$RUN_DIR/missing-probes"
  printf 'MISSING_PROBES=%s\n' "$STRIKES"
fi
```

Interpret the saved JSON, not the individual Bash tool's success/failure decoration:

- `status=timeout`, `lastEventAgoMs < 900000`, elapsed `< 3600` seconds: healthy; repeat the poll
  against the same socket.
- A raw wait exit other than 0 or 2, invalid JSON, or a terminal transport error is a failed poll;
  use the bounded graceful-abort path when the daemon remains reachable and otherwise retain the
  state for recovery.
- `status=timeout`, `lastEventAgoMs >= 900000`: stalled; graceful interrupt and collect as failed.
- Elapsed `>= 3600` seconds on any nonterminal result: absolute backstop; graceful interrupt and
  collect as timeout.
- Missing activity telemetry once: poll again. Two consecutive misses: treat as stalled.
- `status=question`: read `.question.questions[0].id`, run
  `answer --id <id> --option 1 --socket "$SOCKET"`, then poll again.
- `status=approval`: run `approve --decision deny --socket "$SOCKET"`, then poll again.
- `status=unsupported`: graceful interrupt and collect as failed.
- `status=completed|failed|interrupted`: invoke the collector exactly once. Do not print a
  `STATUS:` or `SCOPE:` line from any intermediate call; poll JSON therefore cannot match the hook's
  terminal-pair predicate.

Terminal completion is one hook-visible Bash call; the helper performs the read and stop before it
prints:

```bash
RUN_DIR="<printed /tmp/cdx-review.XXXXXX path>"
CACHE_DIR="$(cat "$RUN_DIR/cache-dir")"
node "${CACHE_DIR}/scripts/commit-review-collect.mjs" \
  --state-dir "$RUN_DIR" --outcome completed
```

Stall and backstop use the same bounded graceful-abort sequence, differing only in the terminal
outcome:

```bash
RUN_DIR="<printed /tmp/cdx-review.XXXXXX path>"
CACHE_DIR="$(cat "$RUN_DIR/cache-dir")"
DRIVE="${CACHE_DIR}/bin/codex-drive.mjs"
SOCKET="$(cat "$RUN_DIR/socket")"

node "$DRIVE" interrupt --socket "$SOCKET" >/dev/null 2>&1 || true
node "$DRIVE" wait --timeout-ms 30000 --socket "$SOCKET" >/dev/null 2>&1 || true
node "${CACHE_DIR}/scripts/commit-review-collect.mjs" \
  --state-dir "$RUN_DIR" --outcome failed   # use timeout for the 60-minute backstop
```

Never `kill`, never use shared state or `start --force`, never stop a healthy timeout, and never
start a replacement while the recorded session may still be live.

## Documentation and Consumer Rollout

- Update the plugin README, skill, reviewer guidance, and native-review design revision to identify
  the detached native recipe as the primary Stage-2 path, document the collector interface, and
  label `commit-review-round.mjs` as short-turn-only. Preserve the existing 5-minute poll,
  15-minute inactivity, 60-minute backstop, and two-missing-probe policy.
- Amend the originating bug report with the superseding resolution: criteria 1 and 3 are declined
  for the one-shot; criteria 2 and 4 are mapped to the detached path and consumer cutover. Mark it
  resolved only after the live reproduction passes.
- Release the plugin first as 1.8.9 by updating `.claude-plugin/marketplace.json` and the root
  README. Keep `.claude-plugin/plugin.json` versionless and keep `package.json`/`CLIENT_INFO` at
  `0.1.0`. Verify both the installed-plugin record and the selected cache directory point to 1.8.9
  before changing consumers.
- Before editing the consumer, back up its ignored, untracked gate files outside the repository:

  ```bash
  BACKUP_DIR="$(mktemp -d /tmp/boomi-review-gate-backup.XXXXXX)"
  cp /Users/gleb/Documents/Projects/Renera/boomi-mcp-server/CLAUDE.md "$BACKUP_DIR/CLAUDE.md"
  cp /Users/gleb/Documents/Projects/Renera/boomi-mcp-server/AGENTS.md "$BACKUP_DIR/AGENTS.md"
  printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR"
  ```

- Rewrite the Stage-1 baseline capture and Stage-2 blocks in both `CLAUDE.md` and `AGENTS.md`
  identically. Preserve their version-aware `CACHE_DIR` resolution and replace `$CRR` with `DRIVE`
  and `COLLECT`; that cache variable is reused by every start, review, wait, collect, and recovery
  call and must not be dropped. Keep the dirty-fix/committed-fix scope distinction and remove the
  deterministic one-shot retry.
- Replace direct `$CRR` instructions in all nine `docs/plans/hetzner-migration/` consumers with an
  explicit reference to the revised Stage-2 detached recipe, so none relies on an out-of-scope
  shell variable:
  - `02-fastmcp-upgrade.md`
  - `03-single-instance-maint-api.md`
  - `04-hostname-packaging.md`
  - `05-vm-compose-caddy-ci.md`
  - `07-kb-sync-startup.md`
  - `08-monitoring-watchdog.md`
  - `09-disk-storage-swap.md`
  - `hetzner-migration.md`
  - `original-plan-2026-07-20.md`
- Update the machine-local `/cr` recipe to use the same exact profile, state, polling, and collector
  contract. `--background` returns the run-directory resume token; `--wait <run-dir>` probes and
  resumes only that session. Expand its `allowed-tools` declaration for the exact `jq`, `mktemp`,
  `cp`, `date`, `cat`, and related bounded shell commands the new recipe actually invokes.
- The enforcement hook needs no marker-logic migration: intermediate poll JSON has neither terminal
  trailer, while the collector emits both. Before gate cutover, feed the real hook a collector
  success-with-findings fixture and confirm it emits the receiving-code-review reminder; then remove
  its stale comment claiming daemon-verb fallback lacks enforcement.
- Use `/usr/bin/grep`, not `rg` or the interactive `grep` wrapper, for pre/post-cutover sweeps because
  the consumer gate files are ignored. The final sweep must find no Stage-2 `$CRR` invocation or
  one-shot retry in `CLAUDE.md`, `AGENTS.md`, the nine migration plans, or `/cr`.
- After consumer cutover, run the real reproduction in a separate worktree so the current dirty
  issue-137 worktree is untouched. Exercise both a clean committed first review and a dirty
  working-tree fix review; verify the final hook-visible contract, receiving-code-review reminder,
  resume token, and orphan cleanup before declaring the rollout complete.

## Test Plan

- Extend `test/fixtures/mock-appserver.mjs`'s allowlisted `--review-mode` axis with:
  - `ticks`: return a valid `review/start` response, emit entered/started review events and periodic
    activity across multiple scaled poll intervals, then emit non-empty exited-review text and
    completion.
  - `hang`: return a valid start response and initial entered/started events, then emit no more
    activity and never terminate.

  Do not reuse `noresponse`: it emits notifications and completion while withholding only the
  start response, so it tests the response-ordering backstop rather than slow/stuck liveness.
- Extend detached CLI tests with a test-local driver of the documented prose sequence:
  - A `ticks` review survives at least two client timeout/exit-2 polls, shows increasing event count
    and recent activity, completes, and is never interrupted.
  - A `hang` review shows a stable event count and increasing age, triggers exactly one protocol
    interrupt under scaled thresholds, and reaches the collector as failed.
  - A still-active `ticks` review reaches a scaled absolute backstop and collects as timeout.
  - One missing telemetry probe is retried; two consecutive misses take the failed path.
- Add collector tests for raw-body fidelity, a decoy `STATUS:` inside the body, exact final-two-line
  ordering, blank-completed downgrade, partial timeout/failure output, missing or malformed
  sidecars, captured `head` plus `dirty=true|false`, successful `last-reviewed-sha` update, and stop
  failure downgrading/retaining state. Also prove that later `HEAD` or worktree drift is not a
  rejection under the chosen dirty-tree contract: the trailer must retain the captured start
  values. These are tests of the small helper, not of markdown.
- Add a concurrency regression with two simultaneous private native reviews and two unique state
  directories. Stopping/collecting one must leave the other responsive and its files untouched.
- Assert creating and polling the `/tmp` state leaves the reviewed repository's `git status`
  unchanged. Exercise both clean and intentionally dirty repositories; dirty is supported, not a
  rejection case.
- Tighten `test/commit-review-round.test.mjs`'s cap-expiry test from
  `STATUS: timeout || STATUS: failed` to the exact intentional `STATUS: timeout`, retaining the
  one-shot hard-bound regression.
- Prove daemon and app-server cleanup with the fixture's `--lifecycle-file` plus
  `pidAlive()`/`pollUntil()`, not merely CLI exit codes. Cover normal completion, stall interrupt,
  backstop, collector error, and concurrent-session isolation.
- Run the complete plugin test suite, then the hook fixture and live Boomi smoke tests described in
  rollout. The live acceptance review must cross the old nine-minute boundary without restarting
  the turn and must leave no live PID or socket after collection.

## Assumptions

- Policy defaults remain 300-second polls, 900-second inactivity, 3,600-second total runtime, and
  two consecutive missing-telemetry strikes.
- Dirty working-tree reviews remain a supported primary Stage-2 mode. `head=<sha> dirty=true`
  intentionally attests that the review began from that commit plus uncommitted state; it is not a
  content hash. No code mutation may occur while that review is running.
- No daemon/client wire shape, daemon timeout flag, dependency, model, or reasoning-effort change is
  required. The only new production interface is the terminal collector helper.
- A raw `codex-drive wait --timeout-ms` client timeout emits timeout JSON and exits 2; the prose poll
  command captures that code and ends normally after recording it. No new poll exit code or hook
  marker is introduced.
- `commit-review-round.mjs`, `driveTurn`, and their hard-deadline semantics remain unchanged.
- The Codex model-metadata cache warning remains out of scope; detached app-server stderr currently
  inherits into ignored stdio, so surfacing it requires a separate runtime-observability design.
- The local bug report and this plan remain ignored by the root `docs/` rule unless deliberately
  relocated or force-tracked; release metadata and tracked plugin documentation carry the shipped
  behavior.
