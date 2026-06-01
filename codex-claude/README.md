# codex-claude

Use **Codex** (the OpenAI coding agent, GPT-5.x) as an **architect** and **reviewer** inside the
Claude Code development loop — without GUI automation. A background session daemon drives a headless
`codex app-server` over JSON-RPC (the same protocol the Codex desktop app, VS Code extension, and
CLI use), so Claude Code can run a native **architect → implement → review** loop: **Codex plans
and reviews (read-only); Claude implements.**

This plugin **complements** the separate `codex` plugin (one-shot `codex exec` rescue/setup) — it
adds the native Plan-mode architect and the interactive review loop. They can coexist.

## Requirements

- Node ≥ 20 (the runtime is pure Node stdlib — zero dependencies, zero install).
- A logged-in Codex CLI: `codex login status` → "Logged in using ChatGPT". Auth is reused from
  `~/.codex/auth.json`; this plugin never handles credentials.

Verify with:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs doctor
# → { "codexVersion": "0.130.0", "authPresent": true, "threads": 12 }
```

## What's in the plugin

| Component | What it does |
|---|---|
| **skill** `codex-claude` | The brain: daemon lifecycle, the full verb contract, the architect→implement→review loop, and human-supervised question/approval handling. Auto-activates when you ask Claude to use Codex as an architect/reviewer. |
| **command** `/codex-architect <task>` | Runs a Plan-mode architect turn **in the main thread**, surfacing Codex's clarifying questions to you. You implement the resulting plan. |
| **command** `/codex-review [scope]` | Dispatches the `codex-reviewer` subagent for an independent review of your changes (defaults to the current diff). |
| **agent** `codex-reviewer` | Autonomous, isolated read-only review on its own **ephemeral** Codex session; returns a clean findings report. |
| **runtime** `bin/` + `lib/` | The `codex-drive` CLI + session daemon (JSON-RPC client, turn state machine, question/approval parking). |
| `scripts/review-round.mjs` | One-shot ephemeral-daemon review used by the `codex-reviewer` agent. |

> **On the two names:** the vendored runtime engine is the npm package `codex-drive`; the plugin
> (the product) is `codex-claude`. The internal client name and the `~/.codex-drive/` state dir are
> deliberate and decoupled from the plugin name — renaming the state dir would orphan existing
> Codex sessions, so leave them as-is.

## CLI verb reference

All verbs are invoked as `node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs <verb>` and print one JSON
object on stdout.

| Verb | Purpose |
|---|---|
| `doctor` | Report Codex version, auth presence, thread count. |
| `start [--cwd <p>] [--model <m>] [--resume-latest \| --resume <uuid>]` | Boot the session daemon, open/resume a thread. |
| `plan "<prompt>" [--effort xhigh] [--approval-policy untrusted]` | Plan-mode (read-only architect) turn. |
| `send "<prompt>" [--effort <e>] [--mode default] [--approval-policy untrusted]` | Default/review turn. |
| `wait [--timeout-ms <N>]` | Block until the turn completes or parks a question/approval. |
| `answer --id <qid> (--option <n> \| --text "<s>")` | Answer a parked question (`--option` is 1-based). |
| `approve --decision allow\|deny` | Answer a parked exec/file approval. |
| `read` | Return the last assistant message (plan or review). |
| `interrupt` | Cancel the in-flight turn. |
| `status` | Daemon / thread / turn state. |
| `stop` | Graceful shutdown (kill app-server, remove socket + state). |

## Development

```bash
node --test test/*.test.mjs          # unit tests (zero-dep)
CODEX_DRIVE_LIVE=1 node --test test/integration.live.test.mjs   # live, needs a logged-in codex
```

Design rationale and protocol notes live in `docs/specs/2026-05-31-codex-drive-design.md`.
The Plan-mode (`collaborationMode`) and clarifying-question (`requestUserInput`) surfaces are
**experimental** in Codex and may drift across versions — re-run `doctor` after upgrading.
