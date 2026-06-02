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
| **command** `/codex-issue <#\|task>` | **Fully autonomous** end-to-end loop: architect → approve → implement (via the repo's own workflow) → review-until-clean → push + PR (issue closes on merge). Add `--dry-run` to stop before integration. |
| **agent** `codex-reviewer` | Autonomous, isolated read-only review on its own **ephemeral** Codex session; returns a clean findings report. |
| **agent** `codex-orchestrator` | Drives the full `/codex-issue` loop on the persistent daemon; owns plan approval, the review loop, and the push/PR finish (the issue closes on merge). |
| **agent** `codex-developer` | The repo-agnostic **black box**: **discovers and runs THIS repo's own full internal workflow** wherever defined (`CLAUDE.md`/`AGENTS.md`/`.claude/` docs, commands, agents) — however many internal reviews/QA/tests — then reports `DONE` + a diff. Stops before landing. |
| **runtime** `bin/` + `lib/` | The `codex-drive` CLI + session daemon (JSON-RPC client, turn state machine, question/approval parking). |
| `scripts/review-round.mjs` | One-shot ephemeral-daemon review used by the `codex-reviewer` agent. |

> **On the two names:** the vendored runtime engine is the npm package `codex-drive`; the plugin
> (the product) is `codex-claude`. The internal client name and the `~/.codex-drive/` state dir are
> deliberate and decoupled from the plugin name — renaming the state dir would orphan existing
> Codex sessions, so leave them as-is.

## Full automation (`/codex-issue`)

`/codex-issue <issue-number | free-text task> [--dry-run] [--base <branch>]` runs the whole loop
hands-off via the `codex-orchestrator` agent:

1. **Intake** the GitHub issue (`gh issue view`) or free-text task; create a `codex/…` branch.
2. **Architect** plans it (Plan mode); the orchestrator **auto-answers** clarifying questions and
   **auto-approves** the plan (optionally getting a second opinion from an independent plan-review
   subagent such as `plan-reviewer`, if one is configured — not shipped with this plugin).
3. **Implement** — dispatches the `codex-developer` black box, which **discovers and runs this repo's
   own full internal workflow** wherever it lives (`CLAUDE.md`/`AGENTS.md`/`.claude/`), however many
   internal reviews/QA/tests it has, **stops before landing**, and reports back `DONE` + a diff.
4. **Architect review** of impl-vs-plan on the same thread → fix → re-review until the architect's
   structured `VERDICT: NO ISSUES`.
5. **Finish** — `git push`, `gh pr create` (`Closes #N`), then `stop` the daemon. The issue closes
   **on merge** — the loop never auto-merges and never closes the issue itself (avoids stranding a
   wrongly-closed issue if the PR is rejected).

It is **fully autonomous and ends in irreversible actions** (push / PR). Brakes: `--dry-run`
stops before integration; the loop halts after a max round count (default 6) rather than push an
un-clean change. This deliberately overrides the human-supervised model of `/codex-architect` +
`/codex-review` — use those when you want to drive each step yourself. Requires `gh` (GitHub CLI)
authenticated for the integration step.

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
