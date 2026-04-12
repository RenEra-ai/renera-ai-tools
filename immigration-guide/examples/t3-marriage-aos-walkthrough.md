# Worked Example: T3 — Marriage-Based AOS with Entry Without Inspection

> This example demonstrates the full 10-stage pipeline applied to a common
> T3 immigration question. Load this file the first time you run the pipeline
> to see how each stage builds on the previous one.

**User prompt:** "My spouse is a U.S. citizen. I entered the U.S. without
inspection in 2018. Can I get a green card?"

---

## Stage 1 — CaseFacts

| Fact | Status | Value |
|---|---|---|
| Petitioner's immigration status | Known | U.S. citizen spouse |
| Entry method | Known | Without inspection (EWI) |
| Year of entry | Known | 2018 |
| Current location | Known | Inside the U.S. |
| Goal | Known | Lawful permanent residence (green card) |
| Criminal history | Unknown | — |
| Prior removals or orders of removal | Unknown | — |
| Immigrant petition filed before April 30, 2001 | Unknown | — |
| Military family member (active duty, veteran, reservist) | Unknown | — |
| Dependent children or other beneficiaries | Unknown | — |
| Advance parole travel since 2018 | Unknown | — |

---

## Stage 2 — Precise issue label

"Marriage-based AOS — entered without inspection (EWI), checking §245(a)
eligibility, §245(i) grandfathering, and parole-in-place as alternative paths."

---

## Stage 3 — AuthoritySet

| Source | Tier | URL (verify current) |
|---|---|---|
| USCIS Policy Manual, Vol. 7, Part B (Adjustment of Status) | T1 | uscis.gov/policy-manual/volume-7-part-b |
| USCIS — Green Card for Immediate Relatives of U.S. Citizens (I-485) | T1 | uscis.gov/green-card/green-card-eligibility/green-card-immediate-relative |
| USCIS — Parole in Place for Military Families | T1 | uscis.gov/humanitarian/parole/parole-in-place |

No T2 or T3 sources consulted at this stage. All URLs must be verified from
current official sources before citing to the user.

---

## Stage 4 — RuleObjects

```json
[
  {
    "id": "R1",
    "cite": "INA §245(a)",
    "rule": "An alien may adjust status to lawful permanent resident if they were inspected and admitted or paroled into the United States. EWI entrants do not meet the inspected-and-admitted requirement and are generally ineligible for adjustment.",
    "conditions": ["inspected and admitted OR paroled", "eligible immigrant visa immediately available", "admissible"],
    "outcome": "AOS inside U.S. approved"
  },
  {
    "id": "R2",
    "cite": "INA §245(i)",
    "rule": "Notwithstanding §245(a), an alien may adjust status if an immigrant visa petition (I-130 or labor certification) was filed on their behalf on or before April 30, 2001, and the petition was approvable when filed.",
    "conditions": ["qualifying petition filed on/before April 30, 2001", "petition approvable when filed", "$1,000 penalty fee paid"],
    "outcome": "AOS inside U.S. approved despite EWI"
  },
  {
    "id": "R3",
    "cite": "USCIS Parole-in-Place policy (military families)",
    "rule": "USCIS may grant parole-in-place to an EWI alien who is the spouse, child, or parent of an active-duty service member, veteran, or reservist. A grant of parole constitutes a 'parole' under §245(a), making the alien eligible to adjust status.",
    "conditions": ["immediate family of active-duty military, veteran, or reservist", "no disqualifying criminal history or national security concern"],
    "outcome": "Creates §245(a) eligibility; AOS inside U.S. becomes available"
  }
]
```

---

## Stage 5 — Conflict note

"These are alternative paths to the same benefit (adjustment of status). They
do not stack. The user qualifies for whichever path's conditions are met.
§245(a) is excluded by EWI unless another mechanism provides a lawful admission
(parole-in-place, advance parole). §245(i) is a narrow historical exception
requiring a pre-2001 petition — most people in this scenario will not qualify."

---

## Stage 6 — Branches

| Branch | Condition | Status |
|---|---|---|
| A: §245(a) — inspected entry | Entered with inspection or parole | NOT APPLICABLE — user entered without inspection |
| B: §245(i) grandfathered | Immigrant petition filed on/before 4/30/2001 | CONDITIONAL — depends on unknown fact |
| C: Consular processing abroad | No §245(i), no parole-in-place | APPLICABLE if no other path — triggers unlawful presence bar analysis |
| D: Parole-in-place (military) | Immediate family of active-duty, veteran, or reservist | CONDITIONAL — depends on unknown fact |

---

## Stage 7 — MissingFacts

**Question 1 (decides Branch B vs. C):**
"Was an immigrant visa petition (Form I-130) or labor certification filed on
your behalf — or on behalf of a family member who could pass it to you — on
or before April 30, 2001?"

