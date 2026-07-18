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
| **command** `/codex-review [scope]` | Dispatches the `codex-impl-reviewer` subagent for an independent review of your changes (defaults to the current diff). |
| **command** `/codex-issue <#\|task>` | **Fully autonomous** end-to-end loop: architect → approve → implement (via the repo's own workflow) → review-until-clean → push + PR (issue closes on merge). Add `--dry-run` to stop before integration. |
| **command** `/codex-doctor` | Read-only preflight: which mode (`/codex-issue` will use composition vs subagent) and why, `noLand` seam integrity, resolved PR base + auto-close, and Codex daemon health. |
| **agent** `codex-impl-reviewer` | Autonomous, isolated read-only review on its own **ephemeral** Codex session; returns a clean findings report. |
| **runtime** `bin/` + `lib/` | The `codex-drive` CLI + session daemon (JSON-RPC client, turn state machine, question/approval parking). |
| `scripts/review-round.mjs` | One-shot ephemeral-daemon review used by the `codex-impl-reviewer` agent. |
| **workflow** `workflows/codex-wrap.js` | **Workflow-mode** composition: brackets a repo's own no-land Workflow with a Codex architect plan + review, then lands. Invoked by `/codex-issue` when a composable `.claude/workflows/*.js` or `.mjs` file is detected. |
| `scripts/plan-round.mjs` | Ephemeral Plan-mode Codex session used by the wrapper's architect-plan phase. |
| **command** `/codex-compose-setup` | Makes a repo composition-ready: adds the `noLand` seam to its workflow (diff + approval) **in place**, or scaffolds a starter workflow if none exists. |
| `templates/implement-issue.template.js` | Repo-agnostic starter workflow (already `noLand`-aware; discovers the repo's test command) used by `/codex-compose-setup` scaffolding. |

> **On the two names:** the vendored runtime engine is the npm package `codex-drive`; the plugin
> (the product) is `codex-claude`. The internal client name and the `~/.codex-drive/` state dir are
> deliberate and decoupled from the plugin name — renaming the state dir would orphan existing
> Codex sessions, so leave them as-is.

## Full automation (`/codex-issue`)

`/codex-issue` runs the loop in the main thread; Codex is driven by the thin `codex-architect`/`codex-impl-reviewer` subagents (dispatched via Task).

`/codex-issue <issue-number | free-text task> [--dry-run] [--base <branch>]` runs the whole loop
hands-off in the main thread:

1. **Intake** the GitHub issue (`gh issue view`) or free-text task; create a `codex/…` branch.
2. **Architect** plans it (Plan mode); the main-thread loop **auto-answers** clarifying questions and
   **auto-approves** the plan (optionally getting a second opinion from an independent plan-review
   subagent such as `plan-reviewer`, if one is configured — not shipped with this plugin).
3. **Implement** — the main-thread loop discovers and runs this repo's own full internal workflow
   wherever it lives (`CLAUDE.md`/`AGENTS.md`/`.claude/`), however many internal reviews/QA/tests
   it has, **stops before landing**, and reports back `DONE` + a diff.
4. **Architect review** of impl-vs-plan on the same thread → fix → re-review until the architect's
   structured `VERDICT: NO ISSUES`.
5. **Finish** — `git push`, `gh pr create` (`Closes #N`), then `stop` the daemon. The loop never
   auto-merges and never closes the issue itself (avoids stranding a wrongly-closed issue). `Closes #N`
   auto-closes the issue only when the PR merges into the **default branch**; for a non-default base
   (e.g. `dev`) the main thread flags that the issue needs a manual close.

It is **fully autonomous and ends in irreversible actions** (push / PR). Brakes: `--dry-run`
stops before integration; the loop halts after a max round count (default 6) rather than push an
un-clean change. This deliberately overrides the human-supervised model of `/codex-architect` +
`/codex-review` — use those when you want to drive each step yourself. Requires `gh` (GitHub CLI)
authenticated for the integration step.

### Workflow-mode repos

If a repo's dev lifecycle is itself a Claude Code **Workflow** (`.claude/workflows/*.js` or `.mjs`), a subagent
can't run it. For those repos `/codex-issue` **composes** (after approval): a wrapper workflow
(`workflows/codex-wrap.js`, run from the main thread) brackets the repo's **own** workflow — called
with `noLand: true` so its full pipeline runs with all gates intact — with the Codex architect plan +
review, then lands. Between the architect plan and the repo workflow, Claude authors its **own**
file-by-file implementation plan (the developer implements that; the architect review still checks
against the architect plan); both plans are saved under `.codex/plans/` as durable artifacts.
`grep noLand` is only candidate discovery: `/codex-issue` treats a workflow as
composable only if it actually reads `args.noLand` (or destructures `noLand` from `args`) in code and its
no-land path returns `terminal: "ready_to_land"` with `branch` and `base_sha`. Otherwise it falls back to
main-thread mode. The contract and full design are in [`docs/WORKFLOW-MODE.md`](docs/WORKFLOW-MODE.md).

Run **`/codex-compose-setup`** to arrange the contract automatically: it adds the `noLand` seam to your
existing workflow (shown as a diff for approval) or scaffolds a composition-ready starter if you have
none. `noLand` is not an Anthropic-standard arg, so the repo's workflow must read it — that's what setup
does. (Plugin install can't touch your repos; setup is per-repo.)

## CLI verb reference

All verbs are invoked as `node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs <verb>` and print one JSON
object on stdout.

| Verb | Purpose |
|---|---|
| `doctor` | Report Codex version, auth presence, thread count. |
| `start [--cwd <p>] [--model <m>] [--resume-latest \| --resume <uuid>] [--private] [--sandbox <s>] [--approval-policy <p>] [--ephemeral]` | Boot the session daemon, open/resume a thread. `--private` keeps it out of the global state file. |
| `plan "<prompt>" [--effort ultra] [--approval-policy untrusted]` | Plan-mode (read-only architect) turn. |
| `send "<prompt>" [--effort <e>] [--mode default] [--approval-policy untrusted]` | Default/review turn (prompt-based). |
| `review [--base <ref\|sha> \| --scope <auto\|working-tree\|branch>]` | **Native git-scoped commit review** (`review/start`) — the built-in reviewer, no prompt. Needs a `--sandbox read-only --approval-policy never --ephemeral` session. |
| `wait [--timeout-ms <N>]` | Block until the turn completes or parks a question/approval. |
| `answer --id <qid> (--option <n> \| --text "<s>")` | Answer a parked question (`--option` is 1-based). |
| `approve --decision allow\|deny` | Answer a parked exec/file approval. |
| `read [--out <path>]` | Return the last assistant message (plan or review); `--out` also writes it (relative paths resolve against the daemon's cwd). |
| `interrupt` | Cancel the in-flight turn. |
| `status` | Daemon / thread / turn state (incl. `cwd`). |
| `stop` | Graceful shutdown (kill app-server, remove socket). |

Every verb except `start`/`doctor` accepts `--socket <path>` to address a specific daemon instead of
the global `~/.codex-drive/state.json`. `--flag=value` is not supported (hard error).

For a one-shot review that a shell gate can branch on, use
`scripts/commit-review-round.mjs [--base <sha>]`: it prints the review verbatim, then `STATUS:` and
`SCOPE:` trailer lines, and exits 0 only for a real, non-empty review.

## Development

```bash
node --test test/*.test.mjs          # unit tests (zero-dep)
CODEX_DRIVE_LIVE=1 node --test test/integration.live.test.mjs   # live, needs a logged-in codex
```

Design rationale and protocol notes live in `docs/specs/2026-05-31-codex-drive-design.md`.
The Plan-mode (`collaborationMode`) and clarifying-question (`requestUserInput`) surfaces are
**experimental** in Codex and may drift across versions — re-run `doctor` after upgrading.
