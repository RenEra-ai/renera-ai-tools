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
> `codex-reviewer` subagent (they isolate the chatty wait-loop from this context). Use this skill
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
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs plan "Architect a fix for <problem>. Inspect <files>. Produce a concrete, file-by-file plan. Ask if anything is ambiguous." --effort xhigh
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
dispatch the `codex-reviewer` subagent instead — see below.)

### 5. Stop

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs stop
```

Always `stop` when done — it kills the `codex app-server` child and removes the socket + state.

## Human supervision (important)

v1 is **human-supervised by design** — `wait` *parks* questions and approvals instead of
auto-answering. When you hit `status:"question"` or `status:"approval"`:

- **Show the user** what Codex asked (the question text + options, or the command/file it wants).
- Answer from the conversation context when the choice is unambiguous, and state what you chose.
- If it's a genuine product/scope decision, **ask the user** before answering.

Never silently guess your way through a parked question — surfacing it is the point.

## Full-issue orchestration (autonomous)

For a hands-off run, **`/codex-issue <#|task>`** drives the entire architect→implement→review→ship loop
via the **codex-orchestrator** agent — no human in the loop except `--dry-run` and a max-rounds guard.
Requires the `gh` CLI (authenticated) for issue intake + push/PR. Unlike the manual loop above
(human-supervised), the orchestrator **auto-answers** the architect's clarifying questions and
**auto-approves** the plan, then integrates the result.

Pieces:
- **codex-orchestrator** (agent) — drives the *persistent* daemon; owns plan → approval → review loop →
  finish (push + PR; `Closes #N` closes the issue on merge **into the default branch** — no explicit
  close; a non-default base like `dev` is flagged for manual close).
