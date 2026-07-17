# Native commit review in codex-claude (absorb the openai-codex review gate)

**Date:** 2026-07-16 (rev 5)
**Status:** approved design, implementation in progress
**Decision owner:** Gleb

**Revision history.** rev 1-4: three Codex architect review rounds (R1: REWORK/11;
R2: 6 closed, 5 partial, 3 new; R3: R2-news closed, 6 partial, 5 new). **rev 5**
folds in (a) a 10-agent read-only recon — 5 investigators + 5 adversarial verifiers —
which confirmed **23 defects** in rev 4; (b) a Codex architect decision review
(**CHANGES RECOMMENDED**); and (c) **live protocol qualification against the installed
codex-cli 0.144.5** (`review/start` + `turn/start` probes, 2026-07-16). Where those
three disagreed, the live probe won. Sections corrected in rev 5 are marked **[rev 5]**.

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

**[rev 5]** The boomi Stage-2 gate is the only consumer of the companion's REVIEW pipeline
apart from the personal `/cr` command (`~/.claude/commands/cr.md`). `rescue`, `task`,
`transfer` and `adversarial-review` are genuinely unused — verified with `/usr/bin/grep`
across every command, hook, agent and settings file. But the companion is also coupled to
three machine-config artifacts the earlier revs never mentioned (`/cr`, the Stage-2
enforcement hook, and a session-cleanup hook registered in `settings.json`); see Decommission.

## Decision

Absorb git-scoped commit review into codex-claude as a first-class verb driving the
native `review/start` method, repoint the boomi-mcp-server CLAUDE.md gate at it, then
uninstall the openai-codex plugin. Unused companion features are dropped, not ported.

## Verified protocol contract **[rev 5 — live-qualified]**

Established 2026-07-16 by **live probes against the installed codex-cli 0.144.5**
(`scripts`-free harness driving this repo's own `lib/appserver.mjs`; see the probe
findings archived with this rev), corroborated by the companion's working
implementation (codex-companion.mjs, lib/codex.mjs, lib/git.mjs) and by `strings` on
the shipped binary. **Live observation overrides both of the others.**

- Request: `review/start` with params `{threadId, delivery: "inline", target}`.
  Response is `{turn: {id, …}, reviewThreadId}`.
- The companion runs reviews on a thread started with
  `{cwd, sandbox: "read-only", approvalPolicy: "never", ephemeral: true}`. We
  reproduce these four fields. **[rev 5]** We deliberately do NOT reproduce the two
  other fields `buildThreadParams` sends (companion lib/codex.mjs:63): `model` (redundant
  — `review/start` takes no model) and `serviceName: "claude_code_codex_plugin"`
  (server-side attribution that is not ours to claim). Earlier revs called this
  "byte-for-byte"; it is not, deliberately.
- **[rev 5] The full `ReviewTarget` enum has FOUR variants**, not two (binary docstrings,
  0.144.5). This design uses the first two; the other two are recorded so the omission
  is a decision, not an oversight:
  - `{type: "uncommittedChanges"}` — "Review the working tree: staged, unstaged, and
    untracked files." (**untracked ARE included** — this is what makes the `auto`
    dirty-rule sound.)
  - `{type: "baseBranch", branch: <ref>}` — "Review changes between the current branch
    and the given base branch."
  - `{type: "commit", sha, title?}` — "Review the changes introduced by a specific
    commit." NOT a substitute for `--base`: it reviews ONE commit's diff, not the delta
    since that commit.
  - `{type: "custom", instructions}` — "Arbitrary instructions provided by the user."
- **[rev 5] `<ref>` may be a commit SHA — LIVE-QUALIFIED, no longer an assumption.**
  Probe: `{type:"baseBranch", branch:"5a04a9c"}` was accepted on 0.144.5 and the reviewer
  ran `git diff <resolved-full-sha>`. Independently corroborated by a completed companion
  job (`baseRef: "874bad7"` → `git diff 874bad72350bbb32ec44742fa30d081cd8c13f57`, exit 0).
  Rev 4 asserted this as "verified contract" on no evidence; it happens to be true. The
  `--base <sha>` fix-scope re-review rides this variant. Note the diff is
  **worktree-inclusive** (`git diff <sha>`, not `<sha>..HEAD`): it reviews commits **plus**
  the current working tree.
- Result delivery: `item/completed` with `{type: "exitedReviewMode", review: "<text>"}`,
  then `turn/completed`. **[rev 5]** A paired `{type: "enteredReviewMode"}` item fires
  early in the turn — harmless, but real; we key strictly on `exitedReviewMode`.
  No effort field exists on `review/start`; the review inherits the effective Codex config
  (`CODEX_HOME/config.toml`).
- **[rev 5] `reviewThreadId == source thread id` for `delivery:"inline"` — live-confirmed**
  (was schema-confirmed in rev 3). The daemon still validates at runtime as
  defense-in-depth: a differing `reviewThreadId` fails the turn loud. No second-thread
  listening or persistence anywhere.

### **[rev 5] Turn identity: the response is authoritative, `turn/started` is not**

The single most consequential live finding. Probed ids:

| | `turn/start` | `review/start` |
| --- | --- | --- |
| response `turn.id` | `…3f17` | `…17c5` |
| `turn/started` id | `…3f17` | `…1814` — **differs** |
| `turn/completed` id | `…3f17` | `…17c5` — matches the response |
| `item/completed` `turnId` | `…3f17` | `…17c5` — matches the response |

For a review, `turn/started` announces an id that nothing else uses. The daemon adopts
that id today (daemon.mjs:225-227), which would make `_isStaleTurn` (:211) drop both
`exitedReviewMode` and `turn/completed` — **hanging `wait` on every review**.

**Rule: `turn.id` is adopted from the RESPONSE, for every turn kind; never from
`turn/started`.** Both `turn/start` and `review/start` return `{turn:{id,…}}`, and in both
cases the response id is the one the notifications carry. This is exactly what the
buffer-until-response design (below) requires, so the two converge.

Corollaries:
- **No "fail loud on id disagreement" rule.** Live ids legitimately disagree; such a rule
  would fail every review. (Rev 4's :164 "capture `response.turn.id`" was right by accident;
  its adoption ordering was wrong.)
- `TurnStartResponse` is **`{turn:{id,…}}`**, NOT `{turnId}`. (A `strings`-derived claim to
  the contrary was refuted by probe.)
