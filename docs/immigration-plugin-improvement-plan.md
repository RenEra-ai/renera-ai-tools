# Immigration Plugin Improvement Plan

## Goal

Transform the existing immigration plugin from a **search-and-summarize guide** into a **controlled legal-research workflow** that behaves more like a careful human lawyer or senior paralegal:

1. identify the exact legal issue;
2. pull the right current authorities first;
3. compare overlapping rules;
4. detect when multiple valid outcomes are possible;
5. ask only the missing facts needed to resolve the branch;
6. apply the rule set to the user’s actual case;
7. review the draft answer before showing it.

This plan assumes the plugin already exists and should be **modified**, not rebuilt from scratch.

---

## The core problem to solve

The current plugin already does useful things:
- it routes by category;
- it tells the agent to always web-search current USCIS information;
- it tells the agent to gather some key user facts;
- it tells the agent to synthesize across multiple reference files.

But the current architecture still has a fatal weakness:

> It forces retrieval, but it does **not** force layered rule application.

That means the agent can still do this bad sequence:
- find one USCIS update;
- stop too early;
- give a partially correct answer;
- miss that another authority changes the result;
- fail to ask the one missing fact that determines which branch applies.

For immigration, that is exactly where human legal reasoning matters.

---

## Concrete example: why the current approach is still not enough

A weak answer to the Ukraine TPS EAD question is:

> "Your EAD is automatically extended through April 19, 2026 if you have Ukraine TPS category A12 or C19 with a covered prior expiration date."

That is incomplete.

A stronger human-style analysis is:

1. read the Ukraine TPS country page / Federal Register logic;
2. read the generic USCIS automatic EAD extension rules for TPS after H.R. 1;
3. notice that USCIS says a person may qualify for **more than one** automatic extension path;
4. notice that the person may use the extension that reaches the **furthest future date**, but may **not stack** them;
5. notice that no extension can pass the TPS designated-through date;
6. ask for the user facts needed to pick the right branch.

So the plugin must be designed to reach conclusions like:
- April 19, 2026;
- a later date such as July 2026 based on the H.R. 1 automatic-extension path;
- the date on a newly approved replacement EAD;
- or no current automatic extension at all.

That is the architectural target.

---

## Target operating model

The plugin should stop behaving like:

`question -> search -> summarize -> answer`

It should instead behave like:

`question -> classify issue -> build fact state -> collect current authorities -> extract rule objects -> compare overlapping rules -> identify unresolved branches -> ask for missing branch facts -> apply rules to user facts -> draft answer -> review answer -> final answer`

This is the game-changing shift.

---

## Architectural principle

Do **not** solve this by making prompts longer.

Solve it by enforcing a **decision pipeline**.

The plugin should treat every substantive immigration question as a structured reasoning task with explicit intermediate states.

### Required internal states

For each substantive question, the agent should build these internal objects:

1. `CaseFacts`
2. `IssueTree`
3. `AuthoritySet`
4. `RuleObjects`
5. `ConflictResolution`
6. `BranchConditions`
7. `MissingFacts`
8. `AppliedConclusion`
9. `DraftAnswer`
10. `ReviewFindings`
11. `FinalAnswer`

If one of these stages is missing, the answer should not be considered complete.

---

## What to change in the plugin

## 1. Reframe the main agent from “researcher” to “issue resolver”

The main agent should no longer be told merely to:
- search current sources;
- combine them with references;
- respond.

Instead, the main agent should be told that for **every live-law or case-specific question**, it must:

1. classify the issue;
2. identify whether the question is static or live-law;
3. build a fact checklist;
4. gather current authorities in source-priority order;
5. extract the operative rule from each authority;
6. compare rules for overlap or conflict;
7. identify all plausible legal branches;
8. determine which user facts are required to choose the branch;
9. ask only for the missing decisive facts;
10. apply the selected rule path to the user’s case;
11. send the result to a reviewer;
12. only then answer.

The model should be explicitly forbidden from stopping after the first useful page.

---

## 2. Separate stable knowledge from volatile law

The reference files should not be treated as current law.

They should be split conceptually into two categories:

### A. Stable knowledge
Use reference files for:
- vocabulary;
- category mapping;
- process overviews;
- common forms;
- common evidence types;
- recurring warnings;
- issue spotting;
- question-generation logic.