- **codex-developer** (agent) — the repo-agnostic **black box**: it **discovers and runs THIS repo's
  own full internal workflow wherever it's defined** (`CLAUDE.md`, `AGENTS.md`, or `.claude/` process
  docs / commands / agents) — however many internal reviews / QA agents / tests it has — then reports
  `STATUS: DONE/BLOCKED` + a diff. It **stops before landing** (push/PR are the orchestrator's job).
  It is **fail-closed**: a required review/QA gate that *cannot run* (e.g. a live QA stage needing
  credentials it doesn't have) is reported `BLOCKED`, never silently skipped — so the orchestrator
  stops rather than landing an under-reviewed change. Because a subagent **cannot dispatch another
  subagent**, a repo gate that is itself a subagent is **replayed inline** from its `.md` (and labeled
  `replayed inline` vs `natively run` in the report, so reduced fidelity is visible); a repo whose whole
  lifecycle is a Workflow it cannot run returns `BLOCKED` pointing to `/codex-compose-setup`. The
  orchestrator never looks inside; it only consumes that report. *(The plugin only adds the architect
  plan at the front and the architect review→fix loop at the back — it wraps, never replaces, the
  repo's lifecycle.)*
- *(optional)* an independent **plan-review subagent** (e.g. an agent named `plan-reviewer`, if one is
  configured in your environment) — a second-opinion approve/adjust verdict on the architect's plan;
  the orchestrator falls back to judging the plan itself when none is available. Not shipped with this
  plugin.

Flow: intake (`gh issue view`) → `plan` (architect, Plan mode) → approve → dispatch developer (black box)
→ `send` a review of impl-vs-plan **on the same thread** (so the architect remembers the plan) →
fix→re-review scoped to the fix delta until clean → `git push` + `gh pr create` (`Closes #N` — closes the
issue when merged into the default branch) → `stop`. The codex↔claude **messaging handoff** is just the verbs: `read` carries the
plan/review out of Codex; `send` points Codex at the developer's changed files on disk (never paste big
diffs — ARG_MAX).

Brakes: `--dry-run` stops before push/PR; the loop halts after the max rounds (default 6) rather
than push an un-clean change; the daemon is always `stop`ped, even on abort. **Robustness:** a turn that
ends `completed` but empty/preamble-only (a known gpt-5.5 quirk; the daemon flags it
`{status:"completed", empty:true}`) is retried in-thread with a nudge — never accepted as success; review
verdicts use a structured last-line `VERDICT: …` to avoid fragile substring matching. This orchestrated path
deliberately **overrides** the human-supervised default — use the manual `/codex-architect` +
`/codex-review` flow when you want to see and decide each step yourself.

**Workflow-mode repos.** If a repo's dev lifecycle is itself a Claude Code Workflow
(`.claude/workflows/*.js`), a subagent can't run it — so for those repos `/codex-issue` **composes**
instead of wrapping from outside: the command (main thread) runs a wrapper workflow
(`workflows/codex-wrap.js`) that brackets the repo's **own** workflow (called with `noLand:true`, all
its gates intact) with the architect plan + review, then lands. Detected by
`grep -l noLand .claude/workflows/*.js`; falls back to the subagent path above when no composable
workflow is present. Run **`/codex-compose-setup`** to add the `noLand` seam to a repo's workflow (or
scaffold a starter) — `noLand` is not an Anthropic-standard arg, so the repo's workflow must read it.
In composition, the architect's fix rounds re-run the repo's **own review/QA gate(s)** on the fix (a
gate that is a command/script runs natively; a gate that is a subagent is **replayed inline**, since
subagents can't nest), a clean-but-substance-free verdict is nudged once rather than rubber-stamped, and
a gate that can't run is fail-closed (not landed). If a repo has a Workflow that **isn't**
composition-ready (no `noLand`), `/codex-issue` says so and nudges `/codex-compose-setup` instead of
silently degrading. Run **`/codex-doctor`** to preflight which mode a repo will use and whether the
seam is intact. Contract + details: `${CLAUDE_PLUGIN_ROOT}/docs/WORKFLOW-MODE.md`.

## Verb reference

| Verb | Args | Returns |
|---|---|---|
| `doctor` | — | `{ codexVersion, authPresent, threads }` |
| `start` | `[--cwd <path>] [--model <m>] [--resume <uuid> \| --resume-latest]` | `{ ok, threadId, socket, pid }` |
| `plan` | `"<prompt>" [--effort <e>] [--approval-policy untrusted]` | `{ ok, status:"running" }` · `{error:"busy"}` · `{error:"no_model_for_mode"}` |
| `send` | `"<prompt>" [--effort <e>] [--mode default] [--approval-policy untrusted]` | `{ ok, status:"running" }` · `{error:"busy"}` · `{error:"no_model_for_mode"}` (only with `--mode`) |
| `wait` | `[--timeout-ms <N>]` | `{status:"completed",message[,empty:true]}` · `{status:"question",question}` · `{status:"approval",request}` · `{status:"interrupted"\|"failed",message}` · `{status:"unsupported",request}` · `{status:"timeout"}` (exit 2) |
| `answer` | `--id <qid> (--option <n> \| --text "<s>")` | `{ ok }` · `{error:"no_pending_question"}` (`--option` is 1-based; one selection per call — answering resumes the turn) |
| `approve` | `--decision allow\|deny` | `{ ok }` · `{error:"no_pending_approval"}` |
| `read` | — | `{ status, message[, empty:true] }` (last assistant message; `empty:true` flags a completed turn that produced no content) |
| `interrupt` | — | `{ ok }` · `{error:"no_active_turn"}` |
| `status` | — | `{ threadId, turnStatus, parked }` |
| `stop` | — | `{ ok }` (tears down daemon, socket, state) |

**Modes & effort.** `plan` = Plan mode (read-only architect). Plain `send` inherits the thread's
current mode (a `send` after a `plan` reviews read-only — exactly what you want). `send --mode
default` explicitly leaves Plan mode (only needed if you ever want Codex to edit). `--effort` ∈
`{minimal, low, medium, high, xhigh, none}`; use `xhigh` for hard architecture problems.

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
- **Stuck `wait`** — pass `--timeout-ms <N>`; on timeout you get `{status:"timeout"}` (exit 2),
  then `interrupt`.
- **After upgrading Codex** — the Plan-mode / question surfaces are experimental and may drift
  across Codex versions; re-run `doctor` and sanity-check a `plan` turn.

## Notes

- The daemon is a **single global session** (`~/.codex-drive/state.json`); one in-flight turn at a
  time. Don't run two architect sessions concurrently from the main thread. The `codex-reviewer`
  subagent sidesteps this by running its own **ephemeral** daemon on a private socket.
- This plugin complements the separate `codex` plugin (rescue/setup, one-shot `codex exec`). They
  can coexist; this one adds the native Plan-mode architect + interactive review loop.
- Design rationale and protocol details: `${CLAUDE_PLUGIN_ROOT}/docs/specs/2026-05-31-codex-drive-design.md`.