- `TurnStartedNotification` is `{threadId, turn:{id}}`, not `{threadId, turnId}`.
- **`item/completed` ALWAYS carries `turnId` and `threadId`** — 0 omissions across every
  probe. daemon.mjs:236's comment ("item/completed often omits turnId") is unsupported; the
  lenient guard stays (harmless), but nothing may be built on that leniency.

### **[rev 5] The reviewer runs commands; approvals never arrive**

Live: many `item/completed{commandExecution}` items per review, and **zero server requests**
under `approvalPolicy:"never"` + `sandbox:"read-only"`. So rev 4's rationale — "a native
review never legitimately needs a command" — is **false**. It needs them constantly; they
simply do not prompt. Deny-on-approval is retained as belt-and-braces, but an approval
actually arriving means the thread profile is wrong, and is not routine.

### Models and effort

Current live models (`model/list`, 2026-07-16): gpt-5.6-sol (default, frontier),
gpt-5.6-terra, gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark.
Sol/Terra efforts: low, medium, high, xhigh, max, ultra. `max` = maximum reasoning depth;
`ultra` = max reasoning **plus automatic task delegation** (slower; blows the 540 s
round-script wait cap — the documented plan-timeout root cause).

**[rev 5] Effort dominates review duration**, measured on the same review: **36 s at `low`**
vs **>560 s (never completed) at `max`** — two separate `max` runs blew 300 s and 560 s. The
540 s cap is genuinely tight at `max`, so the fallback below is mandatory, not optional.
Protocol shapes are effort-independent (qualification was done at `low`).

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

### New: `lib/git-scope.mjs` (~150 lines) **[rev 5]**

Port of the companion's `resolveReviewTarget` semantics (lib/git.mjs:135-191), zero-dep,
sync, `spawnSync` with an **argv array and `shell:false`** (never a shell string), with
STRICT input validation (the daemon is the authoritative validator — the CLI parser
turns a valueless `--base` into boolean `true` and preserves empty strings, so
truthiness is not safe):

- `base`, when present, MUST be a non-blank string → `{mode:'branch', baseRef}`;
  boolean/empty/whitespace `base` → error, never a silent scope fallback.
- `scope`, when present, MUST be one of `auto | working-tree | branch` → as named;
  anything else → error.
- `base` and `scope` are **mutually exclusive** → error when both are given
  (deterministic; no precedence rule to remember).
- **[rev 5] ref existence** — the resolved baseRef (explicit OR detected) MUST satisfy
  `git rev-parse --verify --quiet --end-of-options <ref>^{commit}` (status 0), else error.
  Without this a typo'd `--base` — the flag the Stage-2 gate uses most — passes every other
  rule and fails only after a daemon boot and a full Codex turn, surfacing as a blank review.
- **[rev 5] ancestry + non-empty delta** — `git merge-base --is-ancestor <base> HEAD`, and the
  resulting diff MUST be non-empty. **A base equal to HEAD otherwise reviews nothing and
  returns clean** — a silent false pass on the gate whose whole job is catching problems.
  Fail closed; never silently fall back to `auto`.
- **[rev 5]** Resolve the supplied base to a **full immutable SHA** before it goes on the wire.
- default (`auto`) → working-tree if the tree is dirty (staged, unstaged, or untracked
  present — `--untracked-files=normal` passed explicitly, since a repo-local
  `status.showUntrackedFiles=no` otherwise reports a dirty tree as clean), else branch vs
  detected default branch.
- outside a git repo → error. **[rev 5] Detached HEAD is NOT an error** — it resolves
  normally (working-tree if dirty, else branch vs detected default; the reviewer's merge base
  is computed against HEAD, which is valid detached).

**[rev 5] Env scrub — required, not hygiene.** The "one coherent cwd" invariant below is
defeatable by the inherited environment. Live-reproduced: `GIT_DIR=<other>/.git git rev-parse
--show-toplevel` from `/tmp` reports `/private/tmp` (a non-repo reported as a repo root); and
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=INJECTED git config user.name`
→ `INJECTED`, so an argv array and `shell:false` are NOT sufficient against an env-borne
attacker. Delete the codex binary's own list — `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
`GIT_CEILING_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_CONFIG`, `GIT_CONFIG_PARAMETERS`, `GIT_DIR`,
`GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_GRAFT_FILE`, `GIT_IMPLICIT_WORK_TREE`, `GIT_INDEX_FILE`,
`GIT_NAMESPACE`, `GIT_OBJECT_DIRECTORY`, `GIT_PREFIX`, `GIT_REPLACE_REF_BASE`, `GIT_WORK_TREE` —
**plus** a prefix sweep deleting every `GIT_CONFIG_*` key (a fixed list cannot cover
`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`), and set `GIT_OPTIONAL_LOCKS=0`.

`detectDefaultBranch` keeps the companion's preference order: `origin/HEAD` symbolic-ref →
local `refs/heads/{main,master,trunk}` → `refs/remotes/origin/*` last. **[rev 5] Known
unresolved edge, recorded rather than papered over:** a detected `origin/<c>` resolves locally
yet `git rev-parse --abbrev-ref "origin/main@{upstream}"` → fatal, so if the reviewer's
`@{upstream}` template is ever selected, an `origin/<c>` base fails server-side. Ref-existence
does NOT close this. Not hit by the gate (which passes `--base <sha>`).

Plus `buildNativeReviewTarget(target)` mapping the resolved scope to the wire shape
(`uncommittedChanges` / `baseBranch`). **[rev 5]** It **throws** on the two unimplemented
variants — the companion returns `null` (its :268), which we deliberately do not copy.

### Extended: `lib/protocol.mjs`

- `METHODS.REVIEW_START = 'review/start'`
- `buildReviewStart({threadId, target})` — validates target shape (one of the two
  literal type strings we implement; `baseBranch` requires a non-empty string `branch`),
  returns params. No effort/model fields: a review turn inherits the effective config by
  design, matching the companion's behavior here. **[rev 5]** ("byte-for-byte" was
  overstated — see the thread-profile note above: we deliberately omit `model` and
  `serviceName`.)

### Extended: `lib/daemon.mjs` + `lib/verbs.mjs` + `bin/codex-drive.mjs`

- verbs: `review` verb, flags `--base <ref>`, `--scope <auto|working-tree|branch>`
  → `{cmd:'review', base, scope}` (validation happens in the daemon, above).
