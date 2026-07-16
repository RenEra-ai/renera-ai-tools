# Native commit review in codex-claude (absorb the openai-codex review gate)

**Date:** 2026-07-16
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

- Request: `review/start` with params `{threadId, delivery: "inline", target}` on an
  ephemeral read-only thread. Response carries `reviewThreadId`.
- `target` is one of:
  - `{type: "uncommittedChanges"}` — working-tree scope
  - `{type: "baseBranch", branch: <ref>}` — diff vs a ref; `<ref>` may be a branch
    name **or a commit SHA** (the `--base <last-reviewed-sha>` fix-scope re-review
    rides this variant)
- Result delivery: an `item/completed` notification whose item is
  `{type: "exitedReviewMode", review: "<full review text>"}`, followed by a normal
  `turn/completed`. No effort field exists on `review/start`; the review inherits
  `~/.codex/config.toml`.
- Current live models (`model/list`, 2026-07-16): gpt-5.6-sol (default, frontier),
  gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark.
  Sol/Terra efforts: low, medium, high, xhigh, max, ultra. `max` = maximum reasoning
  depth; `ultra` = max reasoning **plus automatic task delegation** (slower; blows
  the 540 s round-script wait cap — the documented plan-timeout root cause).

## Architecture

The existing prompt-based plan-vs-implementation review (`scripts/review-round.mjs`,
used by /codex-issue §6) is untouched. Native commit review is a second review kind
on the same daemon stack:

```
CLAUDE.md Stage-2 gate
  └─ scripts/commit-review-round.mjs        (one-shot, mirrors review-round.mjs)
       └─ lib/daemon.mjs  cmd:'review'      (new verb)
            └─ review/start {threadId, delivery:'inline', target}
            ← item/completed {type:'exitedReviewMode', review:<text>}
            ← turn/completed
```

One JSON-RPC client (the daemon), two review kinds. No second app-server client is
vendored in.

## Components

### New: `lib/git-scope.mjs` (~70 lines)

Port of the companion's `resolveReviewTarget` semantics (lib/git.mjs:135-191):

- `--base <ref>` → `{mode:'branch', baseRef:ref, explicit:true}`
- `--scope working-tree` → `{mode:'working-tree', explicit:true}`
- `--scope branch` → branch vs detected default branch
- `auto` (default) → working-tree if the tree is dirty (staged, unstaged, or
  untracked present), else branch vs detected default branch
- outside a git repo, or unknown scope → throw before any daemon boots

Plus `buildNativeReviewTarget(target)` mapping the resolved scope to the wire shape
(`uncommittedChanges` / `baseBranch`). Pure functions over `git` subprocess calls.

### Extended: `lib/protocol.mjs`

- `METHODS.REVIEW_START = 'review/start'`
- `buildReviewStart({threadId, target})` — validates target shape (one of the two
  literal type strings; `baseBranch` requires a non-empty `branch`), returns params.
  No effort/model fields: a review turn inherits config.toml by design, matching the
  companion's behavior byte-for-byte.

### Extended: `lib/daemon.mjs` + `lib/verbs.mjs`

- verbs: `review` verb, flags `--base <ref>`, `--scope <auto|working-tree|branch>`
  → `{cmd:'review', base, scope}`.
- daemon: `case 'review'` → `_startReview({base, scope})`: the DAEMON resolves the
  scope via git-scope against its `cwd` (single source of truth — this keeps the
  standalone daemon-fallback path fully working without the one-shot script), sends
  `buildReviewStart` on the current thread, tracks the returned `reviewThreadId`
  alongside the source thread, and returns the resolved scope label in the command
  response so callers can echo it.
- notification capture: on `item/completed` with `item.type === 'exitedReviewMode'`,
  store `item.review` as the turn's result text. `read` then returns it exactly like
  any completed turn output. (Today the daemon captures agent-message and plan
  deltas only; review text arrives ONLY via this item — without this capture a
  completed review reads back empty.)

### New: `scripts/commit-review-round.mjs` (~120 lines)

One-shot driver mirroring `review-round.mjs`'s ephemeral pattern:

1. Pre-validate FIRST, before any daemon boots: flags parse, `--scope` value is
   known, cwd is a git repo (cheap `git rev-parse` — fail-loud, usage message,
   exit 1). Authoritative scope resolution still happens in the daemon.
2. Private-socket daemon in a temp dir (never the shared ~/.codex-drive session).
3. Send `review`, bounded wait (same `WAIT_TIMEOUT_MS = 540000`), auto-decline any
   approval (a review is read-only), auto-answer any clarifying question with its
   first option.
