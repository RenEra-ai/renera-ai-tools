# Native commit review in codex-claude (absorb the openai-codex review gate)

**Date:** 2026-07-16 (rev 2, after Codex architect review — verdict REWORK, 11
findings, all addressed below)
**Status:** approved design, pre-implementation
**Decision owner:** Gleb

## Problem

The boomi-mcp-server Stage-2 review gate depends on the third-party `openai-codex`
plugin's `codex-companion.mjs review`. That dependency has recurring costs:

- A local `--background` patch to the companion is wiped by every plugin update and
  must be re-applied by surgical merge (documented failure mode since 1.0.5; the
  plugin is now 1.0.6).
- The companion's effort allowlist is stale (`none…xhigh`, missing GPT-5.6's
  `max`/`ultra`), and its `review --model` path bypasses `normalizeRequestedModel`
  (upstream bug at codex-companion.mjs:763,780).
- Everything the gate actually uses from the plugin is a thin veneer over the Codex
  app-server's **native** `review/start` method — a protocol codex-claude already
  speaks through its own daemon.

Only the review gate is in use (`review --wait`, `cancel`, `status`/`result` for
recovery). `rescue`, `task`, `transfer`, `adversarial-review` are unused.

## Decision

Absorb git-scoped commit review into codex-claude as a first-class verb driving the
native `review/start` method, repoint the boomi-mcp-server CLAUDE.md gate at it, then
uninstall the openai-codex plugin. Unused companion features are dropped, not ported.

## Verified protocol contract

Established 2026-07-16 by live `model/list` query and by reading the companion's
working implementation (codex-companion.mjs, lib/codex.mjs, lib/git.mjs):

- Request: `review/start` with params `{threadId, delivery: "inline", target}`.
  Response carries `reviewThreadId`.
- The companion runs reviews on a thread started with `sandbox: "read-only"` and
  `ephemeral: true` — this is part of the contract we reproduce, NOT an emergent
  property of a private daemon socket.
- `target` is one of:
  - `{type: "uncommittedChanges"}` — working-tree scope
  - `{type: "baseBranch", branch: <ref>}` — diff vs a ref; `<ref>` may be a branch
    name **or a commit SHA** (the `--base <last-reviewed-sha>` fix-scope re-review
    rides this variant)
- Result delivery: an `item/completed` notification whose item is
  `{type: "exitedReviewMode", review: "<full review text>"}`, followed by a normal
  `turn/completed`. No effort field exists on `review/start`; the review inherits
  the effective Codex config (`CODEX_HOME/config.toml`).
- **Unverified but asserted:** with `delivery: "inline"` the review is believed to
  run on the requesting thread (`reviewThreadId` == source thread id). We could not
  independently confirm this from the installed schema, so the daemon MUST validate
  it at runtime: if the `review/start` response carries a `reviewThreadId` different
  from the session thread, the turn fails loud (`failed`, reason recorded). No
  silent second-thread listening.
- Current live models (`model/list`, 2026-07-16): gpt-5.6-sol (default, frontier),
  gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark.
  Sol/Terra efforts: low, medium, high, xhigh, max, ultra. `max` = maximum reasoning
  depth; `ultra` = max reasoning **plus automatic task delegation** (slower; blows
  the 540 s round-script wait cap — the documented plan-timeout root cause).
  Empirical: even at `max`, a repo-wide design review exceeded 540 s twice
  (2026-07-16); the fallback path below is mandatory, not optional.

## Architecture

The existing prompt-based plan-vs-implementation review (`scripts/review-round.mjs`,
used by /codex-issue §6) is untouched. Native commit review is a second review kind
on the same daemon stack:

```
CLAUDE.md Stage-2 gate
  └─ scripts/commit-review-round.mjs        (one-shot; private ephemeral session)
       └─ lib/daemon.mjs  cmd:'review'      (new verb)
            └─ review/start {threadId, delivery:'inline', target}
            ← item/completed {type:'exitedReviewMode', review:<text>}
            ← turn/completed
```

One JSON-RPC client (the daemon), two review kinds. No second app-server client is
vendored in.

## Components

### New: `lib/git-scope.mjs` (~80 lines)

Port of the companion's `resolveReviewTarget` semantics (lib/git.mjs:135-191), with
STRICT input validation (the daemon is the authoritative validator — the CLI parser
turns a valueless `--base` into boolean `true` and preserves empty strings, so
truthiness is not safe):

- `base`, when present, MUST be a non-blank string → `{mode:'branch', baseRef}`;
  boolean/empty/whitespace `base` → error, never a silent scope fallback.