- `start` gains thread-profile flags, VALIDATED at parse/dispatch time (the flag
  parser turns a valueless flag into boolean `true` — verbs.mjs:12 — so literal
  checks are mandatory):
  - `--sandbox <read-only|workspace-write|danger-full-access>` — any other value,
    or a valueless/boolean `--sandbox`, is an error;
  - `--ephemeral` (boolean) — REJECTED in combination with `--resume`/
    `--resume-latest` (resuming an ephemeral thread is contradictory; today the
    daemon silently prefers resume — daemon.mjs:32);
  - `--approval-policy <never|untrusted|on-request>` at thread level.
  These pass through to `thread/start` params (today it sends bare `{}`). On
  `thread/resume`, profile flags are an error — a resumed thread keeps its
  original profile; the spec defines no re-profiling.
- **Review thread profile, enforced:** a review session is
  `{cwd, sandbox:'read-only', approvalPolicy:'never', ephemeral:true}` — the
  companion's exact profile. The daemon RECORDS the profile it started with, and
  `cmd:'review'` REFUSES (`{error:'wrong_thread_profile'}`) on a session lacking
  it. No silent review on a resumed or general-purpose thread.
- **One coherent cwd (round-2 P1, scoped in round 3):** the daemon normalizes a
  single absolute `cwd` (constructor option) and uses it for ALL THREE: git-scope
  subprocess calls, the app-server child spawn (today the child just inherits
  process cwd — appserver.mjs:17), and `thread/start` params. `thread/resume`
  params stay `{threadId}`-only, exactly as today — resumed threads keep their
  original identity, and no review can run on one anyway (the profile rule makes
  review sessions start-only), so no resume-cwd matching machinery is needed.
  Tested with caller cwd deliberately different from review cwd.
- **Profile survives the detached handoff (round-3 new 1):** the parent CLI
  re-spawns the real daemon as `__daemon` with a serialized payload that today
  carries only `{socketPath, resume, model}` (codex-drive.mjs:101). The payload
  gains the validated profile object `{cwd, sandbox, approvalPolicy, ephemeral}`,
  passed into the `Daemon` constructor by the `__daemon` branch — otherwise the
  detached fallback daemon would record no profile and every `review` would be
  refused `wrong_thread_profile`. The detached CLI path is tested end-to-end.
- daemon: `case 'review'` → `_startReview({base, scope})`, mirroring `_startTurn`'s
  established lifecycle (daemon.mjs:94-120):
  - busy guard first (`running`/`awaiting_input` → `{error:'busy'}`);
  - resolve + validate scope via git-scope against the daemon `cwd`; validation
    error → returned synchronously, turn state untouched;
  - reset per-turn state BEFORE the RPC, with a new turn kind:
    `isReview: true`, and a new authoritative `reviewText: null` field;
  - **do not await** `review/start`. Rev 4 justified this only by the stdout-burst
    race; **[rev 5]** the stronger reason: awaiting is not even a fix (see below), and
    it would withhold the command response while `sendCommand` has no default
    timeout (client.mjs:3). Return `{ok, scope: <label>}` immediately.

#### **[rev 5] Turn lifecycle: buffer-until-response (ALL turn kinds)**

Rev 4 specified a review-only "completion barrier". Rev 5 replaces it with the
companion's proven ordering (its lib/codex.mjs:559-568, :585, :591-599), applied to
`plan`/`send`/`review` alike. Three findings forced the change:

1. **The race is real, and it is NOT review-only.** Reproduced against the real
   `Daemon`: `wait` returned `{"status":"completed","message":"REVIEW TEXT"}` while the
   turn's true status was `failed`. `_startTurn` resets `turn.id = null` (:115), discards
   the response (:119), and `_isStaleTurn` (:210) accepts ANY notification while the id is
   unknown — so a stale same-thread completion can prematurely finalize a fresh
   `plan`/`send` turn today. A review-only barrier knowingly leaves that live. The mock's
   20 ms delay (mock-appserver.mjs:27) is what has been hiding it.
2. **`turn.id` must come from the response** (see the protocol contract above). For a
   review, `turn/started`'s id differs from the id every other message carries, so today's
   :225-227 adoption would hang `wait` on every review.
3. **Awaiting the response is not an alternative.** `JsonRpc.feed()` (:42) drains a whole
   chunk synchronously while a resolved response only schedules a microtask, so later
   notifications in the same chunk still run first. Awaiting is safe only *after* buffering
   — i.e. the buffer design plus a pointless blocking start.

The rule:

- Install the buffer BEFORE the RPC: while `turn.id` is null, every inbound notification is
  **buffered, not handled**.
- On the response: validate (review → `reviewThreadId === this.threadId`, else fail the turn
  loud), set `turn.id = response.turn.id`, then **replay** the buffer through the normal
  stale filter.
- `turn/started` becomes informational; it is **never** a source of `turn.id`. **No
  "fail loud on id disagreement" rule** — live ids legitimately disagree.
- **Per-start generation token** on both response arms, plus the `:122`-style status guard on
  the rejection arm: a late response from a superseded turn is logged and dropped, never
  mutates current state.
- **[rev 5] Daemon-owned backstop timer.** Rev 4 said deferral is "bounded by the same wait
  cap"; **there is no such cap** — `_wait` (:132-138) parks a bare resolver with no timer, and
  every cap in this stack is client-side (client.mjs:8, bin/codex-drive.mjs:49-55), whose
  expiry does not change daemon state. (Codex's own review of rev 4 raised this independently
  as [P2].) Instead: a ~5 s `unref()`'d timer, armed ONLY when a **successful**
  `turn/completed` arrives while the response is still outstanding — never at RPC start. On
  expiry: invalidate the generation, clear pending state, mark `failed`, resolve waiters,
  ignore any late response, and **never release the buffered review as completed**. No
  interrupt is needed — a terminal completion was already observed. Cleared on response
  arrival, `_onAppExit`, turn reset, and `stop()`. Transport death is already bounded
  (appserver.mjs:23-26 rejects-all before `emit('exit')`, plus the :122/:261 status guards),
  so this is a liveness backstop only and should essentially never fire. **The two timeouts
  are distinct concepts and must stay that way**: the ~5 s response-ordering backstop vs the
  540 s client wait cap.
- Only a **successful** `turn/completed` waits on the response. `interrupted`/`failed`
  finalize immediately — they are already fail-closed, and nothing needs validating on a turn
  that is not being presented as a clean review. This is what keeps the documented
  timeout→interrupt→`STATUS: failed` path from deadlocking, since `_interrupt` (:202-206)
  writes no status and depends entirely on :244.
