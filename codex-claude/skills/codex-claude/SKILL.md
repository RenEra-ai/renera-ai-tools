---
name: codex-claude
version: 1.6.0
description: >-
  Use Codex (GPT-5.x) as a second-opinion architect and reviewer during Claude Code
  development, without GUI automation. This skill drives a headless `codex app-server`
  over JSON-RPC for a native architect → implement → review loop: Codex plans (Plan mode)
  and reviews (read-only) while Claude implements. Use it when the user asks to "have Codex
  architect/plan/design this", "get a Codex (or GPT-5) review", "second opinion from Codex",
  "run the codex architect→review loop", or when you want an independent model to vet a plan
  or a diff before/after implementing. It complements — does not replace — Claude Code's own
  workflow (brainstorming, TDD, plans). Requires a logged-in Codex CLI; reuses its ChatGPT auth.
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - Task
requirements:
  node: ">=20"
  external:
    - "codex CLI logged in (`codex login status` → \"Logged in using ChatGPT\")"
---

# codex-claude — Codex as architect & reviewer

This skill lets you orchestrate **Codex** (the OpenAI coding agent, GPT-5.x) as an
**architect** and **reviewer** inside the Claude Code dev loop. Codex runs headless via a
background **session daemon** that speaks the documented `codex app-server` JSON-RPC protocol —
the same protocol the Codex desktop app, VS Code extension, and CLI use. No screenshots, no
synthetic keystrokes.

**Division of labor:** Codex *plans* (Plan mode, read-only) and *reviews* (read-only). **You
(Claude) implement.** Codex never edits the repo in this loop — that keeps approvals out of the
way and keeps you in control of the code.

The CLI is invoked as:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs <verb> [args]
```

Zero install, zero dependencies (pure Node ≥20 stdlib). Every verb prints **one JSON object** on
stdout. Daemon state is global (a single session) in `~/.codex-drive/state.json`.

> **Two ways in.** For a one-shot autonomous review, prefer the `/codex-review` command or the
> `codex-impl-reviewer` subagent (they isolate the chatty wait-loop from this context). Use this skill
> directly for the **architect** flow and for any interactive loop where Codex's clarifying
> questions must be surfaced to the user.

## Before you start: doctor

Always verify the environment first:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs doctor
```

→ `{ "codexVersion": "0.130.0", "authPresent": true, "threads": 12 }`

- `codexVersion: null` → Codex CLI not installed/on PATH. Stop and tell the user to install Codex.
- `authPresent: false` → not logged in. Tell the user to run `codex login` (this skill reuses
  `~/.codex/auth.json`; it never handles credentials itself).

## The loop (architect → implement → review)

```
1. start  ──►  2. plan ─► wait ─► (answer questions) ─► read   ── the architecture/plan
                                                                   │
                          3. YOU implement the plan ◄──────────────┘
                                                                   │
4. send "review…" ─► wait ─► read  ── the review ──► issues? fix ─┘  clean? ─► 5. stop
```

### 1. Start the session

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs start --cwd "$PWD"
# add --model <name> if Plan mode errors with no_model_for_mode (see Troubleshooting)
# add --resume-latest to continue the most recent Codex thread for this cwd
```

→ `{ "ok": true, "threadId": "...", "socket": "...", "pid": 12345 }`

### 2. Architect turn (Plan mode, read-only)

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs plan "Architect a fix for <problem>. Inspect <files>. Produce a concrete, file-by-file plan. Ask if anything is ambiguous." --effort max
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs wait
```

`wait` returns one of:
- `{ "status": "completed", "message": "<the plan>" }` → read it (or use the message directly).
- `{ "status": "question", "question": {...} }` → Codex needs a decision. **Surface it to the
  user** with its options; answer with `answer` (below); then `wait` again. Plan mode genuinely
  asks clarifying questions — this is expected, not an error.
- `{ "status": "approval", "request": {...} }` → rare in read-only Plan/review. Surface and
  `approve` it, or `interrupt`.
- `{ "status": "failed" | "interrupted", "message": "..." }` → see Troubleshooting.

Answer a parked question (1-based option index, or free text):

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs answer --id <questionId> --option 2
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs answer --id <questionId> --text "free-form answer"
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs wait   # continue the turn
```

Read the finished plan explicitly if needed:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs read   # → { status, message }
```

