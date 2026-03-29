---
name: imm-ead-tps-check
description: >
  Specialized end-to-end workflow for TPS-based EAD automatic extension analysis.
  Checks all possible extension paths in the correct order, applies non-stacking
  rules, determines the furthest valid date, enforces the TPS designated-through
  date cap, and identifies the required documentary proof combination. Use for any
  question about TPS-based EAD validity, expiration, automatic extension, or what
  documents to show an employer. Covers all TPS-designated countries.
user-invocable: true
disable-model-invocation: true
---

> **Optional utility.** This command is for manual step-by-step execution
> and debugging. The main immigration-attorney agent does not depend on it.


# /imm-ead-tps-check — TPS EAD Extension Workflow

**Purpose:** Complete, ordered analysis of TPS-based EAD automatic extension.
This command exists because TPS EAD questions involve multiple overlapping
extension paths with a non-stacking rule — the exact scenario where a single
web search produces an incomplete and potentially wrong answer.

---

## Required fact checklist (collect before fetching sources)

Work through all 13 factors. Mark each known or unknown. Do not begin source
collection until you have attempted to gather all of these from the conversation.

| # | Factor | Status |
|---|---|---|
| 1 | Country of TPS designation | known / unknown |
| 2 | Whether the person is a TPS beneficiary, TPS applicant, parolee, or other | known / unknown |
| 3 | EAD category code printed on the card (A12? C19? other?) | known / unknown |
| 4 | Printed expiration date on the face of the EAD | known / unknown |
| 5 | Whether a country-specific Federal Register automatic extension notice exists, and if so through what date | to be verified from source |
| 6 | Whether an individual USCIS notice extended this person's specific EAD | known / unknown |
| 7 | Whether a renewal Form I-765 was filed | known / unknown |
| 8 | If renewal filed: receipt date (from Form I-797C) | known / unknown |
| 9 | Whether the renewal was filed during the TPS re-registration window | known / unknown |
| 10 | Whether H.R. 1 TPS-based automatic extension rules apply and what date they produce | to be verified from source |
| 11 | Whether the person qualifies for more than one extension path | to be determined in analysis |
| 12 | Whether the TPS designated-through date caps any extension path | to be verified from source |
| 13 | Whether USCIS already approved and issued a replacement EAD with a later printed date | known / unknown |

If Factor 13 is YES: the printed date on the new card governs. Skip to Branch D.
If Factor 3 is an ineligible category: skip to Branch E.

---

## Mandatory sources to fetch (in order)

### Tier 1 — Required

1. **USCIS country-specific TPS page**
   `uscis.gov/humanitarian/temporary-protected-status/[country]`
   → Collect: EAD category coverage, re-registration dates, TPS designated-through date

2. **USCIS I-9 Central page for this country**
   Search: `site:uscis.gov/i-9-central [country] TPS EAD automatic extension`
   → Collect: I-9 reverification instructions, documentary proof requirements,
     extension through date for employer purposes

3. **Federal Register notice(s)**
   `federalregister.gov` → search for `[country] TPS extension [current year]`
   → Collect: Specific extension through dates, EAD category codes covered,
     re-registration window dates

4. **H.R. 1 TPS extension implementation notice** (if applicable)
   Search: `USCIS "H.R. 1" TPS automatic EAD extension [current year]`
   or: `uscis.gov/newsroom "H.R. 1" TPS EAD`
   → Collect: Whether H.R. 1 applies, what extension date it produces,
     non-stacking rule language

### Tier 2 — Supplement

5. USCIS newsroom for any recent operational updates
6. USCIS FAQs for this TPS designation if available

---

## Branch decision tree

Evaluate branches in this order:

### Branch D — Replacement EAD already issued
**Conditions:** USCIS approved and issued a new EAD card with a later printed expiry.
**Result:** The printed date on the new card governs. No extension calculation needed.
**Proof:** The new EAD card only.
**Eliminate other branches** if Branch D applies.

### Branch E — No valid automatic extension
**Conditions:** Any of the following:
- Category code is not in the eligible set for this country's TPS extension
- TPS was terminated for this country before the card expired
- Person is not a current TPS beneficiary (e.g., still an applicant, or status lapsed)
- Renewal was required and was not filed, and no FRN extension applies
**Result:** No automatic extension. EAD expired on the printed date.
**Proof:** None — person cannot legally work on the expired EAD.