- notification capture: on `item/completed` with `item.type === 'exitedReviewMode'`,
  store `item.review` into `turn.reviewText` (NOT `turn.message` — the
  `turn/completed` handler unconditionally rebuilds `turn.message` from the
  plan/agent buffers at daemon.mjs:240-252 and would clobber it). **[rev 5]** The paired
  `enteredReviewMode` item is ignored. Finalization precedence in `turn/completed`: review
  turn → `reviewText`; plan turn → plan text; else agent-message buffer. A review turn that
  completes with blank `reviewText` finalizes as `failed`, not `completed`-with-empty.
- staleness filtering, applied to the inbound paths (round-2 partial 4):
  - notifications: extend `_isStaleTurn` to also reject a `threadId` that is not
    the session thread (today only `turnId` is compared — daemon.mjs:208; the
    AppServer forwards ALL notifications unfiltered). **[rev 5]** Keep it **lenient**
    (`this.threadId && threadId && threadId !== this.threadId`), mirroring the existing
    `turnId` guard — a strict form drops real traffic.
  - **[rev 5]** `turn/started` adoption is **removed**, not merely filtered (above).
  - server requests: `_onServerRequest` parks unconditionally today
    (daemon.mjs:269-274). Filtering applies BOTH axes (round-3, R1-4): a request
    carrying a foreign `threadId` OR a stale `turnId` is never parked. Every such
    request still gets a response — leaving a JSON-RPC request unanswered
    violates the request/response contract and can wedge the originating turn
    (round-3 new 3): supported approval shapes are answered with their deny
    shape; everything else is answered with a deterministic JSON-RPC error via a
    new `AppServer.respondError` passthrough (`JsonRpc.respondError` already
    exists — jsonrpc.mjs:32 — AppServer just doesn't expose it today,
    appserver.mjs:45).

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
   which boots before its try — boot failure must still hit cleanup), with the
   full review thread profile `{cwd: <repo>, sandbox: 'read-only',
   approvalPolicy: 'never', ephemeral: true}` and a temp-dir socket.
3. Send `review`, then bounded wait (`WAIT_TIMEOUT_MS = 540000`), driving parked
   states:
   - clarifying question → answer with its first option (drain-guarded);
   - command/file/legacy approval → **deny** (no safe-command allowlist — unlike
     review-round.mjs:73). **[rev 5]** Rev 4's rationale ("a native review never
     legitimately needs a command") is **false**: live reviews emit constant
     `item/completed{commandExecution}` items. They simply never prompt under
     `approvalPolicy:'never'` + `sandbox:'read-only'` — zero server requests were
     observed across every probe. Deny is retained as belt-and-braces; an approval
     actually arriving means the thread profile is wrong, and is not routine.
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
7. **Offline testability (round-2 partial 9; grammar + guard from round-3 new
   5):** the script constructs its Daemon with app-server options overridable via
   `CODEX_DRIVE_TEST_APPSERVER` — value is a JSON string array
   `["command", ...args]` (never whitespace-split, never shell-parsed; parse
   failure = hard error). It is honored ONLY when `CODEX_DRIVE_TEST_MODE=1` is
   also set; outside test mode the variable is rejected loudly (guards against
   an ambient env collision silently substituting the review backend). Same
   injection seam the Daemon constructor already exposes to unit tests
   (appserver.mjs takes separate command + args). Test-only, undocumented in
   user-facing help. **[rev 5]** Entries MUST be **absolute paths**: the daemon spawns
   the app-server child with the review `cwd` (a temp-dir git fixture under test), so a
   relative command silently fails to spawn. The identical gated pair MUST also be
   honored by `bin/codex-drive.mjs`'s `__daemon` branch — otherwise the detached-CLI
   tests below cannot run offline at all (env is inherited: the detached spawn passes no
   `env` option, so no payload change is needed). Factor parse+guard into ONE shared
   helper so the script and the CLI cannot drift.
8. **[rev 5] `CODEX_DRIVE_TEST_WAIT_MS`** — same `CODEX_DRIVE_TEST_MODE=1` gating, same
   loud rejection — overrides `WAIT_TIMEOUT_MS`. Without it the wait-cap row in the error
   table is only reachable by blocking ~9 minutes (the cap is a hardcoded client-side
   constant; no mock behavior can shorten it), and the Testing section's "ALL paths" claim
   is false.

### Long-review fallback (no detached worker)

Empirically required (see contract section). Two rules the first draft got wrong,
now explicit:

- **After a one-shot failure, NEVER touch the shared `codex-drive` session.** The
  one-shot's daemon is private and self-cleaning (interrupt + teardown are
  internal). The global CLI verbs consult `~/.codex-drive/state.json`
  (state.mjs:6, codex-drive.mjs:32) and would interrupt an UNRELATED session.
  Recovery from a one-shot failure is: retry the one-shot once; if it times out
  again, switch to the fallback below.
- The fallback runs on an explicitly OWNED session, and ownership is now
  ENFORCEABLE (round-2 partial 6): every non-start CLI verb gains a
  `--socket <path>` override that connects directly to the given daemon socket,
  bypassing the single mutable `~/.codex-drive/state.json` (state.mjs:6). The
  recipe captures the socket from `start`'s JSON output and passes it to every
  subsequent call — a concurrent `start` by another process can no longer
  redirect this session's `wait`/`read`/`stop`. Because `--socket` bypasses
  `state.json`, it also bypasses `state.cwd`, which is what a relative
  `read --out` resolves against today (codex-drive.mjs:61) — so (round-3 new 2)
  the daemon's `status` and `read` responses now include the daemon's `cwd`, and
  the CLI resolves a relative `--out` against the SOCKET-selected daemon's
  reported cwd, never against absent/foreign global state. Refuse to proceed if
  a live foreign session must be disturbed — never force-stop it:

**[rev 5] `start` itself must be state-free too.** Rev 4 gave `--socket` to every NON-start
verb, but the fallback's own `start` still (a) refuses outright whenever ANY foreign session
is live (codex-drive.mjs:84-86) — making the documented recovery path unavailable exactly
when it is needed, a dead end under boomi-mcp-server's "Never close on a missing step" rule —
and (b) unconditionally rewrites `~/.codex-drive/state.json` (:111), contradicting this
section's own "NEVER touch the shared session". So `start` gains a **`--private`** mode that
skips `store.writeState` AND skips the existing-session probe entirely, printing its socket
for the caller to pass on. `start --force` is never the answer.

