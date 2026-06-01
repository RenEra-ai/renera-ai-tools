# codex-drive — Design Spec

**Date:** 2026-05-31
**Status:** Approved design (pre-implementation)
**Project location:** `/Users/gleb/Documents/Projects/codex-drive/` (standalone; not part of boomi-mcp-server)

## 1. Purpose

A standalone **Node** CLI that drives a headless `codex app-server` (JSON-RPC 2.0 over stdio) so that
Claude Code can orchestrate a Codex **architect → implement → review → repeat-until-clean** dev-loop
natively — replacing the fragile GUI puppeting approach (screenshots + synthetic keystrokes via osascript).

The driver speaks the same documented protocol that the Codex desktop app, VS Code extension, mobile app,
and CLI all use. A background **session daemon** holds the app-server connection and the active thread;
thin CLI verbs talk to the daemon over a local unix socket.

### Why this protocol (recon summary)

- `codex app-server` is a documented, supported JSON-RPC 2.0 service (newline-delimited JSON over stdio;
  also `unix://` and `ws://` transports). Every primitive the loop needs is a first-class method.
- **Plan mode is machine-settable**, not GUI-only: `turn/start` accepts `collaborationMode: { mode: "plan",
  settings: {...} }` where `ModeKind` enum is exactly `["plan","default"]`. (This is why the existing Codex
  Claude Code plugin can't toggle Plan mode — it uses one-shot `codex exec`, omits `collaborationMode`, and
  sets `experimentalApi:false`.)
- **Native question pop-ups are protocol messages**, not GUI: the server sends an `item/tool/requestUserInput`
  JSON-RPC *request* (with `questions[]`/`options[]`); the client answers with a JSON-RPC response
  `{ answers: { <questionId>: { answers: [string,...] } } }`.
- **Auth is already solved** — the child `codex app-server` reuses the existing ChatGPT OAuth in
  `~/.codex/auth.json`. No API key, no per-call token.
- The mobile interface was rejected as an emulation target: there is no local listener; the phone reaches
  the Mac via an OpenAI **cloud relay** (WebRTC/STUN, account-scoped, undocumented) — high ToS/maintenance
  risk. The local app-server gives the same capabilities natively.

## 2. Scope

### In scope (v1 — the primitives)
- Open a new thread or resume an existing one.
- Send a turn; enter **Plan mode** for architect turns, default mode for execute/review turns.
- Stream assistant output and **detect turn completion**.
- Read the finished reply (last assistant message) or the full transcript.
- **Surface and answer** native question pop-ups (`item/tool/requestUserInput`) and exec/patch **approvals**
  (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, `mcpServer/elicitation/request`) on the live connection.
- Interrupt an in-flight turn.

### Out of scope (v1 — documented as future work)
- Unattended **auto-answer** policies for questions/approvals (start human-supervised).
- **API-key / Codex access-token** auth for fully-unattended looping (revisit when moving off
  human-supervised use; OpenAI recommends API keys for programmatic/CI workflows rather than personal OAuth).
- Attaching to the **live desktop window's** in-flight session (the experimental
  `app-server proxy --sock` / `remote-control` control-socket path).
- Multi-thread / multi-session management within one daemon.

## 3. Architecture

Decision: **session daemon + thin CLI verbs** (over one-shot-per-turn). The daemon keeps the JSON-RPC
connection open so that mid-turn questions can be answered on the **same live connection** — a one-shot
process would exit before a question could be answered, forcing blind policy auto-answers. Plan-mode turns
genuinely do ask clarifying questions, so interactive answering is a core requirement, not an edge case.

Language: **Node** — official type bindings come from `codex app-server generate-ts`, it is the same
runtime Codex itself uses (version-aligned), and async stdio/socket handling is clean.

### Components

1. **`lib/appserver.mjs` — JSON-RPC stdio client.**
   - Spawns `codex app-server` as a child process (default `stdio://` transport).
   - Frames newline-delimited JSON; tolerant of split and coalesced lines.
   - Matches responses to requests by `id`; routes **notifications** and **server-initiated requests** to
     registered handlers.
   - Handshake: client sends `initialize` with `{ clientInfo: { name, version },
     capabilities: { experimentalApi: true } }` → server replies → client sends `initialized` notification.

2. **Session daemon (`codex-drive start`).**
   - Owns exactly one app-server child and one active thread (`thread/start` or `thread/resume`).
   - Listens on a unix socket at `~/.codex-drive/<threadId>.sock`.
   - Tracks turn state, buffers streamed `item/agentMessage/delta` keyed by `turnId`.
   - **Parks** any inbound server-initiated request (question/approval) instead of auto-replying in v1;
     exposes it via `wait`/`status`.
   - Single in-flight turn at a time.

3. **Thin CLI client.**
   - Each verb connects to the daemon socket, sends a command, receives a structured JSON response.

4. **State file (`~/.codex-drive/state.json`).**
   - Persists `{ threadId, pid, socket, cwd, model }` for reconnect/continuity and for `--resume-latest`.

## 4. Turn & question/approval flow