### 3. Implement

You (Claude) implement the plan in the repo using your normal tools and workflow (TDD, etc.).
Codex does not touch the code.

### 4. Review turn (read-only)

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs send "Review the implementation in <files>. List concrete issues with file:line. END with a verdict on its own final line: exactly 'VERDICT: NO ISSUES' or 'VERDICT: ISSUES FOUND'."
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs wait
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs read
```

If the last line isn't `VERDICT: NO ISSUES` → fix the listed issues → `send` another review →
`wait`/`read`. Repeat until clean. (For a hands-off review that keeps this loop out of your context,
dispatch the `codex-impl-reviewer` subagent instead — see below.)

### 5. Stop

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs stop
```

Always `stop` when done — it kills the `codex app-server` child and removes the socket. The
`~/.codex-drive/state.json` record survives as a stale entry; `start`'s liveness probe replaces it.

## Human supervision (important)

v1 is **human-supervised by design** — `wait` *parks* questions and approvals instead of
auto-answering. When you hit `status:"question"` or `status:"approval"`:

- **Show the user** what Codex asked (the question text + options, or the command/file it wants).
- Answer from the conversation context when the choice is unambiguous, and state what you chose.
- If it's a genuine product/scope decision, **ask the user** before answering.

Never silently guess your way through a parked question — surfacing it is the point.

## Full-issue orchestration (autonomous, main-thread)

For a hands-off run, **`/codex-issue <#|task>`** drives the entire architect → implement → review →
ship loop **in the main thread** — so it has `Task` and runs **this repo's own development workflow,
including its subagents**, for real. No human in the loop except `--dry-run` and a max-rounds guard.
Requires the `gh` CLI (authenticated) for issue intake + push/PR. Unlike the manual loop above
(human-supervised), the loop **auto-answers** the architect's clarifying questions (via the helper
agents) and **auto-approves** the implementation plan, then integrates the result.

Codex is driven by thin, `Task`-free helper subagents (they isolate the verbose Codex wait-loop):
- **codex-architect** (agent) — drives an *ephemeral* Codex Plan-mode session to produce the
  file-by-file **design plan**; persists it to `.codex/plans/issue-<#>.md` and returns the path.
- **codex-planner** (agent, dispatched `mode:"plan"`, **read-only**) — **Claude** authoring its own
  concrete **implementation plan** from the design plan (Codex is not involved in this step); returns
  the text, which the main thread persists to `.codex/plans/issue-<#>.claude.md`.
- **codex-impl-reviewer** (agent) — drives an *ephemeral* Codex review of impl-vs-**design-plan** and
  returns a structured last-line `VERDICT:`.

The main thread does the rest itself: it **develops** (running the repo's own workflow — its real
QA/review gates, dispatched subagents **and** command gates it names like its own
Codex review, which the §6 plan review never substitutes for), then **addresses** each review round's findings via the
**receiving-code-review** skill (verify, fix genuine issues, push back on false positives — never blind
compliance), re-running the repo's gates (its own Codex review gate included) on each fix delta, until the verdict is `VERDICT: NO ISSUES` or the max rounds
(default 6) is hit. All Codex sessions are **ephemeral**; the saved design-plan **file** is inlined
**verbatim** into each review (the driver appends it byte-for-byte via `--plan-file`, so the gate always
judges against the exact approved plan — never a paraphrase), so there is **no persistent daemon** to
manage. Finish: `git push` + `gh pr create` (`Closes #N`
closes the issue on a merge **into the default branch**; a non-default base like `dev` is flagged for a
manual close). The loop never auto-merges and never closes the issue itself.

Brakes: `--dry-run` stops before push/PR; the loop halts after the max rounds rather than push an
un-clean change. **Robustness:** a Codex turn that ends `completed` but empty/preamble-only is retried
in-thread by the driver; review verdicts use a structured last-line `VERDICT: …` (no fragile substring
matching). This autonomous path deliberately **overrides** the human-supervised default — use the
manual `/codex-architect` + `/codex-review` flow when you want to see and decide each step yourself.