```
S=$(node <cache>/bin/codex-drive.mjs start --private --cwd <repo> \
      --sandbox read-only --ephemeral --approval-policy never | jq -r .socket)
node <cache>/bin/codex-drive.mjs review [--base <sha>] --socket "$S"
# repeat (each its own shell call):
node <cache>/bin/codex-drive.mjs wait --timeout-ms 540000 --socket "$S"
#   → completed: proceed to read
#   → timeout (CLI exit 2): loop again
#   → question/approval parked: answer first option / deny via `answer`/`approve`
#     (--socket "$S"), then loop; unsupported/malformed park: interrupt, failed
#   → failed/unsupported: stop, surface the failure
node <cache>/bin/codex-drive.mjs read --out <file> --socket "$S"   # non-empty
node <cache>/bin/codex-drive.mjs stop --socket "$S"                # always
```

`<cache>` = the resolved plugin cache dir (below). `codex-drive` is NOT on PATH;
the bare name in earlier drafts was not executable. **[rev 5]** `--full` is dropped from the
recipe: `verbs.mjs:37` maps the flag but nothing in `lib/` ever reads `cmd.full` —
`_completedResult` returns the whole message unconditionally — so the recipe must not depend
on a no-op.

**[rev 5] Known gap, stated rather than inherited silently:** this fallback has **zero**
Stage-2 step-7 enforcement. It ends in `read --out`, which prints a single JSON line (no
`^SCOPE: ` line), and the subsequent `Read` of the file is excluded by the enforcement hook's
`tool_name == "Bash"` guard. Fix the fallback's final output to conform to the same terminal
contract as the one-shot rather than documenting the hole.

This replaces the companion's `--background` detached worker and its `status` /
`result` / `cancel` job-control layer entirely.

## Gate changes (boomi-mcp-server **CLAUDE.md AND AGENTS.md**) **[rev 5]**

**[rev 5] Both gate files are gitignored and untracked** (`.gitignore:91` `CLAUDE.md`,
`:92` `/AGENTS.md`; `git ls-files` → empty). The cutover edit therefore has no commit
boundary, cannot be diff-reviewed, has no git rollback, and the repo's own Stage-1.5 baseline
rule cannot cover it. **Back both up outside the repo before editing**; the single live
Stage-2 pass is the only available verification. Corollary: a leftover-reference sweep must
use `/usr/bin/grep` — the interactive `grep` here is a shell function wrapping
`ugrep --ignore-files`, which respects `.gitignore` and silently SKIPS both gate files (`rg`
too).

**[rev 5] AGENTS.md is a second, unmentioned gate.** It mirrors CLAUDE.md byte-for-byte over
lines 1-58 and carries the same Stage-2 block at `:22-38` and `:49-50`. It must get the
identical rewrite. Note its `~/.Codex/plugins/marketplaces` path is a case-insensitive alias
of `~/.codex` (the Codex CLI home), which has no `plugins/` subtree — so **AGENTS.md's gate
has always failed silently**. Standardize on `~/.claude/`.

**[rev 5] Sequence the hook FIRST, then the gate** (it breaks on the contract change, not on
the uninstall) — see the enforcement-hook subsection below.

- Resolve the runtime script once per session, version-aware (`sort -V`, not
  lexical `sort`, which mis-orders 1.10 vs 1.9) and FAIL-CLOSED in two steps —
  the dir must resolve non-empty BEFORE the script path is built, otherwise an
  empty `ls` would yield a relative path that `-f` could match against an
  unrelated cwd-local file (round-2 new finding 2):

  ```bash
  CACHE_DIR="$(ls -d ~/.claude/plugins/cache/renera-ai-tools/codex-claude/*/ 2>/dev/null \
              | sort -V | tail -1)"
  [ -n "$CACHE_DIR" ] && [ -d "$CACHE_DIR" ] \
    || { echo "codex-claude cache copy not found" >&2; exit 1; }
  CRR="${CACHE_DIR}scripts/commit-review-round.mjs"
  [ -f "$CRR" ] || { echo "commit-review-round.mjs missing in $CACHE_DIR" >&2; exit 1; }
  ```

- **[rev 5] Stage-2 first review: `node "$CRR" --base <recorded-baseline>` — NOT auto scope.**
  Rev 4 said "auto". But CLAUDE.md:18 (Stage 1.5) REQUIRES committing the QA-clean tree
  **before** Codex runs, so the tree is always CLEAN at first-review time and the `auto` rule
  therefore ALWAYS takes the branch-vs-detected-default path. Live in the consumer repo:
  boomi-mcp-server on `dev`, `git status --porcelain` empty, `origin/HEAD` → `main`,
  `git rev-list --count main..dev` = **19**. Auto would ship a 19-commit review of
  already-merged work — precisely the "every Codex review re-scans the entire feature instead
  of the latest fix" failure CLAUDE.md:18 exists to prevent, and a direct contradiction of
  CLAUDE.md:18's own "the first Codex review runs `--base <last-commit-before-this-work>`".
  This is the gate's default path on every task, not a corner case. (Companion parity: its
  auto rule is identical at git.mjs:176-190, so the pre-existing gate likely has this bug
  too — the cutover is the moment to fix it.)
- **[rev 5] Record the baseline BEFORE the work starts.** CLAUDE.md names
  "last-commit-before-this-work" but nothing ever captures it — :30 records HEAD only when the
  review *starts*, so at gate time the model would infer it from history. A base equal to HEAD
  yields an EMPTY diff and a clean review: **a silent false pass on the gate whose entire job
  is catching problems.** Stage 1 therefore records `BASELINE=$(git rev-parse HEAD)` before
  implementation begins, and git-scope enforces existence + strict ancestry + non-empty delta
  (above). Missing or unknown baseline → **fail the gate**; never guess, never fall back to
  `auto`.
- Fix-scope re-reviews: `node "$CRR" --base <last-reviewed-sha>` (unchanged scoping rule).
  **[rev 5]** Reword CLAUDE.md:50's "reviews only commits added since the previous review" →
  "reviews the delta since `<sha>` (commits **plus** the current working tree)": the reviewer
  runs `git diff <sha>`, which is worktree-inclusive.
- Failure recovery: retry the one-shot once; second failure → the daemon-verbs
  fallback above (never the shared-session interrupt/stop of earlier drafts).
