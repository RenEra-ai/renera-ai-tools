# Bug report — Architect design plan is **paraphrased**, not inlined **verbatim**, into the Codex review

| | |
|---|---|
| **Component** | `codex-claude` plugin — `/codex-issue` autonomous loop (Stage: architect review) |
| **Version** | 1.6.0 (installed cache); source `RenEra-ai/renera-ai-tools@main` |
| **Severity** | **Medium** — latent fidelity / gate-strength bug. No crash; benign in the observed run, but can silently weaken the Stage‑2 review. |
| **Type** | Contract not mechanically enforced (verbatim‑inline relied on model behavior) |
| **Found** | 2026‑06‑04, live `/codex-issue 10` run on `mathkit-codex-test`, by inspecting the actual Codex review session in the UI |
| **Affected files** | `commands/codex-issue.md` (§3, §6), `agents/codex-reviewer.md` (“What you are given”, Step 3); optional: `scripts/review-round.mjs` |

---

## Summary

In the `/codex-issue` loop the architect produces a file‑by‑file design plan, which `plan-round.mjs`
persists **verbatim** to `.codex/plans/issue-<#>.md`. The Stage‑2 architect review is supposed to judge
the implementation against **that** plan. In practice the review judged the implementation against a
**lossy paraphrase** of the plan that the **main thread re‑authored** when it dispatched the
`codex-reviewer` subagent — not against the saved artifact. The plan text travels as free‑form prose
through the dispatch, and nothing in the pipeline forces it to be byte‑identical to the saved file, so
the orchestrating model compressed it from its own understanding.

This is **not** the session‑isolation behavior (the review correctly runs in a fresh ephemeral Codex
session — that is by design and is fine). This is specifically about **plan‑text fidelity**.

## Expected vs. actual

- **Expected:** the `=== ARCHITECT DESIGN PLAN ===` block the review Codex session receives is the
  **verbatim** contents of `.codex/plans/issue-<#>.md` (optionally accompanied by a *separately
  labeled* acceptance‑criteria block).
- **Actual:** the review block was a hand‑condensed summary of the plan, missing details the saved file
  contains.

## Evidence (from the test run)

Divergence between the saved artifact and what the review actually received:

| `.codex/plans/issue-10.md` (architect, verbatim — the saved artifact) | `=== ARCHITECT DESIGN PLAN ===` embedded in the review (main thread’s rewrite) |
|---|---|
| “No new **dependencies**, no README churn, no unrelated formatting.” | “No new **deps**, no README churn, no unrelated formatting.” |
| `_validate_non_negative_int(value**: int**) -> None` | `_validate_non_negative_int(value) -> None` |
| “Rationale: **Python 3.9.6 supports both stdlib functions; they use exact integer arithmetic and avoid unnecessary local loop code.**” | “Rationale: **stdlib funcs use exact integer arithmetic.**” |
| Sections **`Public API`**, **`Test Plan`**, **`Assumptions`** present | all three **dropped** |
| *(no such section)* | **added** an `ISSUE ACCEPTANCE CRITERIA (the authority)` block |

**Where the condensation happened (root‑cause localization):** the *main thread’s* dispatch prompt to
the `codex-reviewer` subagent already contained the paraphrase (verified from the session transcript).
The `codex-reviewer` subagent then forwarded that text into the Codex prompt **unchanged** — it added
nothing and dropped nothing of its own. So the lossy step is **upstream, in the orchestrator**, when it
built the reviewer dispatch instead of pasting the held `$DESIGN`.

## Root cause

The contract *intends* verbatim re‑inlining but never enforces it:

- `commands/codex-issue.md:91` (§3) — “**Read** the plan body from the `PLAN_PATH` it returns; hold it
  as `$DESIGN`.” → `$DESIGN` is defined as the verbatim file body.
- `commands/codex-issue.md:128` (§6) — “Dispatch the **codex-reviewer** subagent (Task) with `$DESIGN`
  (**re-inlined** …).” → intent is to pass `$DESIGN` unchanged.
- `agents/codex-reviewer.md:55` (Step 3) — “…followed by the **PLAN text**.”

“Re‑inline `$DESIGN`” is an instruction interpreted by an LLM orchestrator. With the plan flowing as
prose, the model is free to (and did) re‑author a shorter version from understanding rather than copy
the exact bytes. There is no path that makes verbatim inlining the *only* possible behavior.

## Impact

- **Observed run:** benign. The paraphrase preserved everything load‑bearing (module/function
  structure, validation logic **and order**, the `k > n` short‑circuit, every test tuple, the exact
  rejection lists), and the orchestrator additionally injected the issue’s acceptance criteria, which
  *strengthened* the review. The verdict (`NO ISSUES`) was correct.
- **General risk:** a paraphrase can silently drop a **load‑bearing** constraint. The review then
  cannot enforce a constraint it was never shown, **while still appearing to “judge against the
  plan.”** That defeats the purpose of persisting the plan as a durable, reviewable artifact and
  quietly weakens the Stage‑2 gate. The failure is invisible precisely because the review still
  produces a confident verdict.