- `scope`, when present, MUST be one of `auto | working-tree | branch` → as named;
  anything else → error.
- `base` and `scope` are **mutually exclusive** → error when both are given
  (deterministic; no precedence rule to remember).
- default (`auto`) → working-tree if the tree is dirty (staged, unstaged, or
  untracked present), else branch vs detected default branch.
- outside a git repo → error.

Plus `buildNativeReviewTarget(target)` mapping the resolved scope to the wire shape
(`uncommittedChanges` / `baseBranch`). Pure functions over `git` subprocess calls.

### Extended: `lib/protocol.mjs`

- `METHODS.REVIEW_START = 'review/start'`
- `buildReviewStart({threadId, target})` — validates target shape (one of the two
  literal type strings; `baseBranch` requires a non-empty string `branch`), returns
  params. No effort/model fields: a review turn inherits the effective config by
  design, matching the companion's behavior byte-for-byte.

### Extended: `lib/daemon.mjs` + `lib/verbs.mjs` + `bin/codex-drive.mjs`

- verbs: `review` verb, flags `--base <ref>`, `--scope <auto|working-tree|branch>`
  → `{cmd:'review', base, scope}` (validation happens in the daemon, above).
- `start` gains thread-profile flags `--sandbox <mode>` and `--ephemeral`, passed
  through to `thread/start` (today it sends bare `{}` — daemon.mjs:32). A review
  session REQUIRES `--sandbox read-only --ephemeral`; the one-shot script always
  starts its private daemon that way, and the documented fallback recipe does the
  same explicitly.
- daemon: `Daemon` constructor gains an explicit `cwd` option (today the app-server
  inherits process cwd implicitly; tests need a temp-repo cwd).
- daemon: `case 'review'` → `_startReview({base, scope})`, mirroring `_startTurn`'s
  established lifecycle EXACTLY (daemon.mjs:94-120):
  - busy guard first (`running`/`awaiting_input` → `{error:'busy'}`);
  - resolve + validate scope via git-scope against the daemon `cwd`; validation
    error → returned synchronously, turn state untouched;
  - reset per-turn state BEFORE the RPC, with a new turn kind:
    `isReview: true`, and a new authoritative `reviewText: null` field;
  - **do not await** `review/start` (the non-awaiting pattern is load-bearing:
    response + notifications can arrive in one stdout burst, and `sendCommand`
    has no default timeout — client.mjs:3). Return `{ok, scope: <label>}`
    immediately; notifications drive turn state.
  - track the response asynchronously exactly like `_startTurn` does: rejection →
    `turn.status='failed'` + `_resolveWaiters()`; a response whose
    `reviewThreadId` differs from `this.threadId` → same failure path (the
    asserted-invariant rule above).
- notification capture: on `item/completed` with `item.type === 'exitedReviewMode'`,
  store `item.review` into `turn.reviewText` (NOT `turn.message` — the
  `turn/completed` handler unconditionally rebuilds `turn.message` from the
  plan/agent buffers at daemon.mjs:240-252 and would clobber it). Finalization
  precedence in `turn/completed` becomes: review turn → `reviewText`; plan turn →
  plan text; else agent-message buffer. A review turn that completes with blank
  `reviewText` finalizes as `failed`, not `completed`-with-empty.
- staleness filtering: extend `_isStaleTurn` to also reject notifications carrying
  a `threadId` that is not the session thread (today only `turnId` is compared —
  daemon.mjs:208; the AppServer forwards ALL notifications unfiltered).

### New: `scripts/commit-review-round.mjs` (~140 lines)

One-shot driver. It reuses `review-round.mjs`'s private-ephemeral-daemon LIFECYCLE
only — its output/exit contract deliberately DIFFERS (review-round always exits 0
and fronts metadata, by design of its /codex-issue parser; this script serves a
shell gate and must be exit-code-honest):

1. Pre-validate FIRST, before any daemon boots: flags parse, `--scope` value known,
   `--base` non-blank if present, `--base`/`--scope` not combined, cwd is a git
   repo (`git rev-parse`). Failure → usage message, **exit 1**. (The daemon
   re-validates authoritatively; this is fail-fast UX only.)
2. Boot the private-socket daemon INSIDE the try/finally (unlike review-round,
   which boots before its try — boot failure must still hit cleanup), with
   `sandbox: 'read-only'`, `ephemeral: true`, temp-dir socket.
