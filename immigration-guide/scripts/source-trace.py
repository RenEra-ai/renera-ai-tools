#!/usr/bin/env python3
"""
source-trace.py — PostToolUse hook for WebSearch / WebFetch.

Appends a structured log entry to a session-scoped trace file so the
Stage 10 self-review and completion guard can verify which sources were
actually fetched.

Exit codes:
  0   Always — this hook never blocks. It only logs.
"""

import json
import os
import sys
from datetime import datetime, timezone


def main():
    raw = sys.stdin.read().strip()
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = data.get("tool_name") or data.get("tool") or "unknown_tool"
    tool_input = data.get("tool_input") or data.get("input") or {}
    tool_result = data.get("tool_result") or data.get("output") or {}

    if tool_name in ("WebFetch", "web_fetch") or tool_name.endswith("__web_fetch"):
        url_or_query = tool_input.get("url") or str(tool_input)
        entry_type = "fetch"
    elif tool_name in ("WebSearch", "web_search") or tool_name.endswith("__web_search"):
        url_or_query = tool_input.get("query") or str(tool_input)
        entry_type = "search"
    else:
        url_or_query = str(tool_input)
        entry_type = "other"

    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "tool": tool_name,
        "type": entry_type,
        "url_or_query": url_or_query,
        "response_bytes": len(json.dumps(tool_result)),
    }

    plugin_data = os.environ.get("CLAUDE_PLUGIN_DATA", "/tmp")
    trace_path = os.path.join(plugin_data, "source_trace.jsonl")

    try:
        with open(trace_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError:
        pass

    sys.exit(0)


if __name__ == "__main__":
    main()
