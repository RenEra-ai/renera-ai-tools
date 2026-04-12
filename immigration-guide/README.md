# Immigration Guide Plugin v4

A controlled legal-research pipeline for U.S. immigration self-help. This plugin
turns Claude Code into a disciplined immigration paralegal — not a search-and-summarize
engine. It classifies questions, collects current official sources, extracts
structured rules, enumerates competing branches, identifies decisive missing facts,
and self-reviews before showing any conclusion.

## What this plugin covers

- **Employment visas:** H-1B (cap, lottery, extensions), L-1, O-1, TN, E-2, PERM, EB categories
- **Family-based immigration:** Marriage green cards (I-130, I-485, K-1), consular processing
- **Work permits / EAD:** All categories — AOS pending (c)(9), asylum (c)(8), TPS (a)(12), DACA (c)(33), H-4 (c)(26), L-2, OPT/STEM OPT, and others
- **Humanitarian programs:** TPS, U4U parole, humanitarian parole, parole-in-place, DACA, T visa, U visa, VAWA, SIJS
- **Naturalization:** N-400, continuous residence, physical presence, good moral character
- **Asylum:** Affirmative and defensive, 1-year deadline, withholding of removal
- **Removal defense:** NTA, voluntary departure, cancellation of removal, prosecutorial discretion
- **Detention and bond:** Mandatory vs. discretionary detention, bond hearings, conditions

## Architecture

```
immigration-guide/
├── .claude-plugin/
│   └── plugin.json                          # Manifest (v1.0.0)
├── agents/
│   ├── immigration-attorney.md              # Main agent — fully self-sufficient
│   └── immigration-reviewer.md              # Optional manual QC only
├── commands/
│   ├── imm-intake.md                        # Optional utility — build CaseFacts
│   ├── imm-authorities.md                   # Optional utility — fetch sources
│   ├── imm-extract-rules.md                 # Optional utility — extract rules
│   ├── imm-branch-analysis.md               # Optional utility — enumerate branches
│   ├── imm-apply-rules.md                   # Optional utility — apply branch
│   └── imm-ead-tps-check.md                 # Optional utility — TPS EAD workflow
├── skills/
│   └── immigration-guide/
│       ├── SKILL.md                         # Workflow source of truth (10-stage pipeline)
│       └── references/
│           ├── asylum-defense.md
│           ├── detention.md
│           ├── ead-work-permits.md           # All EAD categories, not just TPS
│           ├── employment-visas.md
│           ├── humanitarian.md               # TPS, U4U, DACA, T/U visa, VAWA, SIJS
│           ├── marriage-based.md
│           └── naturalization.md
├── hooks/
│   └── hooks.json                           # 4 event hooks
├── scripts/
│   ├── prompt-gate.py                       # UserPromptSubmit — classify + inject
│   ├── web-guard.py                         # PreToolUse — nudge targeted queries
│   ├── source-trace.py                      # PostToolUse — log fetched URLs
│   ├── completion-guard.py                  # Stop — block unsourced T3/T4 answers
│   ├── tps-ead-resolver.py                  # Narrow deterministic helper (TPS EAD only)
│   └── test-tps-ead-resolver.py             # Unit tests for the resolver
├── data/
│   └── authority-registry.json              # 12 issue bundles with mandatory sources
├── README.md
└── VALIDATION.md
```

## How it works

### Question classification

| Type | Example | Workflow |
|---|---|---|
| T1 — Static process | "What is Form I-130?" | Load reference file → answer |
| T2 — Live administrative | "Current I-485 processing time?" | Fetch official source → answer |
| T3 — Live legal applicability | "Can I adjust status through my spouse?" | **Full 10-stage pipeline** |
| T4 — High-risk | "I got a Notice to Appear" | **Full pipeline + attorney warning** |

### The 10-stage pipeline (T3 / T4)

1. **CaseFacts** — extract and categorize user facts
2. **Issue label** — precise sub-issue identification
3. **AuthoritySet** — collect Tier 1 sources (authority registry driven)
4. **RuleObjects** — extract structured rules from sources
5. **Conflict check** — detect overlaps, contradictions, overrides
6. **Branch enumeration** — list all plausible outcomes
7. **MissingFacts** — identify decisive unknowns
8. **Apply branch** — match facts to rules
9. **Draft answer** — structured response format
10. **Self-review** — mandatory checklist (A–E) before showing user

