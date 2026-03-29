---
name: imm-intake
description: >
  Build CaseFacts for an immigration question. Collects what is known, identifies
  what is unknown, and flags which unknown facts are outcome-determinative (i.e.,
  would change the legal result if different). Produces no legal conclusion —
  fact-gathering only. Run this before /imm-authorities on any T3 or T4 question.
user-invocable: true
disable-model-invocation: true
---

> **Optional utility.** This command is for manual step-by-step execution
> and debugging. The main immigration-attorney agent does not depend on it.


# /imm-intake — Case Fact Gathering

**Purpose:** Build CaseFacts only. No legal conclusion at this stage.

You are collecting the factual record before any legal analysis. Think of this
as the intake sheet a paralegal fills out before the attorney reviews the file.

---

## Universal facts to collect

For any immigration question, gather and record:

| Fact | Status |
|---|---|
| Current immigration status (visa type, pending application, undocumented) | known / unknown |
| Country of nationality | known / unknown |
| Location (inside or outside the U.S.) | known / unknown |
| Entry method (entered with visa/at port of entry, paroled, entered without inspection) | known / unknown |
| Goal — what outcome does the user need | known / unknown |
| Timeline pressures (expiring status, upcoming hearings, travel plans) | known / unknown |
| Dependents and their statuses | known / unknown |
| Complicating factors (criminal history, prior removals, overstays, prior denials) | known / unknown |

---

## EAD / work-permit additional facts

When the question involves an EAD, work authorization, or "can I still work":

| Fact | Status |
|---|---|
| EAD category code printed on the card (e.g., A12, C19) | known / unknown |
| Printed expiration date on the face of the card | known / unknown |
| Whether a renewal Form I-765 was filed | known / unknown |
| If renewal filed: receipt date (from Form I-797C) | known / unknown |
| Whether the renewal was filed during the TPS re-registration window | known / unknown |
| Whether USCIS has already approved and issued a replacement EAD | known / unknown |
| If replacement issued: printed expiry on the new card | known / unknown |

---

## Output format

Produce this structured output before any legal analysis:

```
CASE FACTS — [DATE]

KNOWN FACTS
  • [fact] — [value]
  • [fact] — [value]

UNKNOWN FACTS
  • [fact] — [why it matters, in plain language]
  • [fact] — [why it matters]

OUTCOME-DETERMINATIVE UNKNOWNS
  These are the facts whose answers would change the legal result:
  1. [fact] — if [value A] → one outcome; if [value B] → different outcome
  2. [fact] — [explanation]

QUESTION FOR THE USER (ask only 1-2 at a time)
  [The most important unknown to resolve first]

NEXT STEP
  [ ] All decisive facts known → proceed to /imm-authorities
  [ ] Waiting for user response on: [specific fact]
```

---

## Rules for this stage

- Do not give any legal conclusion at this stage — not even a preliminary one.
- Do not ask more than 2 questions at a time. Prioritize outcome-determinative ones.
- If the user has already provided all outcome-determinative facts in their original
  message, skip the question and proceed directly to /imm-authorities.
- Mark facts as unknown only when they genuinely are — do not re-ask for facts
  the user has already provided in the conversation.
