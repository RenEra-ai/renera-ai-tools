#!/usr/bin/env python3
"""
web-guard.py — PreToolUse hook for WebSearch / WebFetch.

Injects a reminder if the query looks too generic for a live-law
immigration question. Does NOT block — only nudges more precise queries.

Exit codes:
  0   Always — this hook never blocks.
"""

import json
import re
import sys
from shared_constants import TIER1_DOMAINS as OFFICIAL_DOMAINS

GENERIC_QUERY_PATTERNS = [
    r"^(tps|ead|immigration|visa)\s*$",
    r"^(work permit|green card|asylum)\s*$",
    r"^(h-?1b|naturalization|citizenship)\s*$",
    r"^can i work\s*$",
    r"^can i travel\s*$",
    r"^processing time\s*$",
]

REMINDER = (
    "WEB SEARCH REMINDER: For live-law immigration questions, use targeted queries:\n"
    "- Include the current year (e.g., 'USCIS processing times I-485 2026')\n"
    "- Prefer site: qualifiers for Tier 1 sources:\n"
    "  * Policy Manual: site:uscis.gov/policy-manual [topic]\n"
    "  * Visa bulletin: site:travel.state.gov visa bulletin [month] [year]\n"
    "  * Federal Register: site:federalregister.gov [topic] [year]\n"
    "  * EOIR: site:justice.gov/eoir [topic]\n"
    "  * TPS/humanitarian: site:uscis.gov/humanitarian [country/program]\n"
    "  * Processing times: site:uscis.gov processing times [form]\n"
    "- One search result does NOT satisfy the multi-source requirement for T3/T4."
)


def main():
    raw = sys.stdin.read().strip()
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = data.get("tool_name") or data.get("tool") or ""
    tool_input = data.get("tool_input") or data.get("input") or {}
    inject = False

    if tool_name in ("WebSearch", "web_search"):
        query = tool_input.get("query", "")
        if any(re.match(p, query.strip().lower()) for p in GENERIC_QUERY_PATTERNS):
            inject = True
    elif tool_name in ("WebFetch", "web_fetch"):
        url = tool_input.get("url", "")
        if url and not any(d in url for d in OFFICIAL_DOMAINS):
            inject = True

    print(json.dumps({"additionalContext": REMINDER if inject else None}))
    sys.exit(0)


if __name__ == "__main__":
    main()