### Hook enforcement

| Event | Script | Purpose |
|---|---|---|
| UserPromptSubmit | `prompt-gate.py` | Classify and inject workflow requirements |
| PreToolUse | `web-guard.py` | Nudge targeted queries for Tier 1 sources |
| PostToolUse | `source-trace.py` | Log actual fetched URLs and search queries |
| Stop | `completion-guard.py` | Block T3/T4 answers without Tier 1 source |

### Authority registry

The registry (`data/authority-registry.json`) defines mandatory sources for
12 issue bundles:

`tps_ead`, `ead_general`, `visa_bulletin`, `current_fees`, `processing_times`,
`h1b_cap_lottery`, `advance_parole_travel`, `marriage_aos`, `naturalization`,
`asylum_filing`, `removal_defense`, `detention_bond`

Each bundle specifies Tier 1 sources, minimum source count, volatility, and
when each source is mandatory. The pipeline consults this before fetching.

### Deterministic helpers

The TPS/EAD resolver (`scripts/tps-ead-resolver.py`) is a narrow deterministic
helper for one structured subproblem: TPS-based EAD automatic extension branch
selection. It handles non-stacking logic, cap logic, and documentary proof paths.
It is NOT the plugin's general legal engine — all other topics use the generic
10-stage reasoning pipeline.

Future deterministic helpers should only be created when all five criteria are met:
structured inputs, concrete testable output, costly wrong calculation, high
repetition, and code reduces ambiguity more than it creates maintenance.

Good candidates: unlawful presence bar calculator, N-400 residence calculator,
visa bulletin currentness helper, CSPA age-out calculator.

### Commands

All commands are **optional utilities** for manual step-by-step execution and
debugging. The main agent does not depend on them.

### Reviewer agent

The `immigration-reviewer` agent is **optional manual QC**. The main attorney
agent includes built-in self-review (Stage 10). The reviewer is never called
automatically — invoke it from the main thread when you want a second opinion.

## Running the resolver

```bash
python3 scripts/tps-ead-resolver.py \
  --country "Ukraine" \
  --category "A12" \
  --card-expiry "2024-10-19" \
  --renewal-filed "yes" \
  --renewal-receipt "2024-08-15" \
  --in-reregistration "yes" \
  --frn-extension-date "2026-04-19" \
  --hr1-extension-date "2026-07-01" \
  --tps-through-date "2026-10-19" \
  --replacement-ead "no"
```

## Running resolver tests

```bash
python3 scripts/test-tps-ead-resolver.py -v
```

## Example scenarios

| # | Scenario | Type | Key issue |
|---|---|---|---|
| 1 | Ukraine TPS EAD with competing extension paths | T3 | Branch enumeration, non-stacking |
| 2 | H-4 EAD renewal during H-1B extension | T3 | H-4 EAD rule status, auto-extension |
| 3 | Marriage AOS — spouse entered without inspection | T3 | §245(a) vs §245(i) vs consular processing |
| 4 | N-400 with 8-month trip abroad | T3 | Continuous residence presumption |
| 5 | Asylum 1-year deadline approaching | T4 | Deadline exception, attorney referral |
| 6 | Advance parole travel while I-485 pending | T3 | Abandonment risk, combo card |
| 7 | H-1B cap lottery question | T2/T3 | Cap-exempt analysis, registration timing |
| 8 | Visa bulletin priority date question | T2 | Final Action vs Dates for Filing |
| 9 | Removal — Notice to Appear received | T4 | Elevated attorney warning, bond eligibility |
| 10 | OPT STEM extension employer requirements | T3 | E-Verify, training plan, reporting |

## Legal disclaimer

> ⚠️ This plugin provides general immigration information, not legal advice.
> Immigration law changes frequently. For your specific situation, consult a
> licensed immigration attorney.
> - [AILA Lawyer Search](https://www.ailalawyer.com)
> - [Immigration Advocates Network](https://www.immigrationadvocates.org/legaldirectory)

## Version history

| Version | Changes |
|---|---|
| 1.0.0 | Initial release. Controlled legal-research pipeline with 10-stage workflow, 12-bundle authority registry, 4 enforcement hooks, TPS EAD resolver with 32-test suite, 7 reference files covering all major immigration topics. |