4. Print the review text RAW and in full, then a deterministic trailer:
   - `STATUS: completed | timeout | failed`
   - `SCOPE: <label>` (from the daemon's review response, e.g. `working tree
     diff`, `branch diff against <ref>`)
   No verdict line: the companion never parsed the native review text either
   (renderNativeReviewResult dumps it raw), and the Stage-2 zero-issues decision is
   made by Claude reading the findings under receiving-code-review — unchanged.
   Free-text verdict parsing would be new surface for false passes.
5. Exit non-zero on timeout/failed after interrupting the turn; daemon teardown in
   `finally`. An empty review text on a completed turn prints `STATUS: failed` —
   fail-closed, never presentable as a clean review.

### Long-review fallback (no detached worker)

The one-shot script is bounded at ~9 min. Reviews are usually inside that; a large
branch-scope review has taken ~15.5 min. The fallback is the already-proven daemon
choreography (the same recipe used for slow plan turns):

```
codex-drive start --cwd <repo> → review [--base <sha>] →
repeated wait --timeout-ms … (each its own Bash call) → read --out <file> → stop
```

This replaces the companion's `--background` detached worker and its `status` /
`result` / `cancel` job-control layer entirely. `interrupt` + `stop` replace
`cancel`.

## CLAUDE.md gate changes (boomi-mcp-server)

- Stage-2 first review (CLAUDE.md runs outside plugin context, so no
  `${CLAUDE_PLUGIN_ROOT}`; resolve via the cache, mirroring the current find
  pattern):

  ```bash
  node "$(find ~/.claude/plugins/cache -path '*/codex-claude/*/scripts/commit-review-round.mjs' | sort | tail -1)"
  ```

  (`sort | tail -1` picks the highest version if two cache versions coexist.)
  Fix-scope re-reviews: `--base <last-reviewed-sha>` (unchanged scoping rule).
- Failure recovery: interrupt/stop + one clean re-invocation (unchanged policy), with
  the daemon-verbs fallback documented for >9-min reviews.
- Remove: the `find …codex-companion.mjs` invocations, `--wait`/`--background`
  prose, `/codex:status` / `/codex:result` references, and the cancel command.

## Effort/model policy (same release)

- `ultra` → `max` at every explicit call site: `agents/codex-architect.md:38`,
  `commands/codex-architect.md:26`, `skills/codex-claude/SKILL.md:90` and the
  §effort advice at SKILL.md:219-220 (advice becomes: use `max` for hard problems;
  `ultra` adds delegation and can blow the 540 s driver cap).
- Round-script defaults `'ultra'` → `'max'` (plan-round.mjs:23, review-round.mjs:19).
- `~/.codex/config.toml`: `model_reasoning_effort = "ultra"` → `"max"` — this is
  what the new review verb inherits. Model stays `gpt-5.6-sol` (verified latest).
- `lib/protocol.mjs` EFFORTS list keeps both `max` and `ultra` (deliberate opt-in to
  ultra stays possible; the pinned test at test/protocol.test.mjs:16 already expects
  the 8-value list).

## Decommission (after the gate is proven live)

1. Repoint boomi-mcp-server CLAUDE.md (above) and verify one real Stage-2 pass.
2. Uninstall the openai-codex plugin (removes /codex:rescue, task, transfer,
   adversarial-review — all confirmed unused).
3. Memory notes: retire `codex-companion-review-background-patched` and
   `codex-companion-review-generation-hang`; update
   `codex-drive-daemon-verbs-timeout-workaround` (effort is now max; recipe gains
   the review verb).
4. Propagation reminder: the runtime copy is the plugin CACHE
   (`~/.claude/plugins/cache/renera-ai-tools/codex-claude/<version>`), refreshed
   from GitHub via the marketplace clone — source edits require commit → push →
   plugin update; `installed_plugins.json` SHAs are not trustworthy for drift checks.

## Error handling

| Condition | Behavior |
| --- | --- |
| Not a git repo / unknown scope / empty `--base` | Throw in the script before daemon boot; usage message; exit 1 |
| Approval requested mid-review | Auto-decline (read-only doctrine), review continues |
| Wait cap expires | `interrupt` the turn, `STATUS: timeout`, non-zero exit |
| Turn completes with no `exitedReviewMode` text | `STATUS: failed`, non-zero exit — fail-closed, never presentable as a clean review |
| Daemon boot/socket failure | Surface stderr, non-zero exit, temp dir cleanup |

## Testing

- Unit (node --test, alongside the existing suite):
  - git-scope: dirty/clean tree, explicit base, explicit scopes, SHA base, detached
    HEAD, non-repo → error (temp-dir git fixtures)
  - protocol: `buildReviewStart` happy/invalid target shapes
  - daemon: `review` dispatch and `exitedReviewMode` capture against
    `test/fixtures/mock-appserver.mjs` (extend the mock to emit the review item)
  - verbs: `review --base x` / `--scope working-tree` parse table
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
