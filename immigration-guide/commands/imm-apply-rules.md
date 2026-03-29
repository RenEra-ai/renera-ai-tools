---
name: imm-apply-rules
description: >
  Apply the selected rule branch to the user's CaseFacts and produce a specific,
  sourced conclusion. States which branch applies and why, what the result is,
  which rule object and user facts produce that result, what document combination
  proves it, and what single fact would change the outcome. Run after
  /imm-branch-analysis when all decisive facts are known.
user-invocable: true
disable-model-invocation: true
---

> **Optional utility.** This command is for manual step-by-step execution
> and debugging. The main immigration-attorney agent does not depend on it.


# /imm-apply-rules — Apply Selected Branch to User's Case

**Purpose:** Take the branch selected in /imm-branch-analysis and apply it to
the user's specific known facts to produce a concrete, sourced conclusion. This
stage bridges from legal analysis to the user's actual situation.

---

## Pre-check before applying

Before applying a branch, confirm:

1. All outcome-determinative facts from /imm-branch-analysis are marked **known**.
   If any remain unknown, do not proceed — return to /imm-branch-analysis and
   ask the user first.

2. The selected branch is marked **CONFIRMED APPLICABLE** (not CONDITIONAL).
   If it is still CONDITIONAL, do not proceed.

3. The non-stacking rule has been applied if multiple branches overlapped —
   you are applying the branch that reaches the furthest valid date, not both.

---

## Application logic

Work through this sequence explicitly:

### Step A — State which branch applies
> "Branch [X] applies because [user fact] satisfies [condition from rule R?]
> and [user fact] satisfies [condition from rule R?]."

### Step B — Eliminate competing branches
For each branch NOT selected, state one sentence explaining why:
> "Branch [Y] does not apply because [user fact] does not satisfy [condition from rule R?]."

### Step C — State the result
Be specific. Not "your EAD may still be valid" but "your EAD is automatically
extended through [exact date]" or "no valid automatic extension applies — your
EAD expired on [date]."

If the result is a date: state which rule object and which condition produces
that specific date for this user.

### Step D — State the documentary proof

Specify exactly what the user must present to an employer for I-9 reverification,
or to a USCIS officer, or to an immigration judge. Include every document in
the required combination.

Common proof combinations for TPS EAD automatic extensions:
- **FRN extension:** Expired EAD card + copy of the applicable Federal Register
  notice showing the extension through date
- **H.R. 1 pending-renewal extension:** Expired EAD card + Form I-797C receipt
  notice for the pending renewal I-765
- **Both paths (furthest applies):** The combination corresponding to the
  branch that reaches further
- **Replacement EAD:** The new approved EAD card (its printed date governs;
  no additional documents needed)

### Step E — State the sensitivity test
> "If [one specific user fact] were different — specifically, if [alternative value]
> — then [alternative branch] would apply instead, producing [alternative result]."

This is how a careful paralegal speaks. It tells the user exactly what to watch
for if their situation changes.

---

## Output format

```
RULE APPLICATION — [ISSUE LABEL] — [DATE]

SELECTED BRANCH: Branch [X] — [Name]

WHY THIS BRANCH APPLIES
  [Step A — user facts → rule conditions]

WHY OTHER BRANCHES DO NOT APPLY
  • Branch [Y]: [one sentence]
  • Branch [Z]: [one sentence]

RESULT
  [Specific and concrete — date, eligibility status, required action]

SOURCE OF THIS RESULT
  Rule [R?] from [source name] ([URL]), checked [date].
  Conditions satisfied: [list]

WHAT DOCUMENT PROVES IT
  Present to your employer (for I-9) / USCIS officer / immigration judge:
  1. [Document 1]
  2. [Document 2 if applicable]
  Note: [Any special instructions — e.g., "carry both documents together;
         either alone is insufficient"]

SENSITIVITY TEST
  If [specific fact] were [alternative value], Branch [Y] would apply instead,
  producing [alternative result].

RISK NOTES
  • [What could break this conclusion — e.g., TPS terminated, renewal denied,
    filed outside re-registration window, wrong category code]

CONFIDENCE LEVEL
  FINAL — all decisive facts are known and conditions are satisfied
  (or)
  CONDITIONAL ON [remaining unknown fact] — see above

NEXT STEP
  The attorney agent's Stage 10 self-review validates this output before
  showing the user. If running manually, review against the Stage 10
  checklist (A–E) in SKILL.md.
```

---

## Rules for this stage

- Do not apply a branch if any of its conditions depend on an unknown user fact.
- Do not say "your EAD is valid" without specifying through what date and under
  what authority.
- Do not omit the documentary proof section — this is what the user actually
  needs to show their employer at an I-9 reverification.
- Do not omit the sensitivity test — it is the most useful part for a user whose
  situation may not be exactly as described.
- The attorney agent's Stage 10 self-review validates this output before
  showing the user. If running manually, review against the Stage 10
  checklist (A–E) in SKILL.md before presenting the answer.
