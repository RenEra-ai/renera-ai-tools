---
name: codex-review
description: >-
  Get an independent Codex (GPT-5.x) review of the current changes. Dispatches the codex-impl-reviewer
  subagent, which drives a read-only Codex review on its own isolated session and returns just the
  findings — keeping the verbose wait-loop out of this conversation.
argument-hint: "[files/scope to review — defaults to the current uncommitted diff]"
allowed-tools:
  - Task
  - Bash
  - Read
  - Write
---

Get an independent Codex review of:

> $ARGUMENTS

If no scope was given above, default to the current **uncommitted diff** (run `git status` /
`git diff --stat` to see what changed; if this isn't a git repo, ask me what to review).

**Own the Codex session yourself** — the subagent drives it, but only what you collect from the live
daemon counts. (Why: the harness can silently drop a plugin subagent's identity, in which case the
"Codex review" is the dispatching model reviewing its own diff — see
`docs/bugs/subagent-messages-not-delivered-to-main-thread.md`.)

**Shell variables do NOT survive between Bash calls** (only the working directory does), so each call
below prints the paths it mints and later calls use those **literal absolute paths**.

1. Mint two directories and print them (one Bash call):
   ```bash
   ROOT=$(cd "$(git rev-parse --show-toplevel)" && pwd -P)
   RUN=$(mktemp -d /tmp/cdx-gate-review.XXXXXX)       # STATE — yours alone; the helper never learns it
   SHARE=$(mktemp -d /tmp/cdx-gate-prompts.XXXXXX)    # PROMPTS — the only path the helper gets
   printf 'ROOT=%s\nRUN_DIR=%s\nPROMPT_DIR=%s\n' "$ROOT" "$RUN" "$SHARE"
   ```
   Keeping `start.json` out of the helper's reach is the point: it is the collector's root of trust.
2. Write the complete review brief (scope + what to look for + "END with a verdict on its OWN FINAL
   line: exactly 'VERDICT: NO ISSUES' or 'VERDICT: ISSUES FOUND'") to `<PROMPT_DIR>/prompt`, and the
   full re-ask to `<PROMPT_DIR>/retry`. The daemon accepts **only** these two prompts.
3. Hash both and start the session (one Bash call, literal paths):
   ```bash
   SHA() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
   node ${CLAUDE_PLUGIN_ROOT}/bin/codex-drive.mjs start --private --cwd "<ROOT>" --gate review \
     --gate-prompt-sha256 "$(SHA "<PROMPT_DIR>/prompt")" \
     --gate-retry-prompt-sha256 "$(SHA "<PROMPT_DIR>/retry")" > "<RUN_DIR>/start.json"
   cat "<RUN_DIR>/start.json"
   ```
   Keep that stdout verbatim; take `socket` from it as the literal `<GATE_SOCKET>`. `--gate review`
   binds the session to plain `send` turns — the daemon refuses any other verb before it runs.
4. Dispatch the **codex-impl-reviewer** subagent (Task) — **without a `name`**: passing one puts it in
   teammate mode, where the plugin `subagent_type` is silently dropped and its report never returns.
   Pass the literal `GATE_SOCKET`, `PROMPT_PATH=<PROMPT_DIR>/prompt`,
   `RETRY_PROMPT_PATH=<PROMPT_DIR>/retry`. **Name the verb in your dispatch prompt:
   `send --prompt-file` (the retry too)** — the collector certifies a review gate only from a plain
   `send` (kind `turn`), and the daemon answers a plan turn with
   `{error:"wrong_gate_turn_kind","expected":"send"}` (`docs/bugs/gate-orphaned-completed-turn.md`).
5. ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-attest.mjs collect --state-dir "<RUN_DIR>" --gate review \
     --outcome completed --cwd "<ROOT>" --artifact "<RUN_DIR>/review.md" --prompt "<PROMPT_DIR>/prompt" \
     --salvage "<RUN_DIR>/review.unattested.md"
   ```
   **A Task that errored, was interrupted, or was denied says nothing about the turn** — the daemon
   is detached and the turn completes regardless. Probe `status --socket "<GATE_SOCKET>"` first:
   `turnStatus:"completed"` → collect with `--outcome completed`; `running` → keep `wait`-polling.
   Only a turn you know failed (or are abandoning) gets `--outcome failed` — the daemon is still
   torn down, and the round cannot be certified.

Then:
- `ok:true` → present the findings from **`<RUN_DIR>/review.md`** grouped by severity, each with
  `file:line` and a concrete fix. Say "no issues" **only** for `parsedVerdict: "NO ISSUES"`; report
  `UNCLEAR` as an incomplete review, never as clean.
- `ok:false` → tell me the Codex gate did not run and why (`reason`); do not present a review. If
  `stopped:false`, keep both directories and show the recovery command it printed. If the JSON
  carries `salvaged`, `<RUN_DIR>/review.unattested.md` holds the refused turn's text — show me that
  it exists, but never present it as the review: it is uncertified evidence, not findings.
- Do **not** auto-apply fixes unless I ask — surface them first.
