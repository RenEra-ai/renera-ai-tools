#!/usr/bin/env python3
"""
prompt-gate.py — UserPromptSubmit hook for the immigration-guide plugin.

Reads the incoming prompt from stdin (Claude Code hook JSON), detects
live-law immigration signals, and injects mandatory workflow context via
additionalContext before the agent responds.

Exit codes:
  0   Always — this hook never blocks. It only injects context.
"""

import json
import sys
import os
import re
from typing import Optional

# ---------------------------------------------------------------------------
# Signal sets — general immigration signals across all topic areas
# ---------------------------------------------------------------------------

LIVE_LAW_SIGNALS = [
    # Validity and expiration
    r"\buntil when\b", r"\bstill valid\b", r"\bvalid until\b", r"\bexpir",
    r"\bcan i (still )?work\b", r"\bwork through\b", r"\bwork permit\b",
    # Extensions and renewals
    r"\bauto.?extension\b", r"\bautomatic(ally)? extended?\b", r"\brenewal\b",
    # Fees and processing
    r"\bcurrent fee\b", r"\bcurrent processing\b", r"\bprocessing time\b",
    r"\bhow long (does|will|is)\b",
    # Changes and applicability
    r"\bhas (this )?changed\b", r"\bdid they change\b",
    r"\bdoes this (apply|cover|affect)\b", r"\bam i (covered|eligible)\b",
    r"\bapplies to me\b", r"\bcan i (travel|leave|adjust|file)\b",
    r"\bdeadline\b",
    # Program and status signals (broad coverage)
    r"\btps\b", r"\bead\b", r"\bh-?1b\b", r"\bh-?4 ead\b", r"\bl-?2 ead\b",
    r"\bopt\b", r"\bstem opt\b", r"\bdaca\b", r"\bparole\b",
    r"\badvance parole\b", r"\bvisa bulletin\b", r"\bpriority date\b",
    r"\badjustment of status\b", r"\bnaturaliz", r"\bcitizenship\b",
    r"\basylum\b", r"\bgreen card\b", r"\bperm\b",
    # Forms
    r"\bi-?485\b", r"\bi-?765\b", r"\bi-?130\b", r"\bi-?140\b",
    r"\bi-?589\b", r"\bn-?400\b", r"\bi-?131\b",
    # Legal sources
    r"\bfederal register\b", r"\bre.?registration\b",
    # Removal and court
    r"\bremoval\b", r"\bdeportation\b", r"\bdetained?\b",
    r"\bnotice to appear\b", r"\bimmigration court\b",
]

HIGH_RISK_SIGNALS = [
    r"\bremoval\b", r"\bdeportation\b", r"\bdeported\b", r"\bdetained?\b",
    r"\bice arrested\b", r"\bnotice to appear\b", r"\bimmigration court\b",
    r"\bcriminal\b", r"\bconvicted\b", r"\bprior removal\b",
    r"\border of removal\b", r"\bcredible fear\b", r"\bexpedited removal\b",
    r"\bfraud\b", r"\bmisrepresentation\b",
]

ISSUE_BUNDLE_PATTERNS: dict[str, list[str]] = {
    "tps_ead": [
        r"\btps\b.*\bead\b", r"\bead\b.*\btps\b",
        r"\btps\b.*\b(work permit|work authorization|can i work)\b",
        r"\btemporary protected status\b.*\b(ead|work|extension)\b",
        r"\ba-?12\b", r"\bc-?19\b",
    ],
    "ead_general": [
        r"\bead\b", r"\bwork permit\b", r"\bi-?765\b",
        r"\bwork authorization\b", r"\bemployment authorization\b",
        r"\bh-?4 ead\b", r"\bl-?2 ead\b", r"\bopt\b", r"\bstem opt\b",
        r"\bdaca\b.*\b(ead|work)\b",
    ],
    "h1b_cap_lottery": [
        r"\bh-?1b\b", r"\bh1b\b", r"\bspecialty occupation\b",
        r"\bcap\b.*\blottery\b", r"\blottery\b.*\bcap\b",
        r"\bh-?1b\b.*\b(cap|lottery|registration|extension)\b",
    ],
    "marriage_aos": [
        r"\bmarriage\b.*\b(green card|adjustment|i-?485|i-?130)\b",
        r"\bi-?130\b", r"\bi-?485\b.*\b(spouse|marriage)\b",
        r"\badjustment of status\b.*\bmarriage\b",
        r"\bk-?1\b.*\bvisa\b", r"\bfianc",
        r"\b245\(i\)\b", r"\b245\(a\)\b",
    ],
    "naturalization": [
        r"\bnaturaliz", r"\bcitizenship\b", r"\bn-?400\b",
        r"\bcontinuous residence\b", r"\bphysical presence\b",
        r"\bcivics test\b", r"\boath ceremony\b",
    ],
    "asylum_filing": [
        r"\basylum\b", r"\bi-?589\b", r"\bpersecution\b",
        r"\bcredible fear\b", r"\bwithholding of removal\b",
        r"\bone.?year\b.*\b(deadline|filing)\b",
    ],
    "removal_defense": [
        r"\bremoval\b.*\b(proceedings|defense|order)\b",
        r"\bdeportation\b", r"\bnotice to appear\b", r"\bnta\b",
        r"\bcancellation of removal\b", r"\bvoluntary departure\b",
    ],
    "detention_bond": [
        r"\bdetention\b", r"\bdetained\b", r"\bbond\b.*\b(hearing|immigration)\b",
        r"\bice\b.*\b(custody|detained|arrested)\b",
        r"\bimmigration\b.*\bjail\b",
    ],
    "visa_bulletin": [
        r"\bvisa bulletin\b", r"\bpriority date\b",
        r"\bfinal action date\b", r"\bdates for filing\b",
        r"\bcurrent\b.*\bpriority date\b",
    ],
    "processing_times": [
        r"\bprocessing time\b", r"\bhow long\b.*\b(take|wait)\b",
        r"\bcase status\b", r"\breceipt number\b",
    ],
    "current_fees": [
        r"\bfiling fee\b", r"\bfee\b.*\b(i-|form|uscis)\b",
        r"\bi-?912\b", r"\bfee waiver\b",
        r"\bhow much\b.*\b(cost|file|fee)\b",
    ],
    "advance_parole_travel": [
        r"\badvance parole\b", r"\btravel\b.*\b(i-?485|pending|parole)\b",
        r"\bi-?131\b", r"\bcombo card\b",
        r"\bcan i (travel|leave)\b.*\b(pending|i-?485)\b",
    ],
}