### B. Volatile knowledge
Do **not** trust reference files alone for:
- fees;
- processing times;
- active program availability;
- active TPS designations;
- filing windows;
- auto-extension dates;
- current policy changes;
- country-specific notices;
- temporary implementation rules.

The current reference files are useful as legal-process memory, but they should not be the final authority for current outcomes.

---

## 3. Introduce explicit source priority and conflict resolution

The plugin must resolve current-law questions using a fixed authority hierarchy.

## Recommended authority order

### Tier 1 — controlling / primary
- statute or enacted law when relevant;
- Federal Register notices;
- USCIS country-specific program pages;
- USCIS form instructions;
- USCIS I-9 Central when the issue is employment-verification handling;
- USCIS policy manual when applicable;
- EOIR / DOJ / DOS official sources when the topic belongs there.

### Tier 2 — official but more general or explanatory
- general USCIS explainer pages;
- alerts and newsroom notices;
- FAQs.

### Tier 3 — secondary
- AILA practice alerts;
- nonprofit immigration explainers;
- trusted legal commentary.

### Hard rule
Secondary sources may clarify, but they may not override official sources.

### Conflict rule
When sources appear to conflict, the agent must explicitly compare:
- source type;
- source date;
- whether the rule is general or country-specific;
- whether the rule is statutory, notice-based, or page-level guidance;
- whether the rule applies to all applicants or only to a subset.

The plugin must produce a brief conflict note before answering.

---

## 4. Create rule objects instead of prose summaries

For each current authority, the agent should extract a structured rule object.

Example structure:

```json
{
  "authority_name": "USCIS Automatic Employment Authorization Document (EAD) Extension",
  "authority_type": "USCIS official guidance",
  "date_checked": "YYYY-MM-DD",
  "topic": "TPS-based EAD automatic extension",
  "rule_text_summary": "TPS-based EAD renewals pending or filed on or after July 22, 2025 may receive up to 1 year or the duration of TPS, whichever is shorter.",
  "conditions": [
    "renewal Form I-765 pending or filed on or after July 22, 2025",
    "timely filed during TPS re-registration window",
    "A12 or C19 category",
    "TPS maintained"
  ],
  "limits": [
    "cannot extend beyond TPS designated-through date"
  ],
  "notes": [
    "user may qualify for more than one extension path but cannot stack them"
  ]
}
```

This matters because it forces the model to separate:
- the rule;
- the conditions;
- the cap/limit;
- the special notes.

That is much safer than prose-only reasoning.

---

## 5. Add a mandatory branch-resolution stage

This is the most important new stage.

After rule extraction, the plugin must ask:

> “What different valid outcomes are possible, and which user facts decide among them?”

For every live case-specific question, the agent must produce:

### A. Possible branches
A numbered list of all plausible outcomes.

### B. Branch-deciding facts
The specific facts needed to choose between them.

### C. Missing decisive facts only
Only ask questions that actually change the result.

If the decisive fact is unknown, the answer must remain conditional.

The plugin must not pretend certainty.

---

## 6. Add a reviewer agent

Create a second agent whose only job is to audit the main agent’s draft.

### Name
`immigration-reviewer`

### Role
Check whether the draft answer is actually supported by the gathered authorities and user facts.

### Reviewer checklist
The reviewer must fail the answer if any of these are true:
- no current official source was checked for a live-law question;
- the answer used only one authority when multiple overlapping authorities were needed;
- the answer skipped a branch that could change the result;
- the answer failed to ask for a decisive missing fact;
- the answer used a generic rule without checking whether a country-specific rule modifies it;
- the answer merged extension paths that cannot legally be stacked;
- the answer gave a date without stating why that date applies to this user;
- the answer did not state confidence or uncertainty where needed;
- the answer included a current-law claim not tied to a source.

### Reviewer output format
The reviewer should return one of:
- `PASS`
- `FAIL`

If `FAIL`, it must return:
- missing authority;
- missing fact;
- wrong rule application;
- unsupported conclusion;
- exact correction needed.

The main agent must revise and rerun review once.

---

## 7. Add commands that force workflow, not just content

The plugin needs focused commands that can be invoked explicitly and, when appropriate, by Claude itself.

## Recommended commands

### `/imm-intake`
Purpose:
- build `CaseFacts` only;
- identify missing decisive facts;
- no legal conclusion.

Output:
- known facts;
- unknown facts;
- which unknown facts are outcome-determinative.

