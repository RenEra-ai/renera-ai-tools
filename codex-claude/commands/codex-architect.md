---
name: codex-architect
description: >-
  Have Codex (GPT-5.x) architect a plan for a task, in Plan mode (read-only), with its
  clarifying questions surfaced to you. Runs the architect half of the codex-claude loop in
  the main thread so you stay in control of every decision. You implement the resulting plan.
argument-hint: <task to architect, e.g. "refactor the auth flow to support SSO">
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
---

Use the **codex-claude** skill to run a **Plan-mode architect turn** with Codex for this task:

> $ARGUMENTS

Drive it in THIS thread (not a subagent), because Plan mode asks clarifying questions that I must
see and decide on. Specifically:

1. Run `doctor`; if Codex isn't installed or logged in, stop and tell me.
2. `start --cwd "$PWD"`, then `plan "<the task above, asking it to inspect the relevant files and
   produce a concrete file-by-file plan>"` with `--effort xhigh`.
3. `wait`. On `status:"question"`, **show me the question and its options**, answer it (from
   context if unambiguous — and tell me what you chose — otherwise ask me), then `wait` again.
   Repeat until `status:"completed"`.
4. `read` the plan and present it to me clearly. **Do not start implementing yet** — wait for my
   go-ahead, then implement it yourself.
5. `stop` the session once I've got the plan (we can start a fresh one for the review later, or
   keep it open if I want to review in the same session).

Follow the skill's verb contract and human-supervision rules exactly.
