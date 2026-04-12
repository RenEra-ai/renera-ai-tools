# Immigration Plugin v4 — Validation Checklist

## Acceptance criteria

The plugin is v4-ready only when ALL of these are true:

1. **Loads cleanly** — no manifest or hook warnings in debug mode.
2. **Self-sufficient agent** — the main attorney agent completes the full workflow without needing another agent.
3. **Source enforcement works** — T3/T4 answers are blocked when no required official source was actually fetched.
4. **No contradictions** — the skill and agent do not contradict each other on workflow, review mechanism, or commands.
5. **Commands are optional** — no stage in the pipeline depends on slash commands.
6. **Registry-driven** — the authority registry governs source requirements by issue bundle.
7. **TPS helper is narrow** — the TPS/EAD resolver is clearly scoped and fully tested.
8. **Eval set passes** — the plugin passes the 10-case end-to-end eval set.
9. **Traceable answers** — current-law answers are visibly traceable: source → rule → branch → user-specific result.
10. **Controlled workflow** — the plugin behaves like a controlled legal workflow, not a search-and-summarize assistant.
11. **Generalized** — no general-purpose file contains topic-specific content in positions that should be generic. Examples, injected context, domain lists, and branch illustrations cover diverse immigration topics.
12. **Equal registry depth** — the authority registry has equal depth across all 12 issue bundles. No bundle has fewer than 2 Tier 1 sources with full metadata.
13. **Diverse evals** — the end-to-end eval set covers at least 7 distinct issue bundles. Non-TPS scenarios pass with the same pipeline quality as TPS scenarios.

---

## Runtime wiring tests (Layer A)

| Test | How to verify | Expected |
|---|---|---|
| Plugin loads | Enable plugin in Claude Code debug mode | No warnings or errors |
| Hooks register | Check hook registration output | 4 hooks: UserPromptSubmit, PreToolUse, PostToolUse, Stop |
| UserPromptSubmit fires | Send "Until when can I work?" | prompt-gate.py outputs JSON with additionalContext |
| PreToolUse fires | Trigger a WebSearch | web-guard.py outputs JSON |
| PostToolUse fires | Complete a WebFetch | source-trace.py appends to trace file |
| Stop fires | Let agent complete | completion-guard.py checks trace |
| Completion blocking works | Complete T3 answer with no Tier 1 fetch | Exit code 2, block message |
| High-risk detection | Send "I got a deportation notice" | T4 context injected |

---

## Deterministic helper tests (Layer B)

Run: `python3 scripts/test-tps-ead-resolver.py -v`

All existing test scenarios must pass. The resolver is verified for Ukraine TPS;
other countries use the generic path with scope warnings.

---

## End-to-end behavior evals (Layer C)

| # | Scenario | Type | Issue bundle | Key checks |
|---|---|---|---|---|
| 1 | Ukraine TPS EAD with FRN + pending renewal | T3 | tps_ead | Correct branch enumeration, non-stacking, authority set |
| 2 | H-4 EAD renewal — rule status post-litigation | T3 | ead_general | Correct current-status check, auto-extension analysis |
| 3 | Marriage AOS — entered without inspection | T3 | marriage_aos | §245(a) vs §245(i) vs consular process branches |
| 4 | N-400 continuous residence — 8-month trip | T3 | naturalization | Rebuttable presumption analysis, 3yr vs 5yr |
| 5 | Asylum 1-year deadline approaching | T4 | asylum_filing | Deadline exception analysis, attorney referral |
| 6 | Travel while I-485 pending | T3 | advance_parole_travel | Abandonment risk, AP/combo card check |
| 7 | H-1B cap lottery eligibility | T2/T3 | h1b_cap_lottery | Cap-exempt analysis, registration timing |
| 8 | Visa bulletin priority date | T2 | visa_bulletin | Final Action vs Dates for Filing, correct month |
| 9 | Removal — Notice to Appear received | T4 | removal_defense | Elevated attorney warning, bond, relief options |
| 10 | OPT STEM extension requirements | T3 | ead_general | E-Verify, training plan, employer obligations |

### For each eval, verify:

- [ ] Correct type classification (T1/T2/T3/T4)
- [ ] Correct issue bundle identified
- [ ] Correct authority set consulted (from registry)
- [ ] At least one Tier 1 source actually fetched
- [ ] All plausible branches enumerated
- [ ] Missing facts correctly identified
- [ ] Correct branch applied to user facts
- [ ] Answer correctly labeled Final / Conditional / Inconclusive
- [ ] Documentary proof specified
- [ ] Risk notes present
- [ ] Disclaimer included
- [ ] Attorney referral for T4
- [ ] Self-review (Stage 10) completed before showing answer

---

## Generalization verification

For each general-purpose file, confirm no topic-specific content in generic positions:

| File | Check |
|---|---|
| SKILL.md | Stage examples cover 3+ different issue types (not just TPS) |
| immigration-attorney.md | Issue labels, search queries, and branch examples are diverse |
| prompt-gate.py | LIVE_LAW_CONTEXT contains no topic-specific source URLs |
| web-guard.py | REMINDER contains diverse search examples |
| completion-guard.py | TIER1_DOMAINS is the general domain list (not topic-specific paths) |
| authority-registry.json | All 12 bundles have 2+ Tier 1 sources with full metadata |
| ead-work-permits.md | Covers all EAD categories proportionally |
| humanitarian.md | Covers TPS, U4U, DACA, T/U visa, VAWA, SIJS proportionally |
| README.md | Example scenarios span 7+ issue bundles |

---

## Helper criteria for future deterministic scripts

A new deterministic helper script should only be created when ALL of these are true:

1. The subproblem has structured inputs.
2. The output is concrete and testable.
3. Wrong calculation is costly.
4. The same logic recurs often.
5. Coding the helper reduces ambiguity more than it creates maintenance burden.

Good future candidates: unlawful presence bar calculator, N-400 residence/physical
presence calculator, visa bulletin currentness helper, CSPA age-out calculator.

Bad candidates (keep in generic pipeline): "marriage-based immigration strategy,"
"asylum defense options," "best path to green card."