### `/imm-authorities`
Purpose:
- gather the official current authorities for the exact issue;
- rank them;
- produce source notes.

Output:
- source list;
- source tier;
- date checked;
- why each source matters.

### `/imm-extract-rules`
Purpose:
- convert current authorities into structured rule objects.

Output:
- one rule object per authority.

### `/imm-branch-analysis`
Purpose:
- compare rule objects;
- detect alternate valid outcomes;
- determine which facts decide the branch.

Output:
- possible outcomes;
- deciding facts;
- unresolved questions.

### `/imm-apply-rules`
Purpose:
- apply the selected rule branch to `CaseFacts`.

Output:
- result;
- explanation of why this branch applies;
- what would change the result.

### `/imm-review-answer`
Purpose:
- run the reviewer agent against the current draft.

Output:
- PASS / FAIL;
- correction instructions.

### `/imm-ead-tps-check`
Purpose:
- specialized workflow for TPS-based EAD analysis.

This command should be one of the first specialized workflows implemented because it directly tests the architecture.

---

## 8. Add hooks that prevent shallow legal answers

Use hooks to push the system into the correct workflow before it starts answering.

## Recommended hook behavior

### UserPromptSubmit hook
When the user prompt contains any live-law signal such as:
- current;
- latest;
- extension;
- auto-extension;
- fee;
- processing time;
- TPS;
- parole;
- deadline;
- changed;
- valid until;
- can I still work;

then inject a workflow reminder that requires:
- current authority collection;
- rule extraction;
- branch analysis;
- missing-fact detection;
- review before final answer.

### PreToolUse hook for web tools
If the issue is live-law and the agent tries to answer without fetching at least one primary official source, block or redirect the workflow.

### PostToolUse hook for web tools
Record:
- source checked;
- source type;
- date checked;
- topic;
- candidate rules extracted.

This creates a visible reasoning trail for the next stage.

---

## 9. Rework the skill into a legal workflow controller

The skill should no longer mostly tell Claude to be careful and current.

It should become a controller for how immigration reasoning is performed.

## The skill should explicitly distinguish four question types

### Type 1 — static process question
Example:
- what is Form I-130?
- what documents are usually used for a marriage-based filing?

Use references first. Web check only if needed.

### Type 2 — live administrative question
Example:
- current fee;
- current processing time;
- current filing address;
- latest visa bulletin.

Use official current sources first.

### Type 3 — live legal applicability question
Example:
- does this update apply to me?
- until when can I work?
- am I auto-extended?
- does my entry method block AOS?

This requires full issue-resolution workflow:
- references for spotting;
- official current sources;
- rule extraction;
- branch analysis;
- user-specific application.

### Type 4 — high-risk / attorney-needed question
Example:
- removal defense;
- criminal history;
- fraud;
- prior deportation;
- detention;
- complex asylum deadlines.

The plugin should still help, but must elevate the warnings and recommend counsel more aggressively.

---

## 10. Build a dedicated decision tree for TPS-based EAD questions

This is the best pilot workflow because it exposes the exact weakness you identified.

## Required issue breakdown for TPS EAD analysis

For a TPS-based EAD question, the plugin must check all of these in order:

1. country / designation involved;
2. whether the person is a TPS beneficiary, TPS applicant, parolee, or something else;
3. EAD category on the card;
4. card expiration date on the face of the EAD;
5. whether there is a country-specific Federal Register automatic extension;
6. whether there is an individual notice extension;
7. whether a renewal Form I-765 is pending or was filed, and on what date;
8. whether the renewal was filed during the TPS re-registration period;
9. whether H.R. 1 TPS-based automatic-extension rules apply;
10. whether the person qualifies for more than one extension path;
11. which extension reaches furthest into the future;
12. whether the result is capped by the TPS designated-through date;
13. whether USCIS already approved and issued a new EAD with a later printed expiration date.

If the agent skips any of the above, the result may be wrong.

---

## Example decision logic for the TPS EAD workflow

The plugin should reason using a structure like this:

### Step A — build candidate outcomes
Possible outcomes might include:
- country-specific FRN extension only;
- H.R. 1 TPS-based pending-renewal extension only;
- individual notice extension only;
- more than one path available, choose the furthest date;
- newly approved replacement EAD governs;
- no valid automatic extension.