### Branch A — Country-specific FRN extension only
**Conditions:**
- Category code is in the eligible set
- A country-specific Federal Register notice automatically extended EADs through a specific date
- Person maintains TPS status
- No renewal I-765 was filed, OR renewal was filed but H.R. 1 path produces an earlier date
**Result:** EAD extended through the FRN extension date.
**Proof:** Expired EAD card + copy of the Federal Register notice.

### Branch B — H.R. 1 pending-renewal extension only
**Conditions:**
- Category code is in the eligible set
- Renewal I-765 was filed during the TPS re-registration window
- H.R. 1 TPS automatic extension rules apply
- H.R. 1 path produces the furthest date
- Person maintains TPS status
**Result:** EAD extended through the H.R. 1 extension date (up to 1 year from
the I-765 filing or the TPS designated-through date, whichever is earlier).
**Proof:** Expired EAD card + Form I-797C receipt notice for the pending renewal.

### Branch C — Both A and B apply — use furthest date, no stacking
**Conditions:** The person qualifies for both Branch A and Branch B.
**Non-stacking rule:** Choose the branch that reaches the furthest date.
Do not add the two dates together. Do not present both as simultaneously valid.
**Result:** The date from whichever branch reaches further.
**Proof:** The documentary proof set corresponding to the winning branch.

---

## Cap enforcement (mandatory)

After determining the applicable branch and date, apply the TPS designated-through
date cap:

> If the extension date from any branch exceeds the TPS designated-through date
> for this country, the extension is capped at the TPS designated-through date.

State whether the cap was applied and why.

---

## Documentary proof table

| Branch | What to show employer (I-9 reverification) |
|---|---|
| A | Expired EAD card (List A) + Federal Register notice showing the extension date |
| B | Expired EAD card (List A) + Form I-797C receipt notice for the pending I-765 renewal |
| C | The combination corresponding to the branch that reaches further |
| D | New approved EAD card only (the printed date is its own proof) |
| E | No valid proof — person cannot work until new valid EAD is issued |

**Note:** For Branches A and B, the employer must accept the combination as proof
under I-9 rules. The employer cannot demand the card alone or the notice alone.

---

## Output format

```
TPS EAD ANALYSIS — [COUNTRY] — [DATE ANALYZED]

FACT CHECKLIST
  [Table of 13 factors with known/unknown status and values]

SOURCES FETCHED
  [Table: source name, tier, URL, date, rule contributed]

NON-STACKING RULE
  [Confirm whether it applies and which authority states it]

BRANCHES EVALUATED
  Branch A: [APPLICABLE / NOT APPLICABLE / CONDITIONAL] — [one sentence reason]
  Branch B: [APPLICABLE / NOT APPLICABLE / CONDITIONAL] — [one sentence reason]
  Branch C: [APPLICABLE / NOT APPLICABLE] — [applies only if both A and B apply]
  Branch D: [APPLICABLE / NOT APPLICABLE] — [applies only if replacement EAD issued]
  Branch E: [APPLICABLE / NOT APPLICABLE] — [applies if key condition fails]

SELECTED BRANCH: [A/B/C/D/E]

CAP CHECK
  Extension date before cap: [date]
  TPS designated-through date: [date]
  Cap applied: YES / NO
  Final valid-through date: [date]

RESULT
  Your EAD is automatically extended through [DATE].
  (or: No valid automatic extension — your EAD expired on [DATE].)

DOCUMENTARY PROOF
  Present to your employer for I-9 reverification:
  1. [Document]
  2. [Document, if applicable]

SENSITIVITY TEST
  If [specific fact] were [alternative value], [alternative branch] would apply
  instead, producing [alternative result].

RISK NOTES
  [What could break this conclusion]
```

---

## Optional: call the resolver script

If the `scripts/tps-ead-resolver.py` script is available, call it with the
known facts to produce the branch selection and date calculation deterministically:

```bash
python scripts/tps-ead-resolver.py \
  --country "[country]" \
  --category "[A12 or C19]" \
  --card-expiry "[YYYY-MM-DD]" \
  --renewal-filed "[yes/no/unknown]" \
  --renewal-receipt "[YYYY-MM-DD or none]" \
  --in-reregistration "[yes/no/unknown]" \
  --frn-extension-date "[YYYY-MM-DD or none]" \
  --hr1-extension-date "[YYYY-MM-DD or none]" \
  --tps-through-date "[YYYY-MM-DD]" \
  --replacement-ead "[yes/no/unknown]" \
  --replacement-date "[YYYY-MM-DD or none]"
```

The script returns a JSON object with `selected_branch`, `furthest_valid_date`,
`cap_applied`, `documentary_proof`, and `explanation`. Use this as verification
against your manual analysis — the two must agree.