1. `turn/start` with `input:[{type:"text",text}]`, plus `collaborationMode:{mode:"plan",settings:{...}}` for
   architect turns (default mode otherwise). Reasoning `effort` (e.g. `xhigh`) is a separate, orthogonal field.
2. Daemon accumulates `item/agentMessage/delta` for the active `turnId`.
3. If the server sends `item/tool/requestUserInput` / a `*/requestApproval` / `mcpServer/elicitation/request`:
   the daemon **parks** it, sets turn state `awaiting_input`, and surfaces it via `wait`/`status`.
   It does **not** auto-reply (v1).
4. The orchestrator (Claude or the human) calls `answer` / `approve`; the daemon sends the matching JSON-RPC
   response on the live connection; the turn continues and deltas resume.
5. On `turn/completed` (`status` ∈ `completed | interrupted | failed`), the daemon finalizes the assistant
   message and resolves any pending `wait`.

## 5. CLI surface

| Verb | Purpose |
|---|---|
| `start [--cwd <path>] [--resume <uuid> \| --resume-latest] [--model <m>]` | boot daemon, open/resume thread → prints `{ threadId, socket, pid }` |
| `plan "<prompt>" [--effort xhigh]` | start a turn in **Plan mode** (`collaborationMode.mode = "plan"`) |
| `send "<prompt>" [--effort <e>]` | start a turn in default mode (execute/review) |
| `wait` | block until the current turn reaches `completed`, **or** a question/approval is parked → returns `{ status: "completed", message }` \| `{ status: "question", question }` \| `{ status: "approval", request }` \| `{ status: "interrupted"\|"failed", ... }` |
| `answer --id <qid> (--option <n> \| --text "<freeform>")` | reply to a parked question on the live connection; repeatable for multi-question requests |
| `approve --id <reqid> --decision allow\|deny` | reply to a parked exec/patch/permission approval |
| `read [--last \| --full]` | return the latest assistant message, or the full thread transcript |
| `interrupt` | `turn/interrupt` the in-flight turn |
| `status` | daemon / thread / turn state (incl. any parked request) |
| `stop` | graceful shutdown: `thread/unsubscribe`, kill app-server, remove socket + state |
| `doctor` | check installed `codex` version, (re)generate pinned protocol types, verify auth present |

### I/O contract
- All verbs emit a single structured JSON object on stdout (machine-readable for the orchestrator).
- Non-zero exit codes for distinct error classes (no daemon, busy, app-server dead, protocol error).

## 6. How Claude drives the loop

1. `codex-drive start --cwd <repo>` (or `--resume-latest` for continuity).
2. `codex-drive plan "Architect a fix for <bug>. Produce a plan."` → `codex-drive wait`
   → if `status:"question"`, `codex-drive answer ...` then `wait` again until `completed` → `read` the plan.
3. **Claude implements** the plan in the repo.
4. `codex-drive send "Review the implementation in <files>. Report issues, or reply 'no issues'."`
   → `wait` → `read` the review.
5. If issues → Claude fixes → back to step 4. If "no issues" → `codex-drive stop`.

## 7. Auth

No new credentials. The child `codex app-server` inherits the existing ChatGPT OAuth tokens in
`~/.codex/auth.json` (mode 0600). API-key / Codex access-token auth is deferred to the future
unattended-automation milestone.

## 8. Error handling & edge cases

- **app-server child crash/exit** → daemon detects, marks state `dead`, returns a clear error to clients;
  optional `--auto-restart` re-spawns and `thread/resume`s the same thread.
- **Stale socket / no daemon** → CLI verbs detect and error with guidance to run `start`.
- **Turn already in progress** → `plan`/`send` return a `busy` error; caller must `wait` or `interrupt`.
- **Single in-flight turn** per daemon (no concurrent turns in v1).
- **Experimental schema drift across Codex versions** → pin to the `codex app-server generate-ts` output of
  the installed version; `doctor` checks the version and regenerates types. `collaborationMode` and
  `requestUserInput` are experimental and may change.
- **Parked request left unanswered** → surfaced by `status`; `stop`/`interrupt` clears it.

## 9. Testing

- **Unit:** JSON-RPC framing (split lines, multiple messages per chunk), request/response id-matching,
  notification dispatch, server-request routing.
- **Live integration (gated, requires a logged-in `codex`):**
  - handshake (`initialize`/`initialized`) succeeds with `experimentalApi:true`;
  - `send "say OK"` reaches `turn/completed` and `read --last` returns the message;
  - a `plan` turn enters Plan mode (assert via the plan-style output / echoed `collaborationMode`);
  - a prompt known to trigger `item/tool/requestUserInput` causes `wait` to return `status:"question"`,
    and `answer` lets the turn continue to `completed`.
- The standard project completion gates (QA agent + Codex review) apply before "done" per the user's workflow.

## 10. Open risks (carried from recon)

- The `collaborationMode` / `requestUserInput` surface is **experimental** and may shift across Codex
  versions — mitigated by pinned generated types + `doctor`.
- ToS posture for eventual unattended looping on a personal ChatGPT subscription — deferred with the
  autonomy milestone; switch to API-key auth if/when the loop becomes unattended.
