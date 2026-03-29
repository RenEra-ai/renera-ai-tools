---
name: imm-authorities
description: >
  Gather the current official authorities for the precise immigration issue.
  Fetches sources in Tier 1 priority order (Federal Register, USCIS country-specific
  pages, USCIS I-9 Central, USCIS Policy Manual) before Tier 2 or 3. Records each
  source with its URL, date checked, and the rule it contributes. Must reach at
  least one Tier 1 source before proceeding to rule extraction.
user-invocable: true
disable-model-invocation: true
---

> **Optional utility.** This command is for manual step-by-step execution
> and debugging. The main immigration-attorney agent does not depend on it.


# /imm-authorities — Collect Current Official Sources

**Purpose:** Assemble the AuthoritySet for this precise issue. Sources are the
raw material from which rule objects are extracted in the next stage. Quality
of the final answer is entirely dependent on quality of the sources fetched here.

---

## Authority tier order

Fetch in this order. Do not move to the next tier until you have attempted all
relevant Tier 1 sources.

### Tier 1 — Controlling (fetch these first)

These sources override Tier 2 and 3. A country-specific Tier 1 source overrides
a general Tier 1 source when they conflict.

| Source type | Where to find it | Use for |
|---|---|---|
| Federal Register notices | federalregister.gov — search by agency (DHS, DOL) + topic | TPS designations, fee rules, specific program notices |
| USCIS country-specific TPS pages | uscis.gov/humanitarian/temporary-protected-status/[country] | TPS eligibility, extension dates, EAD category coverage |
| USCIS I-9 Central | uscis.gov/i-9-central | Employment verification, EAD automatic extension proof |
| USCIS Policy Manual | pm.uscis.gov | Policy interpretations for benefits adjudication |
| EOIR/DOJ sources | justice.gov/eoir | Removal proceedings, court procedures, BIA precedents |
| State Dept / travel.state.gov | travel.state.gov | Visa bulletin, consular processing, immigrant visa priority dates |

### Tier 2 — Official but general

Use these to supplement Tier 1, especially when a Tier 1 source lacks detail.

| Source type | Where to find it |
|---|---|
| USCIS general explainer pages | uscis.gov — topic landing pages |
| USCIS newsroom and announcements | uscis.gov/newsroom |
| USCIS FAQs | uscis.gov — search for FAQ pages by form or topic |

### Tier 3 — Secondary (clarify only; never override Tier 1 or 2)

| Source type | Where to find it |
|---|---|
| AILA practice alerts | aila.org (member publication, may appear in search results) |
| Nonprofit explainers | ilrc.org, immigrationadvocates.org |

---

## Search strategies

Use these targeted search patterns:

```
TPS extension dates:       site:uscis.gov "[country] TPS" [current year]
Auto-extension (EAD):      USCIS automatic EAD extension [category code] [current year]
Federal Register notice:   federalregister.gov [country] TPS extension [current year]
I-9 Central (EAD proof):  site:uscis.gov/i-9-central [country] TPS EAD
Fee changes:               USCIS filing fee [form number] [current year]
Policy Manual:             pm.uscis.gov [topic keyword]
Visa bulletin:             travel.state.gov visa bulletin [month] [year]
```

Always include the current year in date-sensitive searches to avoid stale results.

---

## Conflict detection

After fetching, check whether any sources appear to conflict:

- **Same-tier conflict:** Two Tier 1 sources say different things about the same rule.
  → Compare source dates. The more recent and more specific source typically controls.
- **General vs. country-specific conflict:** A general USCIS rule and a country-specific
  notice give different results.
  → The country-specific notice typically controls for that country.
- **Statutory vs. policy conflict:** A statute says one thing; USCIS policy says another.
  → The statute controls; flag this as a potential legal issue requiring attorney review.

---

## Output format

```
AUTHORITY SET — [ISSUE LABEL] — [DATE]

SOURCES COLLECTED

| # | Source name | Tier | URL | Date checked | Rule contributed |
|---|---|---|---|---|---|
| 1 | | Tier 1 | | | |
| 2 | | Tier 1 | | | |
| 3 | | Tier 2 | | | |

TIER 1 MINIMUM SATISFIED: YES / NO
  [If NO: explain what was attempted and why Tier 1 was not reachable.
   Note that proceeding without Tier 1 increases the risk of an incorrect answer.]

CONFLICT NOTE
  [Describe any conflicts between sources, which controls, and why.
   If no conflicts: "No conflicts detected between collected sources."]

NEXT STEP
  → /imm-extract-rules
```

---

## Rules for this stage

- Do not begin writing substantive legal content at this stage.
- Do not move to /imm-extract-rules without at least one Tier 1 source.
- If a Tier 1 URL returns an error or the content is not immigration-relevant,
  try an alternative Tier 1 URL before falling back to Tier 2.
- Record the date you checked each source — this matters for provenance and
  for the reviewer's checklist.