3. Send `review`, then bounded wait (`WAIT_TIMEOUT_MS = 540000`), driving parked
   states:
   - clarifying question → answer with its first option (drain-guarded);
   - command/file/legacy approval → **deny** (no safe-command allowlist — unlike
     review-round.mjs:73, a native review never legitimately needs a command);
   - `item/permissions/requestApproval` (whose answer path deliberately throws —
     protocol.mjs:92), an unknown request shape, a malformed question, or
     drain-guard exhaustion → `interrupt` + `STATUS: failed`. The spec does NOT
     promise "review continues" past these.
4. Output contract, in this exact order:
   - the review text RAW and in full (stdout);
   - trailer line 1: `STATUS: completed | timeout | failed`;
   - trailer line 2: `SCOPE: <label>` (from the daemon's review response).
   No verdict parsing: the companion never parsed native review text either
   (renderNativeReviewResult dumps it raw); the Stage-2 zero-issues decision stays
   with Claude reading the findings under receiving-code-review.
5. Exit codes, pinned: **0** only for `completed` with non-blank review text;
   **1** usage/preflight/daemon-boot failure; **2** timeout (after `interrupt`),
   `failed`, `interrupted`, unexpected terminal status, or blank review text on a
   completed turn (fail-closed, never presentable as a clean review).
6. `finally`: daemon stop + temp-dir removal, covering every exit path above.

### Long-review fallback (no detached worker)

Empirically required (see contract section). Two rules the first draft got wrong,
now explicit:

- **After a one-shot failure, NEVER touch the shared `codex-drive` session.** The
  one-shot's daemon is private and self-cleaning (interrupt + teardown are
  internal). The global CLI verbs consult `~/.codex-drive/state.json`
  (state.mjs:6, codex-drive.mjs:32) and would interrupt an UNRELATED session.
  Recovery from a one-shot failure is: retry the one-shot once; if it times out
  again, switch to the fallback below.
- The fallback runs on an explicitly OWNED session (refuse to proceed if
  `codex-drive status` shows a live foreign session — never force-stop it):

```
node <cache>/bin/codex-drive.mjs start --cwd <repo> --sandbox read-only --ephemeral
node <cache>/bin/codex-drive.mjs review [--base <sha>]
# repeat (each its own shell call):
node <cache>/bin/codex-drive.mjs wait --timeout-ms 540000
#   → completed: proceed to read
#   → timeout (CLI exit 2): loop again
#   → question/approval parked: answer first option / deny via `answer`/`approve`,
#     then loop; on any unsupported/malformed park: interrupt, treat as failed
#   → failed/unsupported: stop, surface the failure
node <cache>/bin/codex-drive.mjs read --out <file> --full   # validate non-empty
node <cache>/bin/codex-drive.mjs stop                        # always, owned session only
```

`<cache>` = the resolved plugin cache dir (below). `codex-drive` is NOT on PATH;
the bare name in earlier drafts was not executable.

This replaces the companion's `--background` detached worker and its `status` /
`result` / `cancel` job-control layer entirely.

## CLAUDE.md gate changes (boomi-mcp-server)

- Resolve the runtime script once per session, version-aware (`sort -V`, not
  lexical `sort`, which mis-orders 1.10 vs 1.9), fail if absent:

  ```bash
  CRR="$(ls -d ~/.claude/plugins/cache/renera-ai-tools/codex-claude/*/ 2>/dev/null \
        | sort -V | tail -1)scripts/commit-review-round.mjs"
  [ -f "$CRR" ] || { echo "codex-claude cache copy not found" >&2; exit 1; }
  ```

- Stage-2 first review: `node "$CRR"` (auto scope). Fix-scope re-reviews:
  `node "$CRR" --base <last-reviewed-sha>` (unchanged scoping rule).
- Failure recovery: retry the one-shot once; second failure → the daemon-verbs
  fallback above (never the shared-session interrupt/stop of earlier drafts).
- Remove: the `find …codex-companion.mjs` invocations, `--wait`/`--background`
  prose, `/codex:status` / `/codex:result` references, and the cancel command.

## Effort/model policy (same release)

- `ultra` → `max` at every explicit call site: `agents/codex-architect.md:38`,
  `commands/codex-architect.md:26`, `skills/codex-claude/SKILL.md:90`, the §effort
  advice at SKILL.md:219-220 (advice becomes: use `max` for hard problems; `ultra`
  adds delegation and can blow the 540 s driver cap), **and the CLI verb table at
  codex-claude/README.md:102** (missed in rev 1).
- Round-script defaults `'ultra'` → `'max'` (plan-round.mjs:23, review-round.mjs:19).
- Public verb tables gain the new `review` verb row (README.md §CLI table,
  SKILL.md §verbs ~:202), explicitly distinguished from the prompt-based `send`
  review.
