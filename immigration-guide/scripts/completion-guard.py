#!/usr/bin/env python3
"""
completion-guard.py — Stop hook for the immigration-guide plugin.

Reads the session source trace and checks whether Tier 1 official sources
were actually fetched before the session ends. If a bundle was detected by
prompt-gate, enforces that bundle's minimum_tier1_count from the authority
registry.

Exit codes:
  0   Sources OK — session may complete.
  2   Missing required sources — request revision.
"""

import json
import os
import sys
from pathlib import Path
from shared_constants import TIER1_DOMAINS

BLOCK_MESSAGE_NO_SOURCE = (
    "=== COMPLETION BLOCKED — MISSING TIER 1 SOURCE ===\n\n"
    "The session source trace does not contain a Tier 1 official source.\n\n"
    "For a T3 or T4 immigration answer, at least one Tier 1 source MUST be "
    "fetched and cited before the answer is finalized. Consult the authority "
    "registry for this issue bundle's mandatory sources.\n\n"
    "Required action:\n"
    "1. Identify which Tier 1 source is mandatory for this issue bundle.\n"
    "2. Fetch it now via WebSearch or WebFetch.\n"
    "3. Update the AuthoritySet and re-run Stage 10 self-review.\n"
    "4. Revise the answer with source-backed citations before completing.\n\n"
    "Do NOT present the current draft as a final answer."
)

BLOCK_MESSAGE_BUNDLE = (
    "=== COMPLETION BLOCKED — INSUFFICIENT TIER 1 SOURCES FOR BUNDLE ===\n\n"
    "Issue bundle: {bundle}\n"
    "Required Tier 1 sources: {required}\n"
    "Tier 1 sources fetched: {fetched}\n\n"
    "The authority registry requires at least {required} Tier 1 source(s) for "
    "this issue bundle, but only {fetched} were fetched.\n\n"
    "Required action:\n"
    "1. Consult data/authority-registry.json for the mandatory sources for "
    "bundle '{bundle}'.\n"
    "2. Fetch the missing Tier 1 source(s) now.\n"
    "3. Re-run Stage 10 self-review.\n"
    "4. Revise the answer with source-backed citations before completing.\n\n"
    "Do NOT present the current draft as a final answer."
)

BLOCK_MESSAGE_MISSING_MARKER = (
    "=== COMPLETION BLOCKED — SESSION METADATA MISSING ===\n\n"
    "The session trace has web-fetch entries but no classification marker "
    "from prompt-gate.py. The immigration-guide plugin cannot verify whether "
    "Tier 1 source requirements were met for this turn.\n\n"
    "This usually means the UserPromptSubmit hook failed to run or could not "
    "write to CLAUDE_PLUGIN_DATA.\n\n"
    "Required action:\n"
    "1. Confirm the immigration-guide plugin is enabled and CLAUDE_PLUGIN_DATA "
    "is writable.\n"
    "2. Resend the prompt so prompt-gate.py can classify it correctly."
)


def read_trace(trace_path: str) -> list[dict]:
    entries = []
    try:
        with open(trace_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
    except OSError:
        pass
    return entries


def count_tier1_fetches(entries: list[dict]) -> int:
    """Count distinct Tier 1 domain fetches (not searches)."""
    seen_domains = set()
    for entry in entries:
        url_or_query = entry.get("url_or_query", "")
        entry_type = entry.get("type", "")
        is_fetch = entry_type == "fetch" or "type" not in entry
        if is_fetch:
            for domain in TIER1_DOMAINS:
                if domain in url_or_query:
                    seen_domains.add(domain)
                    break
    return len(seen_domains)


def load_bundle_minimum(bundle_name: str) -> int:
    """Load minimum_tier1_count for a bundle from the authority registry."""
    plugin_root = os.environ.get("CLAUDE_PLUGIN_ROOT", "")
    registry_path = os.path.join(plugin_root, "data", "authority-registry.json")
    if not os.path.isfile(registry_path):
        # Fallback: try relative to this script
        registry_path = str(
            Path(__file__).parent.parent / "data" / "authority-registry.json"
        )
    try:
        with open(registry_path, encoding="utf-8") as f:
            registry = json.load(f)
        bundle = registry.get("authority_bundles", {}).get(bundle_name, {})
        return bundle.get("minimum_tier1_count", 1)
    except (OSError, json.JSONDecodeError, KeyError):
        return 1  # Safe fallback


def main():
    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA", "/tmp")
    trace_path = os.path.join(plugin_data, "source_trace.jsonl")
    entries = read_trace(trace_path)

    classification = None
    bundle_name = None
    for entry in entries:
        if entry.get("type") == "classification":
            classification = entry.get("tier")
            bundle_name = entry.get("bundle")
            break

    source_entries = [e for e in entries if e.get("type") != "classification"]

    # Missing classification marker: prompt-gate did not run or its write
    # failed. Fail safe — if web activity was logged, we can't verify Tier 1
    # requirements for what might be a real T3/T4 turn, so block.
    if classification is None:
        if source_entries:
            print(json.dumps({"decision": "block", "reason": BLOCK_MESSAGE_MISSING_MARKER}))
            sys.exit(2)
        sys.exit(0)

    # Explicit non-live-law marker (tier "NONE", "T1", "T2"): no enforcement.
    # Web fetches during these turns (e.g. unrelated research) never block.
    if classification not in ("T3", "T4"):
        sys.exit(0)

    if not source_entries:
        print(json.dumps({"decision": "block", "reason": BLOCK_MESSAGE_NO_SOURCE}))
        sys.exit(2)

    tier1_count = count_tier1_fetches(source_entries)

    if tier1_count == 0:
        print(json.dumps({"decision": "block", "reason": BLOCK_MESSAGE_NO_SOURCE}))
        sys.exit(2)

    if bundle_name:
        required = load_bundle_minimum(bundle_name)
        if tier1_count < required:
            msg = BLOCK_MESSAGE_BUNDLE.format(
                bundle=bundle_name, required=required, fetched=tier1_count
            )
            print(json.dumps({"decision": "block", "reason": msg}))
            sys.exit(2)

    sys.exit(0)


if __name__ == "__main__":
    main()