LIVE_LAW_CONTEXT = """
=== IMMIGRATION PLUGIN — WORKFLOW GATE ===
LIVE-LAW IMMIGRATION SIGNAL DETECTED in this prompt.

MANDATORY before writing any substantive immigration content:

1. CLASSIFY: Is this T1 (static process) / T2 (live administrative) /
   T3 (live legal applicability) / T4 (high-risk)?
   When uncertain between T2 and T3, treat as T3.

2. If T3 or T4: run the FULL 10-stage pipeline from the immigration-guide
   skill. Do NOT answer from training knowledge alone.

3. MANDATORY for T3/T4: consult the authority registry for this issue
   bundle and fetch at least one Tier 1 official source BEFORE writing
   any conclusion.

4. For questions with multiple overlapping paths: evaluate ALL branches.
   Do not stop at the first plausible answer. Check for non-stacking rules,
   mutual exclusivity, and overrides.

5. SELF-REVIEW MANDATORY: Before showing the user any T3/T4 conclusion,
   run the full Stage 10 self-review checklist. The answer must pass all
   five checklist categories (A-E) before being shown to the user.
"""

HIGH_RISK_CONTEXT = """
=== HIGH-RISK SITUATION — T4 CLASSIFICATION ===
This message contains signals of a high-stakes immigration situation.

Additional requirements beyond the standard T3 pipeline:
1. Lead with a CLEAR recommendation to consult an immigration attorney
   before taking ANY action.
2. Emphasize free legal resources:
   - AILA Lawyer Search: ailalawyer.com
   - Immigration Advocates Network: immigrationadvocates.org/legaldirectory
3. Do not provide specific legal strategy — provide process information
   and flag all risks.
4. The self-review checklist at Stage 10 must pass before any conclusion.
"""


def detect(text: str, patterns: list[str]) -> bool:
    text_lower = text.lower()
    return any(re.search(p, text_lower) for p in patterns)


def detect_issue_bundle(text: str) -> Optional[str]:
    """Return the best-matching issue bundle name, or None."""
    text_lower = text.lower()
    # tps_ead is checked first; if TPS+EAD co-occur, prefer tps_ead over ead_general
    for bundle, patterns in ISSUE_BUNDLE_PATTERNS.items():
        if any(re.search(p, text_lower) for p in patterns):
            return bundle
    return None


def main():
    raw = sys.stdin.read().strip()
    prompt_text = ""
    try:
        data = json.loads(raw)
        prompt_text = (
            data.get("prompt") or data.get("message") or
            data.get("content") or str(data)
        )
    except (json.JSONDecodeError, ValueError):
        prompt_text = raw

    is_high_risk = detect(prompt_text, HIGH_RISK_SIGNALS)
    is_live_law = is_high_risk or detect(prompt_text, LIVE_LAW_SIGNALS)
    bundle = detect_issue_bundle(prompt_text) if is_live_law else None

    # Reset the trace file on every new prompt and ALWAYS write an explicit
    # classification marker. A "NONE" tier lets completion-guard distinguish
    # "prompt-gate ran and decided non-live-law" (safe to pass) from "no
    # marker at all" (prompt-gate failed or never ran — fail-safe to block).
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA", "/tmp")
    trace_path = os.path.join(plugin_data, "source_trace.jsonl")
    from datetime import datetime, timezone
    if is_live_law:
        marker = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "type": "classification",
            "tier": "T4" if is_high_risk else "T3",
            "bundle": bundle,
        }
    else:
        marker = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "type": "classification",
            "tier": "NONE",
        }
    # Unlink the previous turn's trace before writing so a failed reset can
    # never leave stale classification data. Each step is independently
    # swallowed: if unlink fails (e.g. directory is read-only), the
    # subsequent open("w") can still truncate-in-place when the file itself
    # is writable — which is the common read-only-directory case.
    # If the file itself is also read-only, completion-guard's trace-file
    # writability probe catches the stale marker and fails safe.
    try:
        os.makedirs(plugin_data, exist_ok=True)
    except OSError:
        pass
    try:
        os.unlink(trace_path)
    except OSError:
        pass
    try:
        with open(trace_path, "w", encoding="utf-8") as f:
            f.write(json.dumps(marker) + "\n")
    except OSError:
        pass

    if not is_live_law:
        print(json.dumps({"additionalContext": None}))
        sys.exit(0)

    context_parts = [LIVE_LAW_CONTEXT]
    if is_high_risk:
        context_parts.append(HIGH_RISK_CONTEXT)
    if bundle:
        context_parts.append(
            f"\nDETECTED ISSUE BUNDLE: {bundle}\n"
            f"Consult data/authority-registry.json for the mandatory sources "
            f"for this bundle before proceeding to Stage 3."
        )

    print(json.dumps({"additionalContext": "\n".join(context_parts)}))
    sys.exit(0)


if __name__ == "__main__":
    main()