- Remove: the `find …codex-companion.mjs` invocations, `--wait`/`--background`
  prose, `/codex:status` / `/codex:result` references, and the cancel command.
- **[rev 5] Delete the "or pipe to `tail`" advice (CLAUDE.md:28).** `tail` truncates from the
  front, so it discards both the review's findings and the enforcement marker. It is
  incompatible with review consumption AND enforcement.

### **[rev 5] The Stage-2 enforcement hook must be repointed — it fails SILENTLY otherwise**

`~/.claude/hooks/enforce-receiving-code-review.sh` is what actually enforces Stage-2 step 7
(invoke `receiving-code-review` before reading findings). Its trigger at `:24` is
`grep -q '^# Codex Review'` — **wrapper text the companion emits and the new contract
deliberately does not**. Verified empirically by feeding the real hook both payloads:
companion contract → exit 2 + reminder; new contract → **exit 0, silent**. An implementer
following rev 4 exactly would ship a gate that looks correct while step-7 enforcement is dead.

- Patch `:24` to accept both markers during the transition
  (`'^(# Codex Review|SCOPE: )'`), narrowing to `^SCOPE: ` after decommission.
- **The marker swap alone is NOT sufficient**: `:33` separately requires a `[P1-4]` finding
  marker. Identify the new path by the complete successful terminal contract
  (`STATUS: completed` **plus** `SCOPE:`), not the header alone.
- The hook's other predicates are safe — the clean-pass phrases (`:27-30`) and `[P1-4]`
  (`:33`) match MODEL text, not wrapper text.
- Refresh the stale `/codex:rescue` comment at `:9`.
- Silver lining: the trailer is strictly MORE robust than a header. Under the gate's own (now
  deleted) "pipe to `tail`" advice, `tail` drops a header — so the hook is arguably **already**
  defeated today, and a trailer survives `tail`.
- Sequence this with the **gate edit**, not the uninstall.

## Effort/model policy (same release)

- `ultra` → `max` at every explicit call site: `agents/codex-architect.md:38`,
  `commands/codex-architect.md:26`, `skills/codex-claude/SKILL.md:90`, the §effort
  advice at SKILL.md:219-220 (advice becomes: use `max` for hard problems; `ultra`
  adds delegation and can blow the 540 s driver cap), **and the CLI verb table at
  codex-claude/README.md:102** (missed in rev 1).
- Round-script defaults `'ultra'` → `'max'` (plan-round.mjs:23, review-round.mjs:19).
- Public verb tables gain the new `review` verb row (README.md §CLI table,
  SKILL.md §verbs ~:202), explicitly distinguished from the prompt-based `send`
  review, plus `--socket` on the non-start rows.
- **[rev 5]** Fix the stale Claude-subagent model pins while here:
  `agents/codex-architect.md:9` and `agents/codex-impl-reviewer.md:14` are still
  `claude-sonnet-4-6`.
- **[rev 5]** Two doc-drift fixes in the same tables: `--full` is documented nowhere yet the
  fallback recipe used it (it is a no-op — nothing reads `cmd.full`); and SKILL.md's `stop`
  row claims it removes "socket + state", but `Daemon.stop()` only unlinks the socket —
  `~/.codex-drive/state.json` survives as a stale record (which is why `start`'s liveness
  probe at bin:83 exists).
- **[rev 5]** Effort has a large, measured cost: the SAME review took **36 s at `low`** vs
  **>560 s (never completed) at `max`**. `max` is the right default for the architect, but the
  gate's 540 s cap is genuinely tight and the fallback is load-bearing.
- `model_reasoning_effort = "max"` in the **effective CODEX_HOME config** — i.e.
  `$CODEX_HOME/config.toml` when the gate runs with `CODEX_HOME` set, else
  `~/.codex/config.toml` (the spawned app-server inherits the environment —
  appserver.mjs; round-2 partial 11). This is a **deployment prerequisite, not a
  repo change** — the repo cannot ship a user-config edit (lib/config.mjs reads
  only the model). Checklist item in Decommission step 1, verified before the
  gate cutover. Model stays `gpt-5.6-sol` (verified latest).
- `lib/protocol.mjs` EFFORTS list keeps both `max` and `ultra` (deliberate opt-in to
  ultra stays possible; the pinned test at test/protocol.test.mjs:16 already expects
  the 8-value list).

## Release/versioning

- **[rev 5]** Bump the version 1.7.3 → 1.8.0 in **`.claude-plugin/marketplace.json`
  (entry `codex-claude`, line 35)** — this is the load-bearing bump: on this install that
  value ALONE names the cache dir `~/.claude/plugins/cache/renera-ai-tools/codex-claude/<version>`
  that the gate's `sort -V` resolver globs. Also update the version column in the root
  `README.md:27` (docs only).
- **[rev 5] `codex-claude/.claude-plugin/plugin.json` has NO `version` field** — rev 4 asked
  to "bump" one that does not exist (the file is name/description/author only, and
  `codex-claude/package.json` is `0.1.0`, not `1.7.3`). Prefer NOT adding one: it is a new,
  locally untested variable, and precedence when both marketplace and plugin carry a version
  is unverified (every local both-set plugin keeps them identical, so nothing disambiguates).
  If one is ever added it MUST be byte-identical to the marketplace value. Do not touch
  `package.json:3` or `bin/codex-drive.mjs:12` `CLIENT_INFO`.
- Propagation reminder: the runtime copy is the plugin CACHE
  (`~/.claude/plugins/cache/renera-ai-tools/codex-claude/<version>`), refreshed
  from GitHub via the marketplace clone — source edits require commit → push →
  plugin update; `installed_plugins.json` SHAs are not trustworthy for drift checks.
- **[rev 5]** The gate resolver and the LOADED plugin are decoupled: the gate globs the cache
  dir and takes `sort -V | tail -1`, independent of `installed_plugins.json`, and stale cache
  dirs are never pruned (1.6.0 is still present). A `1.8.0` cache dir can therefore be selected
  by the gate while Claude Code still loads 1.7.3's skills/commands. **Verify BOTH after
  `/plugin update`**, not just dir existence.
- **[rev 5]** `sort -V` was confirmed available on this macOS (Apple `sort` 2.3, which does
  support `--version-sort`), and lexical `sort` was confirmed to mis-order (`1.10.0` first).

## Decommission (after the gate is proven live) **[rev 5 — rescoped]**