**Question 2 (decides Branch D):**
"Is your U.S. citizen spouse, or any other immediate family member, currently
serving in the U.S. military, a veteran, or in the Reserves or National Guard?"

These are the only two facts needed to identify which branch applies. Do not
proceed to Stage 8 without them (or explicit user confirmation they cannot
provide the answers).

---

## Stage 8 — Apply branch

**Assumed answers:** No petition filed before 2001. Not a military family.

Branch C applies: the user cannot adjust status inside the United States.
They must consular process — obtain an immigrant visa at a U.S. consulate
abroad — then enter as a lawful permanent resident.

**Critical warning triggered:**
The user has been in the U.S. unlawfully since 2018 — over one year of
unlawful presence. Departing the U.S. triggers the **10-year bar** under
INA §212(a)(9)(B)(i)(II). The user cannot simply leave and attend a consular
interview without triggering this bar.

**Available remedy:**
The user may file Form **I-601A (Provisional Unlawful Presence Waiver)**
*before* departing. If approved, the waiver covers the unlawful presence bar
and the user can depart, attend the consular interview, and return as a
lawful permanent resident. The waiver requires showing extreme hardship to
the U.S. citizen spouse.

**Sequence:**
1. U.S. citizen spouse files I-130 (immigrant petition).
2. User files I-601A provisional waiver (must be approved before departure).
3. NVC processes case; consular interview scheduled.
4. User departs, attends interview, re-enters as LPR.

---

## Stage 9 — Draft answer

---

**Situation**

You entered the U.S. without inspection in 2018 and your spouse is a U.S.
citizen. You want to know whether you can get a green card.

**Authorities checked**

- USCIS Policy Manual, Vol. 7, Part B (INA §245(a) and §245(i))
- USCIS — Green Card for Immediate Relatives of U.S. Citizens
- USCIS — Parole in Place for Military Families

**Rules**

INA §245(a) requires that you were *inspected and admitted or paroled* to
adjust status inside the U.S. Because you entered without inspection, you
do not meet this requirement. Two exceptions were checked: §245(i)
grandfathering (requires a petition filed before April 30, 2001 — not
applicable here) and parole-in-place for military families (not applicable
here). The available path is consular processing abroad.

**Branches considered**

Four paths were evaluated. Only consular processing applies given your
answers. See Stage 6 above for the full branch table.

**Conclusion**

*Conditional conclusion:* If you have no criminal history and no prior
removal orders, you are likely eligible for a green card through consular
processing — but you cannot simply leave and attend an interview.

*Final conclusion (given your facts):* You must (1) have your spouse file an
I-130, (2) apply for and receive approval of an I-601A provisional waiver
*before* you depart, and then (3) attend a consular interview abroad. Departing
without an approved waiver will trigger a 10-year bar that prevents your return.

**Why**

You have accumulated more than one year of unlawful presence. Under INA
§212(a)(9)(B)(i)(II), departing after one year of unlawful presence triggers
a 10-year bar to re-entry. The I-601A waiver, if approved before departure,
covers this bar.

**Documentary proof you will likely need**

- Evidence of bona fide marriage (joint finances, lease, photos, correspondence)
- I-130 approval notice
- Evidence of extreme hardship to U.S. citizen spouse (for I-601A)
- Medical exam (Form I-693 equivalent, done abroad at consular stage)
- Police clearances from countries of residence

**Risk notes**

- DO NOT LEAVE THE U.S. until the I-601A is approved.
- Any criminal history — even arrests without convictions — must be disclosed
  and reviewed before filing.
- If you have any prior removal orders, the analysis changes significantly.
- USCIS policy on parole-in-place eligibility has changed over time; verify
  current policy if military family status is later confirmed.

**When a lawyer is important**

This situation — EWI, substantial unlawful presence, 10-year bar, and a
provisional waiver — is one where an immigration attorney's review is strongly
recommended before taking any action, particularly before the U.S. citizen
spouse files the I-130 or before any travel.

*This is general information, not legal advice. Immigration law changes
frequently. Verify all information from current official sources.*

---

## Stage 10 — Self-review

| Check | Result | Note |
|---|---|---|
| A. Does the answer address what the user actually asked? | PASS | Directly answers "can I get a green card" with a conditional yes and a clear path |
| B. Is every rule cited to a real, identified source? | PASS | Three T1 USCIS sources identified; URLs flagged for verification |
| C. Are all branches acknowledged, including inapplicable ones? | PASS | All four branches shown with disposition in Stage 6 and Stage 9 |
| D. Is the unlawful-presence / departure bar warning prominent? | PASS | Surfaced in Stage 8, repeated in risk notes, bolded in conclusion |
| E. Is the uncertainty flagged and lawyer referral included? | PASS | Criminal history and prior removals flagged as unknowns; lawyer referral in Stage 9 |
