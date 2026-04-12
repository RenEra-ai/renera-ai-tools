---
name: imm-branch-analysis
description: >
  Compare extracted rule objects, identify every plausible legal outcome (branch),
  and determine exactly which user facts decide between them. Forces enumeration
  of all possible results before any conclusion is drawn. Identifies the minimum
  set of missing facts needed to choose a branch. Run after /imm-extract-rules.
user-invocable: true
disable-model-invocation: true
---

> **Optional utility.** This command is for manual step-by-step execution
> and debugging. The main immigration-attorney agent does not depend on it.


# /imm-branch-analysis — Branch Enumeration and Fact-Gap Detection

**Purpose:** List every plausible legal outcome, trace each to a rule object,
and identify the user facts that decide between them. No branch may be skipped
because it seems unlikely — it must be explicitly considered and either included
or eliminated with a stated reason.

This stage prevents the single most common failure in immigration research:
stopping at the first plausible answer without checking whether a different set
of facts would produce a different (possibly better) result for the user.

---

## Branch definition

A **branch** is a distinct legal outcome that is plausible given the current
authorities and could apply to the user depending on facts you do or do not yet have.

Each branch must state:
1. What the outcome is (specific and concrete — a date, an eligibility status, a required action)
2. Which rule object(s) produce it (by rule_id)
3. What conditions from those rule objects must be satisfied for this branch to apply
4. What conditions from other rule objects are NOT satisfied (why competing branches don't apply)

---

## Template for each branch

```
BRANCH [letter]: [Short descriptive name]

Outcome: [Specific result — e.g., "EAD automatically extended through April 19, 2026"]

Applies when:
  • [Condition 1 from rule object R?]
  • [Condition 2 from rule object R?]

Does NOT apply if:
  • [Counter-condition — what would exclude this branch]

Rule objects supporting this branch: R?, R?

Status: CONFIRMED APPLICABLE / CONFIRMED NOT APPLICABLE / CONDITIONAL ON [specific fact]
```

---

## Interaction analysis (required)

After listing all branches, explicitly address:

### Overlap
Do any two branches apply simultaneously? If yes:
- State which ones
- State the governing rule (e.g., non-stacking rule — must choose the one reaching further)
- State which branch would "win" under that rule given current facts

### Conflict
Do any two rule objects give conflicting results for the same situation?
- State the conflict
- State which source controls and why (tier, date, specificity)

### Hierarchy
If a country-specific rule and a general rule both apply:
- The country-specific rule governs for that country
- State this explicitly

---

## Branch-deciding facts

After the branch analysis, produce a minimal list of the user facts that remain
unknown and would change which branch applies or what result it produces:

```
BRANCH-DECIDING FACTS STILL UNKNOWN

1. [Fact] — decides between Branch [X] and Branch [Y]
   → If [value A]: Branch X applies, result is [outcome A]
   → If [value B]: Branch Y applies, result is [outcome B]

2. [Fact] — determines the precise date within Branch [X]
   → If [value A]: date is [date A]
   → If [value B]: date is [date B]
```

Only list facts that actually change the branch or the result. Do not list facts
that are interesting but irrelevant to the outcome.

---

## Output format

```
BRANCH ANALYSIS — [ISSUE LABEL] — [DATE]

BRANCHES CONSIDERED

[One block per branch using the template above]

INTERACTION ANALYSIS
  Overlap: [description or "None"]
  Conflict: [description or "None"]
  Hierarchy: [description or "None"]

BRANCH-DECIDING FACTS STILL UNKNOWN
  [List as above, or "None — all decisive facts are known"]

RECOMMENDED NEXT STEP
  [ ] All decisive facts known → proceed to /imm-apply-rules
  [ ] Missing decisive facts → ask the user: [specific question(s)]
      Then return to this stage to update branch status before /imm-apply-rules
```

---

## Rules for this stage

- Every branch identified in the rule objects must appear here, even if you
  believe it does not apply. Mark it CONFIRMED NOT APPLICABLE with a reason.
- If a branch status is CONDITIONAL, do not proceed to /imm-apply-rules
  without first asking the user for the decisive fact.
- Do not write the user-facing answer at this stage.
- Ask the user at most 2 questions at a time. Prioritize the most
  outcome-determinative unknown.