**[rev 5]** Rev 4's step 3 was materially incomplete. The unused-VERB half of its claim is
true — `rescue`/`task`/`transfer`/`adversarial-review` have no invoker in any command, hook,
agent or settings file (verified with `/usr/bin/grep`). But **three machine-config artifacts
are coupled to the companion** and rev 4 handled none of them. Order matters:

1. Verify deployment prerequisites: effort=max in the EFFECTIVE CODEX_HOME config
   for the environment the gate runs in (`$CODEX_HOME/config.toml` if set, else
   `~/.codex/config.toml` — same rule as the policy section; it is currently `ultra` at
   `~/.codex/config.toml:2`); plugin update pulled; cache dir for the new version present
   AND `installed_plugins.json` moved.
2. **Patch the enforcement hook** (dual marker + terminal contract) — see the gate section.
   This is sequenced with the gate edit, BEFORE any uninstall.
3. Repoint boomi-mcp-server **CLAUDE.md AND AGENTS.md** (above), then verify one real Stage-2
   pass with BOTH the one-shot and the fallback enforcing step 7.
4. **`~/.claude/commands/cr.md:37,46`** — repoint at `commit-review-round.mjs`, or delete.
   It hardcodes the companion at the **1.0.4 CACHE** copy while the gate uses the **1.0.6
   MARKETPLACE** clone, and cache dirs are never pruned (1.0.4/1.0.5/1.0.6 all co-reside) —
   so `/cr` has been silently running a two-release-stale companion, and after uninstall may
   keep running an orphaned one rather than failing loudly. Fix deliberately.
5. Quiesce any in-flight companion jobs, then uninstall openai-codex **while its marketplace
   is still registered**.
6. **`~/.claude/settings.json`** — drop the cleanup-hook registration (`:9-19`), the
   `codex@openai-codex` entry (`:39`) and the marketplace (`:51-57`); delete
   `~/.claude/hooks/cleanup-codex-on-session-end.sh` **last** (removing it before old jobs are
   gone discards its process-tree safety net; if left, it degrades to a harmless no-op —
   cleanup, not a blocker).
7. **[rev 5]** Update the SEVEN files inside codex-claude that name `codex-companion … review`
   as the exemplar of "the repo's own gate", or they document a plugin that no longer exists:
   `commands/codex-issue.md:110`, `agents/codex-impl-reviewer.md:79`,
   `commands/codex-doctor.md:44`, `skills/codex-claude/SKILL.md:172`,
   `commands/codex-compose-setup.md:92`, `docs/WORKFLOW-MODE.md:127`.
8. Memory notes: retire `codex-companion-review-background-patched` and
   `codex-companion-review-generation-hang`; update
   `codex-drive-daemon-verbs-timeout-workaround` (effort now max; recipe gains the
   review verb and the owned-session rules).

## Error handling

| Condition | Behavior |
| --- | --- |
| Not a git repo / unknown scope / blank or boolean `--base` / `--base`+`--scope` combined | Script: usage + exit 1 before daemon boot. Daemon: synchronous error, turn state untouched |
| **[rev 5]** `--flag=value` form used (e.g. `--base=<sha>`) | Loud error in `parseArgs`, exit 1 — never a silent scope fallback |
| **[rev 5]** `--base` ref does not resolve | git-scope error before any daemon boot; exit 1 |
| **[rev 5]** `--base` is not a strict ancestor of HEAD, or the delta is empty | git-scope error; exit 1 — never a vacuous clean review |
| `review/start` rejected, or `reviewThreadId` ≠ session thread | Turn → `failed`, waiters resolved; script exits 2 |
| Command/file/legacy approval requested | Deny (belt-and-braces; **[rev 5]** live reviews never prompt under `approvalPolicy:'never'`, so this arriving means the profile is wrong) |
| Permissions-shaped approval, unknown request, malformed question, drain exhaustion | Interrupt + `STATUS: failed`, exit 2 |
| Wait cap expires (client-side, 540 s) | Interrupt, `STATUS: timeout`, exit 2 |
| **[rev 5]** Successful `turn/completed` arrives but the `review/start` response never lands | Daemon-owned ~5 s backstop → `failed`, waiters resolved; the buffered review is NEVER released as completed |
| Turn completes with blank review text | Turn finalizes `failed`; `STATUS: failed`, exit 2 — never an implicit clean review |
| Daemon boot/socket failure | Inside try/finally: stderr surfaced, exit 1, temp dir cleaned |
| `review` on a session without the review thread profile | `{error:'wrong_thread_profile'}`, turn state untouched |
| Invalid `start` flags (bad sandbox literal, valueless `--sandbox`, `--ephemeral`+resume, profile flags on resume) | **[rev 5]** Error BEFORE any existing session is probed, stopped or replaced — not merely before the spawn (today `start --force --sandbox bogus` would destroy an unrelated live session and only then error) |
| Server request with foreign `threadId` or stale `turnId` | Never parked; deny shape for supported approvals, JSON-RPC error response for everything else (never left unanswered) |
| Late response from a superseded turn (generation token mismatch) | Logged and dropped; current turn state untouched |
| **[rev 5]** `turn/started` carries an id differing from the response's | Expected for reviews; ignored (`turn.id` comes from the response only) — never an error |

## Testing

- Mock upgrades (`test/fixtures/mock-appserver.mjs` — today it implements only
  `turn/start`-shaped turns, mock-appserver.mjs:92): handle `review/start` with a
  real-shaped response `{turn, reviewThreadId}`, emit same-burst response+
  notification ordering, `item/completed{exitedReviewMode}` then `turn/completed`;
  scriptable failure modes: request rejection, mismatched `reviewThreadId`, blank
  review text, parked question, parked approval, interrupt.
  **[rev 5] Mode selection** cannot key off user text (a review has none): use an explicit
  `--review-mode` argv **with an allowlist** — an `indexOf`-based read is unsafe
  (`argv[-1+1]` silently yields `argv[0]`) and a typo'd mode must not fall back to the happy
  path and pass green. `test/daemon.test.mjs:27-35` already spreads `...extra` after
  `appServerOpts`, so per-test modes need no helper change.
  **[rev 5] Fix the fixture's shapes to live truth** (probe-verified, and note this CORRECTS
  a `strings`-derived claim): `TurnStartResponse` = `{turn:{id,…}}` — the mock's shape at
  :103 is already right, only its VALUE (`'turn-pending'`) is wrong and must be the real turn
  id; `TurnStartedNotification` = `{threadId, turn:{id}}` — the mock sends `{threadId, turnId}`
  (:30), unfaithful, and only the daemon's dual read (:226) hides it.
  **[rev 5]** The review mock MUST emit `turn/started` with an id DIFFERENT from the
  response's (that is live reality) and the daemon must still complete — this is the
  regression pin for "adopt from the response, never from `turn/started`". Also emit
  `enteredReviewMode` before `exitedReviewMode`.
  **[rev 5]** Do NOT add a `turnId`-omitting mode: live `item/completed` ALWAYS carried
  `turnId` (0 omissions across every probe), so daemon.mjs:236's comment is unsupported and
  nothing may be built on that leniency.
  **[rev 5]** Remove the 20 ms delay's masking effect (:27) — it is what hides the plan/send
  race today.