### Step B — list deciding facts
The command should ask for, or retrieve if already known:
- country;
- EAD category code;
- printed card expiration date;
- whether a renewal I-765 was filed;
- date filed / receipt date;
- whether it was filed during re-registration;
- whether the person still maintains TPS;
- whether there is an individual notice;
- whether USCIS already approved a new EAD.

### Step C — choose the branch
Then the agent should state:
- which branch applies;
- why the other branches do not apply;
- what date governs;
- what document set proves that date for work authorization.

### Step D — explain the result like a lawyer would
The answer should not just say the date.
It should say something like:
- which rule controlled;
- what user facts made it apply;
- what alternate result would apply if one fact were different.

That last part is extremely important.

---

## 11. Change the output format for case-specific legal answers

The current output format is useful, but it is too presentation-oriented.

For live legal applicability questions, use this structure instead:

### 1. Situation I am analyzing
- concise restatement of the user facts the answer depends on.

### 2. Current authorities checked
- source name;
- source type;
- date checked;
- what rule it contributes.

### 3. Rules that may apply
- one bullet per rule object.

### 4. Possible branches
- outcome A;
- outcome B;
- outcome C.

### 5. Missing fact that decides the result
- the 1–2 facts still needed, if any.

### 6. My current conclusion for your case
- actual answer, clearly labeled as:
  - final;
  - conditional;
  - inconclusive pending fact.

### 7. Why this date / result applies
- short causal explanation.

### 8. What document proves it
- what the user should show an employer / agency / officer.

### 9. Risk notes
- what could break the conclusion.

### 10. When a lawyer is especially important
- only when actually relevant.

This makes the reasoning visible and auditable.

---

## 12. Add deterministic helper scripts for narrow legal calculations

Do not try to encode all immigration law in scripts.

Use small deterministic scripts only where they add reliability.

## Recommended first scripts

### `scripts/tps_ead_extension_resolver.py`
Input:
- country;
- category code;
- card expiration date;
- renewal filed?;
- receipt date;
- filed during re-registration?;
- TPS designated-through date;
- FRN extension date;
- individual notice date if any.

Output:
- eligible extension paths;
- furthest valid date;
- cap reason;
- documentary proof set.

### `scripts/fact_gap_checker.py`
Input:
- question type;
- case facts.

Output:
- missing facts ranked by importance.

### `scripts/authority_ranker.py`
Input:
- list of sources.

Output:
- ordered priority;
- conflict warnings;
- notes on general vs country-specific scope.

### `scripts/answer_linter.py`
Input:
- draft answer;
- authority set;
- case facts.

Output:
- unsupported claim warnings;
- missing branch warnings;
- missing source warnings;
- overconfidence warnings.

---

## 13. Reduce risk from stale reference files

Several current reference files contain content that is useful but should not be trusted as current law without live verification.

The plan is not to delete those files.
The plan is to change how they are used.

## Recommended reference-file rule

Each reference file should begin with a short notice such as:

> Use this file for process knowledge, issue spotting, and evidence planning. Do not rely on this file alone for current fees, timelines, active designations, extension dates, filing windows, or active policy rules. Those must be verified from current official sources.

That one change will reduce many wrong answers.

---

## 14. Add explicit “stop and ask” conditions

The plugin must stop and ask a targeted question when the missing fact changes the result.

### Mandatory stop-and-ask cases
- the source rules point to two or more plausible outcomes;
- the user’s category code is unknown;
- the exact card expiration date matters;
- the filing date or receipt date matters;
- the entry method matters;
- the exact relationship / status of spouse or parent matters;
- criminal history could affect eligibility;
- a deadline calculation depends on an exact date.

### Important rule
The agent should ask **only** the minimum number of questions needed to resolve the branch.

---

## 15. Add explicit “conditional answer” mode

When decisive facts are missing, the plugin should still be helpful without pretending certainty.

The answer should say:
- “If X, then result A.”
- “If Y instead, then result B.”
- “The one fact that decides this is Z.”

This is much closer to how a competent lawyer speaks when the record is incomplete.

---

## 16. Implementation phases

## Phase 1 — Prompt / workflow changes
Modify:
- main immigration agent;
- skill instructions;
- EAD reference file header;
- humanitarian reference file header.

Deliverables:
- new issue-resolution workflow;
- source hierarchy;
- branch analysis requirement;
- conditional-answer mode;
- reviewer requirement.