## Proposed fix

**Principle:** remove every opportunity for the plan to be re‑authored between “saved to disk” and
“seen by the review.” Pass the **path**, inline the **bytes**.

### Patch A — `commands/codex-issue.md` §6 (pass the path, forbid summarizing)

```diff
-Compute the changed files: `git diff --name-only <START | base_sha>..HEAD` (use `base_sha` in
-Workflow-engine mode, `$START` in main-thread mode). Dispatch the **codex-reviewer** subagent (Task)
-with `$DESIGN` (re-inlined — the reviewer judges against the architect's intent) and the changed-file
-list.
+Compute the changed files: `git diff --name-only <START | base_sha>..HEAD` (use `base_sha` in
+Workflow-engine mode, `$START` in main-thread mode). Dispatch the **codex-reviewer** subagent (Task)
+with the **plan file path** `PLAN_PATH` (`.codex/plans/issue-<#>.md`) — **NOT** the plan prose — and
+the changed-file list. The reviewer reads that file and inlines it **verbatim**. You **MUST NOT**
+summarize, compress, drop sections from, reorder, or re-author the plan when handing it off — doing so
+lets a load-bearing constraint silently vanish before the review ever sees it. You MAY *additionally*
+pass the issue's acceptance criteria, but only as a **separate, clearly-labeled** block — never in
+place of, or merged into, the verbatim plan.
```

### Patch B — `agents/codex-reviewer.md` (read the file, inline verbatim)

“What you are given”:

```diff
-The dispatcher passes you the **changed files / scope** to review, and — when run inside the
-`/codex-issue` loop — the **architect design-plan text** (the approved intent). The plan is
+The dispatcher passes you the **changed files / scope** to review, and — when run inside the
+`/codex-issue` loop — the **path to the architect design-plan file** (`PLAN_PATH`, the approved
+intent). You **Read** that file and inline its **verbatim** contents; never paraphrase it. The plan is
```

Step 3, “With a plan” bullet:

```diff
-     List concrete issues as `file:line` with a fix. END with a verdict on its OWN FINAL line, with
-     NOTHING after it: exactly 'VERDICT: NO ISSUES' or 'VERDICT: ISSUES FOUND'." …followed by the PLAN text.
+     List concrete issues as `file:line` with a fix. END with a verdict on its OWN FINAL line, with
+     NOTHING after it: exactly 'VERDICT: NO ISSUES' or 'VERDICT: ISSUES FOUND'." Then `Read` the file
+     at `PLAN_PATH` and append its **verbatim** contents under a line
+     `=== ARCHITECT DESIGN PLAN (verbatim — do not summarize) ===`. Copy it byte-for-byte: do NOT
+     paraphrase, compress, reorder, or drop sections. If the dispatcher also gave you acceptance
+     criteria, append them under a separate `=== ISSUE ACCEPTANCE CRITERIA ===` header.
```

### Patch C — *(optional, strongest)* `scripts/review-round.mjs` (`--plan-file`, deterministic inlining)

Take the model out of the inlining path entirely: have the driver concatenate the plan file verbatim.

```js
// after reading --prompt-file / argv prompt:
const plf = process.argv.indexOf('--plan-file');
let promptText = prompt;
if (plf >= 0) {
  const planText = readFileSync(process.argv[plf + 1], 'utf8');
  promptText += `\n\n=== ARCHITECT DESIGN PLAN (verbatim) ===\n${planText.trimEnd()}\n`;
}
// ...use promptText for the send()
```

Then `codex-reviewer.md` Step 4 invokes:
`node ${CLAUDE_PLUGIN_ROOT}/scripts/review-round.mjs --prompt-file <body> --plan-file <PLAN_PATH>`.
This guarantees the plan block equals the saved file regardless of model behavior. (Patch C subsumes
the inlining part of Patch B; keep B’s “read PLAN_PATH” wording as the fallback when `--plan-file`
isn’t used.)

**Recommendation:** ship **A + B** now (low risk, doc/agent‑only); add **C** as a follow‑up hardening
so verbatim inlining is enforced by code, not prose.

## Verification

1. Re‑run `/codex-issue <#>` on a sample issue. Capture the prompt the review Codex session receives.
2. Assert the `=== ARCHITECT DESIGN PLAN (verbatim) ===` block is **byte‑identical** to
   `.codex/plans/issue-<#>.md` (modulo trailing‑newline). Any divergence = regression.
3. (If Patch C) add a unit test for `review-round.mjs`: given `--plan-file`, the assembled prompt
   contains the file’s exact bytes.
4. Negative check: confirm a *separately‑labeled* acceptance‑criteria block is still permitted and does
   not contaminate the verbatim plan block.

## Out of scope / explicitly NOT bugs

- **Fresh ephemeral review session** (not the planning session): by design and correct
  (`docs/WORKFLOW-MODE.md:122-123`). Not part of this report.
- **Adding the issue’s acceptance criteria to the review:** a *good* practice — keep it, just as a
  separate labeled block alongside the verbatim plan, never as a replacement for it.