- `~/.codex/config.toml` `model_reasoning_effort = "max"`: this is a **deployment
  prerequisite, not a repo change** — the repo cannot ship a user-config edit
  (lib/config.mjs reads only the model). It is a checklist item in Decommission
  step 1, verified before the gate cutover. Model stays `gpt-5.6-sol` (verified
  latest).
- `lib/protocol.mjs` EFFORTS list keeps both `max` and `ultra` (deliberate opt-in to
  ultra stays possible; the pinned test at test/protocol.test.mjs:16 already expects
  the 8-value list).

## Release/versioning

- Bump plugin version (1.7.3 → 1.8.0) in `codex-claude/.claude-plugin/plugin.json`
  AND the marketplace listing (`.claude-plugin/marketplace.json`) AND the root
  README version reference — the cache resolver above keys on the version dir, so
  the bump is what makes the new code reachable at runtime.
- Propagation reminder: the runtime copy is the plugin CACHE
  (`~/.claude/plugins/cache/renera-ai-tools/codex-claude/<version>`), refreshed
  from GitHub via the marketplace clone — source edits require commit → push →
  plugin update; `installed_plugins.json` SHAs are not trustworthy for drift checks.

## Decommission (after the gate is proven live)

1. Verify deployment prerequisites: `~/.codex/config.toml` effort=max; plugin
   update pulled; cache dir for the new version present.
2. Repoint boomi-mcp-server CLAUDE.md (above) and verify one real Stage-2 pass.
3. Uninstall the openai-codex plugin (removes /codex:rescue, task, transfer,
   adversarial-review — all confirmed unused).
4. Memory notes: retire `codex-companion-review-background-patched` and
   `codex-companion-review-generation-hang`; update
   `codex-drive-daemon-verbs-timeout-workaround` (effort now max; recipe gains the
   review verb and the owned-session rules).

## Error handling

| Condition | Behavior |
| --- | --- |
| Not a git repo / unknown scope / blank or boolean `--base` / `--base`+`--scope` combined | Script: usage + exit 1 before daemon boot. Daemon: synchronous error, turn state untouched |
| `review/start` rejected, or `reviewThreadId` ≠ session thread | Turn → `failed`, waiters resolved; script exits 2 |
| Command/file/legacy approval requested | Deny; review continues |
| Permissions-shaped approval, unknown request, malformed question, drain exhaustion | Interrupt + `STATUS: failed`, exit 2 |
| Wait cap expires | Interrupt, `STATUS: timeout`, exit 2 |
| Turn completes with blank review text | Turn finalizes `failed`; `STATUS: failed`, exit 2 — never an implicit clean review |
| Daemon boot/socket failure | Inside try/finally: stderr surfaced, exit 1, temp dir cleaned |

## Testing

- Mock upgrades (`test/fixtures/mock-appserver.mjs` — today it implements only
  `turn/start`-shaped turns, mock-appserver.mjs:92): handle `review/start` with a
  real-shaped response `{turn, reviewThreadId}`, emit same-burst response+
  notification ordering, `item/completed{exitedReviewMode}` then `turn/completed`;
  scriptable failure modes: request rejection, mismatched `reviewThreadId`, blank
  review text, parked question, parked approval, interrupt.
- Daemon unit tests (enabled by the new `cwd` option + mock modes): review dispatch
  happy path; busy guard; rejection → failed; wrong-thread response → failed;
  review capture survives `turn/completed` (the clobber case); blank review →
  failed; interrupt uses the owner thread.
- git-scope unit tests: dirty/clean tree, SHA base, detached HEAD, non-repo,
  blank/boolean base, base+scope conflict (temp-dir git fixtures).
- verbs parse table: `review --base x`, `--scope working-tree`, valueless `--base`.
- One-shot script: preflight failures and exit codes 1/2 are testable offline
  against the mock (per-mode); the completed-review happy path additionally gets a
  live smoke run (same limitation as review-round today — review-round.test.mjs:10).
- Live validation (renera-ai-tools repo): one working-tree review, one `--base
  <sha>` review; then one full boomi-mcp-server Stage-2 gate pass before the
  companion is uninstalled.

## Out of scope

- Porting rescue / task / transfer / adversarial-review (unused; die with the
  plugin).
- Any change to review-round.mjs / plan-round.mjs beyond the effort default.
- Focus text / custom review instructions on the native reviewer (`review/start`
  does not take a prompt; the prompt-based review-round.mjs remains the tool for
  that).
- Detached/background workers of any kind (the owned-session fallback covers long
  reviews).