## Phase 2 — Reviewer and commands
Add:
- reviewer agent;
- `/imm-intake`;
- `/imm-authorities`;
- `/imm-extract-rules`;
- `/imm-branch-analysis`;
- `/imm-apply-rules`;
- `/imm-review-answer`;
- `/imm-ead-tps-check`.

## Phase 3 — Hooks and traceability
Add:
- UserPromptSubmit hook;
- PreToolUse / PostToolUse web-tool logic;
- lightweight source log;
- draft answer linting.

## Phase 4 — Narrow helper scripts
Add:
- `tps_ead_extension_resolver.py`;
- `fact_gap_checker.py`;
- `authority_ranker.py`;
- `answer_linter.py`.

## Phase 5 — Evaluation
Test against real scenario prompts until the agent consistently:
- finds the right current authorities;
- does not stop early;
- asks the right missing fact;
- chooses the right branch;
- explains why the result applies.

---

## 17. Acceptance criteria

The plugin should not be considered improved until it passes these tests:

### Legal research quality
- it checks official current sources first for live-law questions;
- it can name which authority controlled the result;
- it can explain why another source did not override that result.

### Case-application quality
- it can identify the exact facts that decide the case branch;
- it asks only outcome-determinative questions;
- it produces conditional answers when decisive facts are missing.

### Review quality
- reviewer catches unsupported dates;
- reviewer catches missing branch analysis;
- reviewer catches when a generic rule was used without checking country-specific guidance.

### TPS EAD pilot quality
For Ukraine TPS EAD scenarios, it must correctly distinguish among at least these cases:
- person only has FRN-based extension to April 19, 2026;
- person also qualifies for H.R. 1 pending-renewal extension to a later date such as July 2026;
- person has a newly approved EAD with printed validity through Oct. 19, 2026;
- person does not qualify for the claimed extension because a required fact is missing.

---

## 18. Immediate next editing targets

These are the first files Claude should modify:

1. `agents/immigration-attorney.md`
   - rewrite role from researcher/synthesizer to issue resolver;
   - add mandatory rule-extraction and branch-analysis stages;
   - add explicit stop-and-ask conditions;
   - require reviewer pass before final answer.

2. `skills/immigration-guide/SKILL.md`
   - rewrite as workflow controller;
   - distinguish static vs live-law vs case-applicability questions;
   - add source hierarchy and conditional-answer mode.

3. `skills/immigration-guide/references/ead-work-permits.md`
   - mark as stable guidance only;
   - add TPS EAD workflow notes;
   - add “do not conclude from this file alone” warning.

4. `skills/immigration-guide/references/humanitarian.md`
   - mark as issue-spotting, not current-law authority;
   - add stronger volatility guidance;
   - direct live questions to current country-specific official sources.

5. add `agents/immigration-reviewer.md`

6. add the command files listed above

7. add helper scripts starting with the TPS EAD resolver

---

## 19. Short instruction block for Claude doing the modifications

Use this as a direct build directive:

> Modify the existing immigration plugin so that it no longer answers live immigration questions through search + summary alone. Implement a controlled legal-research workflow that builds case facts, gathers primary authorities, extracts structured rules, compares overlapping rules, identifies possible legal branches, asks only the missing facts needed to choose the branch, applies the selected rule to the user’s case, and sends the draft to a reviewer agent before answering. Prioritize the TPS/EAD workflow as the first fully implemented example, including the interaction between country-specific Ukraine TPS extension rules, H.R. 1 TPS-based automatic EAD extension rules, non-stacking logic, and the requirement to choose the furthest valid extension that does not exceed the TPS designated-through date.

---

## 20. Reference sources Claude should use while modifying the plugin

### Official Anthropic / Claude docs
- Claude Code plugins
- plugins reference
- slash commands
- subagents
- hooks
- agent skills
- skill authoring best practices

### Official USCIS sources for the TPS EAD pilot workflow
- Ukraine TPS country page
- USCIS automatic EAD extension page
- USCIS I-9 Central TPS Ukraine page
- applicable Federal Register notice(s)

---

## Final recommendation

The main upgrade is not “better immigration content.”
The main upgrade is **case-specific rule selection under controlled workflow**.

That is the real difference between:
- a smart immigration explainer;
- and a plugin that starts to reproduce the useful analytical behavior of a careful human lawyer.