**Workflow-mode repos.** If a repo's dev lifecycle is itself a composable Claude Code Workflow
(`.claude/workflows/*.js` that **reads** `args.noLand`), the main thread runs that Workflow (with
`noLand:true`, all its gates intact) as the **development engine** via `workflows/codex-wrap.js`, while
everything around it — the architect plan, the implementation plan, the review, and the fixes — stays
in the main thread. Detected by scanning `.claude/workflows/*.{js,mjs}` for a file that actually reads
`args.noLand` (a bare comment mention doesn't qualify); it falls back to main-thread development when no
composable workflow is present (and nudges a non-composable Workflow toward `/codex-compose-setup`). Run
**`/codex-compose-setup`** to add the `noLand` seam (`noLand` is not an Anthropic-standard arg, so the
repo's workflow must read it), and **`/codex-doctor`** to preflight which mode a repo will use. Contract
+ details: `${CLAUDE_PLUGIN_ROOT}/docs/WORKFLOW-MODE.md`.

## Verb reference

| Verb | Args | Returns |
|---|---|---|
| `doctor` | — | `{ codexVersion, authPresent, threads }` |
| `start` | `[--cwd <path>] [--model <m>] [--resume <uuid> \| --resume-latest] [--force] [--private] [--sandbox <s>] [--approval-policy <p>] [--ephemeral]` | `{ ok, threadId, socket, pid, cwd, private }` — **idempotent**: refuses if a live session already exists (avoids orphaning its daemon); `--force` stops the existing one first. `--private` neither reads nor writes the global state (use with `--socket` below). Profile flags are validated **before** any existing session is probed or stopped, and are rejected on a `--resume` |
| `plan` | `"<prompt>" [--effort <e>] [--approval-policy untrusted]` | `{ ok, status:"running" }` · `{error:"busy"}` · `{error:"restart_required"}` · `{error:"no_model_for_mode"}` |
| `send` | `"<prompt>" [--effort <e>] [--mode default] [--approval-policy untrusted]` | `{ ok, status:"running" }` · `{error:"busy"}` · `{error:"restart_required"}` · `{error:"no_model_for_mode"}` (only with `--mode`) |
| `review` | `[--base <ref\|sha> \| --scope <auto\|working-tree\|branch>]` | `{ ok, status:"running", scope }` · `{error:"busy"}` · `{error:"wrong_thread_profile"}` · `{error:"restart_required"}` · `{error:"<validation>"}`. **Native git-scoped commit review** (`review/start`) — distinct from a prompt-based `send` review: it takes no prompt, inherits the config's effort, and returns the built-in reviewer's findings. Requires a session started with `--sandbox read-only --approval-policy never --ephemeral`. Scope is validated synchronously: an unresolvable/non-ancestor/empty-delta base is an error, never a silent fallback |
| `wait` | `[--timeout-ms <N>]` | `{status:"completed",message[,empty:true]}` · `{status:"question",question}` · `{status:"approval",request}` · `{status:"interrupted"\|"failed",message}` · `{status:"unsupported",request}` · `{status:"timeout"}` (exit 2) |
| `answer` | `--id <qid> (--option <n> \| --text "<s>")` | `{ ok }` · `{error:"no_pending_question"}` (`--option` is 1-based; one selection per call — answering resumes the turn). Exactly one of `--option`/`--text` is required and both need a real value: a valueless flag used to answer the live question with the literal text `__option:true` / `true` |
| `approve` | `--decision allow\|deny` | `{ ok }` · `{error:"no_pending_approval"}` |
| `read` | `[--out <path>]` | `{ status, message[, empty:true], cwd }` (last assistant message; `empty:true` flags a completed turn that produced no content). `--out` writes a non-empty message to a file; a RELATIVE path resolves against the daemon's reported `cwd`, not the caller's |
| `interrupt` | — | `{ ok }` · `{error:"no_active_turn"}` (only when nothing is running or awaiting input). A turn whose `turn/start` response has not arrived yet is **also** interruptible: it is ended locally as `interrupted` and the session is marked `restartRequired` (that turn's id never reached us, so its later traffic can no longer be told apart from a new turn's) |
| `status` | — | `{ threadId, turnStatus, parked, cwd, restartRequired[, restartReason] }` — `restartRequired:true` means the session refuses new turns until `stop` + `start` |
| `stop` | — | `{ ok }` (tears down the daemon, kills the app-server, removes the socket; the `~/.codex-drive/state.json` record is left behind as a stale entry — `start`'s liveness probe replaces it) |

Every verb except `start` and `doctor` also accepts **`--socket <path>`**, which talks to that daemon
directly instead of consulting `~/.codex-drive/state.json`. That file is global and single: a
concurrent `start` anywhere on the machine rewrites it and would otherwise redirect this session's
`wait`/`read`/`stop`. `--socket` is what makes `start --private` usable.

`--flag=value` is **not** supported anywhere and is a hard error — `--base=<sha>` would otherwise
parse as an unrelated key and silently downgrade a scoped review to `auto`.

**Modes & effort.** `plan` = Plan mode (read-only architect). Plain `send` inherits the thread's
current mode (a `send` after a `plan` reviews read-only — exactly what you want). `send --mode
default` explicitly leaves Plan mode (only needed if you ever want Codex to edit). `--effort` ∈
`{minimal, low, medium, high, xhigh, max, ultra, none}` (max/ultra are GPT-5.6 Sol values). **Use
`max` for hard architecture problems** — it is the maximum reasoning depth. `ultra` is `max` PLUS
automatic task delegation, which makes it markedly slower and is the documented cause of drivers
blowing their 540 s wait cap; opt into it deliberately, never as a default. Effort dominates
wall-clock: the same review measured **36 s at `low`** vs **>560 s (never completed) at `max`**.

## Troubleshooting

- **`no active session; run start first`** — the daemon isn't up. Run `start`.
- **`{error:"busy"}`** — a turn is already in flight. Run `wait` (or `interrupt` to abandon it).
- **`{error:"no_model_for_mode"}`** — Plan/`--mode default` needs a concrete model string. Either
  set a default in `~/.codex/config.toml`, or re-`start` with `--model <name>` (e.g. a model from
  the user's Codex config). Plain `send` (review) does not need this.
- **`{status:"failed"}` with "codex app-server exited"** — the child died mid-turn. Run `stop`,
  then `start` again with `--resume <threadId>`/`--resume-latest` to keep the architect's plan thread.
- **`{status:"completed", empty:true}` or a preamble-only message** — a malformed Codex turn (no
  plan/verdict; a gpt-5.5 build quirk). Don't treat it as success: re-`send` the same prompt **on the
  same thread** with a nudge ("emit the full plan/verdict as plain text now; don't stop after the
  reasoning preamble"); cap retries. Restart (with `--resume`) only if the app-server actually died.
- **`{status:"unsupported"}`** — Codex raised an **MCP elicitation** (or an unknown request kind)
  this client can't answer. `interrupt` the turn and proceed without it.
- **Permissions approval** — `item/permissions/requestApproval` comes back from `wait` as
  `{status:"approval"}`, but `approve` then fails with `{error:"permissions approval not supported…"}`
  (its response shape differs from exec/file approvals). `interrupt` the turn rather than approving it.
- **Stuck `wait`** — pass `--timeout-ms <N>`; on timeout you get `{status:"timeout"}` (exit 2).
  A timeout does **not** stop the turn — it is a poll result, so waiting again is usually right.
  `interrupt` only when you actually want the turn cancelled.
- **A long turn killed by the Bash cap** — `review-round`/`plan-round` now treat their own wait cap
  as a poll interval (they re-wait instead of interrupting), but a single Bash call still cannot
  outlive its ~10-minute cap. For a genuinely long review/plan, drive an owned session instead:
  `start --private` → `send`/`plan` → repeated `wait --timeout-ms 300000 --socket S` in SEPARATE
  Bash calls → `read --out` → `stop`. The turn survives across calls; each call stays bounded.
- **After upgrading Codex** — the Plan-mode / question surfaces are experimental and may drift
  across Codex versions; re-run `doctor` and sanity-check a `plan` turn.

## Notes

- The daemon is a **single global session** (`~/.codex-drive/state.json`); one in-flight turn at a
  time. Don't run two architect sessions concurrently from the main thread. The `codex-impl-reviewer`
  subagent sidesteps this by running its own **ephemeral** daemon on a private socket.
- This plugin complements the separate `codex` plugin (rescue/setup, one-shot `codex exec`). They
  can coexist; this one adds the native Plan-mode architect + interactive review loop.
- Design rationale and protocol details: `${CLAUDE_PLUGIN_ROOT}/docs/specs/2026-05-31-codex-drive-design.md`.
