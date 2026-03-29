---
name: imm-extract-rules
description: >
  Convert gathered immigration authorities into structured rule objects — one per
  rule, not one per source. Forces explicit separation of rule text, applicability
  conditions, caps/limits, and special notes (such as non-stacking rules). No prose
  summaries at this stage — structured objects only. Run after /imm-authorities.
user-invocable: true
disable-model-invocation: true
---

> **Optional utility.** This command is for manual step-by-step execution
> and debugging. The main immigration-attorney agent does not depend on it.


# /imm-extract-rules — Structured Rule Extraction

**Purpose:** Convert each source in the AuthoritySet into one or more structured
rule objects. This stage forces you to separate what the rule says from when it
applies, what limits it, and what special notes govern it. Prose-only reasoning
at this stage is not acceptable.

---

## Rule object schema

```json
{
  "rule_id": "R1",
  "source": "display name of the source",
  "url": "https://...",
  "date_checked": "YYYY-MM-DD",
  "tier": "Tier 1 / Tier 2 / Tier 3",
  "topic": "precise sub-issue this rule addresses",
  "rule_summary": "one sentence: what the rule says in plain language",
  "conditions": [
    "condition that must be true for this rule to apply",
    "another condition — be specific (e.g., 'renewal I-765 must have been filed during the re-registration window')"
  ],
  "limits": [
    "cap or ceiling on what the rule produces (e.g., 'extension cannot exceed the TPS designated-through date')",
    "another limit if applicable"
  ],
  "notes": [
    "special notes — especially non-stacking rules, interaction with other paths, or facts that modify the rule",
    "e.g., 'person may qualify for more than one extension path but must use the one reaching further, not add them'"
  ]
}
```

---

## How to handle multi-rule sources

A single Federal Register notice or USCIS page often contains multiple distinct rules.
Produce one rule object per rule, not one per source.

Example: A Federal Register notice for Ukraine TPS might contain:
- R1: The general re-registration rules
- R2: The country-specific FRN automatic EAD extension through [date]
- R3: The requirement to carry the expired EAD plus the FRN notice as proof

Produce three separate rule objects for that one source.

---

## Non-stacking rules — treat with special care

If any source contains a non-stacking rule (a rule that says "you may qualify for
more than one extension path but cannot combine them"), flag this explicitly in
the `notes` field of every affected rule object AND produce a standalone summary
after all rule objects:

```
NON-STACKING SUMMARY
This case involves overlapping extension paths. Under [source], a person who
qualifies for both [Path A] and [Path B] must use the one reaching the further
date — they may not be added together or stacked.
```

---

## Condition specificity requirements

Conditions must be specific enough that you can check them against CaseFacts.
Bad condition: "Person must be a TPS holder."
Good condition: "Person must be a current TPS beneficiary with an EAD in category
A12 or C19 and an active TPS designation as of the date of the extension."

---

## Output format

```
RULE OBJECTS — [ISSUE LABEL] — [DATE]

[One JSON block per rule, labeled R1, R2, R3, ...]

EXTRACTION SUMMARY
  Total rules extracted: [N]
  Extension paths identified: [list]
  Non-stacking rule applies: YES / NO
  Cap / ceiling: [describe if applicable]
  Key condition(s) that distinguish paths: [list]

NEXT STEP
  → /imm-branch-analysis
```

---

## Rules for this stage

- Produce structured JSON — no prose summaries instead of objects.
- If you cannot extract a condition precisely, mark it as "UNCERTAIN — requires
  verification against source text" rather than guessing.
- Do not begin writing the user-facing answer at this stage.
- If a source contains no extractable rule relevant to the issue (e.g., a general
  USCIS page that just links to other pages), note that in the Extraction Summary
  and exclude it from the rule objects.