- Daemon unit tests (enabled by the new `cwd` option + mock modes): review dispatch
  happy path; busy guard; rejection → failed; wrong-thread response → failed;
  review capture survives `turn/completed` (the clobber case); blank review →
  failed; interrupt uses the owner thread; `review` refused without the review
  thread profile; generation-token drop of a superseded response; foreign-thread
  server request declined without parking **and still answered**; cwd coherence (caller cwd ≠
  review cwd — git scope, spawn cwd, and thread/start cwd all follow the review cwd).
  **[rev 5]** Plus buffer-until-response regressions on **plan/send**: a same-burst stale
  completion must not finalize a fresh turn. **[rev 5]** Regression-check the EXISTING
  `daemon.test.mjs:49-60` (ASK) and `:151-163` (APPROVE) — they already drive
  `_onServerRequest` end-to-end via real mock server requests carrying both ids, so
  server-request filtering is NOT uncovered. `:194-205`'s hand-built turn literal omits the
  new fields (absent field ⇒ no barrier).
- git-scope unit tests: dirty/clean tree, SHA base, detached HEAD (**[rev 5]** resolves
  normally, no throw), non-repo, blank/boolean base, base+scope conflict (temp-dir git
  fixtures). **[rev 5]** Plus: nonexistent ref → error with no daemon boot; `base == HEAD` →
  empty delta → error; non-ancestor base → error; caller env carrying `GIT_DIR` (and
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0`) does not move or reconfigure the
  review scope; a repo-local `status.showUntrackedFiles=no` still reports dirty.
- verbs parse table: `review --base x`, `--scope working-tree`, valueless `--base`;
  `start` profile flags (bad sandbox literal, valueless `--sandbox`,
  `--ephemeral`+resume rejection); `--socket` override on non-start verbs.
  **[rev 5]** Plus: `review --base=abc` and `--scope=branch` are LOUD errors, not silent auto.
- One-shot script: ALL paths — including the completed-review happy path — are
  testable offline via the `CODEX_DRIVE_TEST_APPSERVER` injection seam (JSON-array
  grammar, gated on `CODEX_DRIVE_TEST_MODE=1`) pointing at the mock (per-mode);
  plus rejection tests: the variable set WITHOUT test mode fails loudly, malformed
  JSON fails loudly. **[rev 5]** "ALL paths" holds ONLY with `CODEX_DRIVE_TEST_WAIT_MS`; the
  540 s cap is a hardcoded client-side constant no mock can shorten, so without that override
  the wait-cap row is a ~9-minute test and the claim is false.
  **[rev 5] Assert the trailers on the LAST TWO LINES** (`stdout.trimEnd().split('\n').slice(-2)`),
  never a bare `/^STATUS: …$/m` — the raw review body precedes the trailers and can itself
  contain a line reading `STATUS: failed`. (review-round.test.mjs:28 uses the loose pattern and
  gets away with it only because it never emits a body on that path.) Add a mock mode whose
  review text embeds a literal `STATUS: failed` line to pin this.
  A live smoke run remains as final validation, no longer the
  only happy-path coverage (fixes review-round's documented limitation,
  review-round.test.mjs:10).
- Detached-CLI path: profile handoff through the `__daemon` payload verified
  end-to-end (start with profile flags → `review` accepted; start without →
  `wrong_thread_profile`); `read --out` relative resolution against the
  socket-selected daemon's reported cwd, tested with absent and with mismatched
  global state. **[rev 5]** Both halves depend on the `__daemon` branch honoring the same
  gated test seam (above) — without it the detached daemon always spawns the real `codex
  app-server` and neither test can run offline.
- Live validation (renera-ai-tools repo): one working-tree review, one `--base
  <sha>` review; then one full boomi-mcp-server Stage-2 gate pass before the
  companion is uninstalled. **[rev 5]** Assert the ACTUAL diff covered, not merely that
  `review/start` was accepted — schema acceptance is not semantic correctness.

## Out of scope

- Porting rescue / task / transfer / adversarial-review (unused; die with the
  plugin).
- Any change to review-round.mjs / plan-round.mjs beyond the effort default.
- **[rev 5]** Focus text / custom review instructions on the native reviewer. **The decision
  stands; rev 4's rationale was factually false.** `review/start` DOES take a prompt — the
  `custom` variant carries `instructions`, documented in the 0.144.5 binary as "Arbitrary
  instructions, equivalent to the old free-form prompt", and surfaced in the Codex TUI as
  "Custom review instructions". Rev 4 inherited the belief from the companion, which emits
  only two variants (its :259-265) and whose error text asserts the reviewer "does not support
  custom focus text" — a companion POLICY, not a protocol fact. We *deliberately decline* the
  `custom` target; the prompt-based review-round.mjs remains the tool for focus text.
- **[rev 5]** The `commit` target. `baseBranch` is the correct variant for `--base <sha>` per
  the binary's own docstrings — `baseBranch` = "changes between the current branch and the
  given base branch" (= the delta since, what the fix-scope rule wants), whereas `commit` =
  "the changes introduced by a specific commit" (one commit's diff). `commit` would be wrong.
- **[rev 5]** Temp-ref synthesis as a SHA fallback (considered and rejected). Unnecessary —
  raw SHA is live-qualified. Also unsound: a `--no-track` branch has no upstream, so were the
  reviewer's `@{upstream}` template ever selected, the temp ref would fail for the identical
  reason a raw SHA would — it cannot rescue the only case it existed for. And it would mutate
  the repository under review (refs + reflog, leaking on SIGKILL, PID-collision-prone).
- Detached/background workers of any kind (the owned-session fallback covers long
  reviews).
