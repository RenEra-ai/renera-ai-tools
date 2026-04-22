#!/usr/bin/env python3
"""
Unit tests for completion-guard.py — the Stop hook.

Covers the decision boundary:
  - Non-immigration sessions (tier NONE / T1 / T2) pass through even with
    web activity — regression test for the false-positive bug fixed after
    v1.0.1 where WebFetch to a non-Tier 1 URL could lock a session.
  - T3 / T4 sessions block without Tier 1 sources.
  - Bundle-specific minimum_tier1_count from the authority registry is
    enforced.
  - Missing classification marker fails safe: block when web activity was
    logged (prompt-gate failed), pass when the trace is empty (nothing
    happened).

Run:
    python3 test-completion-guard.py
    python3 test-completion-guard.py -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
HOOK_PATH = SCRIPT_DIR / "completion-guard.py"
PLUGIN_ROOT = SCRIPT_DIR.parent


def write_trace(trace_dir: Path, entries: list) -> Path:
    trace_path = trace_dir / "source_trace.jsonl"
    with open(trace_path, "w", encoding="utf-8") as f:
        for entry in entries:
            f.write(json.dumps(entry) + "\n")
    return trace_path


def run_hook(trace_dir: Path) -> tuple:
    env = os.environ.copy()
    env["CLAUDE_PLUGIN_DATA"] = str(trace_dir)
    env["CLAUDE_PLUGIN_ROOT"] = str(PLUGIN_ROOT)
    result = subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input="{}",
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    return result.returncode, result.stdout


class _HookTestBase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="completion-guard-test-")
        self.trace_dir = Path(self.tmpdir)

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class TestNonImmigrationPassThrough(_HookTestBase):
    """Regression: non-immigration sessions must not block on web activity."""

    def test_none_marker_with_non_tier1_fetch_passes(self):
        """froy.com scenario from the original bug report."""
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "NONE"},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://froy.com/products/x"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 0, f"Expected pass, got block:\n{out}")
        self.assertEqual(out.strip(), "")

    def test_none_marker_with_web_search_passes(self):
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "NONE"},
            {"type": "search", "tool": "WebSearch",
             "url_or_query": "furniture dimensions"},
        ])
        rc, _ = run_hook(self.trace_dir)
        self.assertEqual(rc, 0)

    def test_none_marker_empty_trace_passes(self):
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "NONE"},
        ])
        rc, _ = run_hook(self.trace_dir)
        self.assertEqual(rc, 0)

    def test_t1_marker_with_fetch_passes(self):
        """T1 (static process) sessions are never gated on Tier 1."""
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T1"},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://example.com/x"},
        ])
        rc, _ = run_hook(self.trace_dir)
        self.assertEqual(rc, 0)

    def test_t2_marker_with_fetch_passes(self):
        """T2 (live administrative) sessions are not gated on Tier 1."""
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T2"},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://example.com/x"},
        ])
        rc, _ = run_hook(self.trace_dir)
        self.assertEqual(rc, 0)


class TestT3T4Enforcement(_HookTestBase):
    """T3/T4 sessions must block without Tier 1 sources."""

    def test_t3_no_sources_blocks_no_source_message(self):
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T3", "bundle": None},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("MISSING TIER 1 SOURCE", out)

    def test_t3_non_tier1_only_blocks(self):
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T3", "bundle": None},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://froy.com/x"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("MISSING TIER 1 SOURCE", out)

    def test_t3_search_only_blocks(self):
        """WebSearch entries don't count as Tier 1 fetches."""
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T3", "bundle": None},
            {"type": "search", "tool": "WebSearch",
             "url_or_query": "uscis.gov work permit"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("MISSING TIER 1 SOURCE", out)

    def test_t3_tier1_fetch_no_bundle_passes(self):
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T3", "bundle": None},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://www.uscis.gov/work"},
        ])
        rc, _ = run_hook(self.trace_dir)
        self.assertEqual(rc, 0)

    def test_t4_no_sources_blocks(self):
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T4", "bundle": "removal_defense"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("MISSING TIER 1 SOURCE", out)


class TestBundleEnforcement(_HookTestBase):
    """Bundle minimum_tier1_count from the authority registry is enforced."""

    def test_tps_ead_one_tier1_blocks_bundle_message(self):
        """tps_ead requires 2 Tier 1 sources; 1 should trigger BUNDLE message."""
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T3", "bundle": "tps_ead"},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://www.uscis.gov/tps"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("INSUFFICIENT TIER 1 SOURCES FOR BUNDLE", out)
        self.assertIn("tps_ead", out)

    def test_tps_ead_two_distinct_tier1_passes(self):
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T3", "bundle": "tps_ead"},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://www.uscis.gov/tps"},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://www.federalregister.gov/tps"},
        ])
        rc, _ = run_hook(self.trace_dir)
        self.assertEqual(rc, 0)

    def test_tps_ead_two_same_domain_fails(self):
        """count_tier1_fetches counts distinct domains; duplicates don't help."""
        write_trace(self.trace_dir, [
            {"type": "classification", "tier": "T3", "bundle": "tps_ead"},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://www.uscis.gov/tps"},
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://www.uscis.gov/tps-ukraine"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("INSUFFICIENT TIER 1 SOURCES FOR BUNDLE", out)


class TestMissingMarkerFailSafe(_HookTestBase):
    """Missing classification marker: fail safe when web activity was logged."""

    def test_missing_marker_with_fetch_blocks(self):
        write_trace(self.trace_dir, [
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://www.uscis.gov/tps"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("SESSION METADATA MISSING", out)

    def test_missing_marker_with_non_tier1_fetch_blocks(self):
        """Even non-Tier 1 activity should fail safe when marker is absent."""
        write_trace(self.trace_dir, [
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://froy.com/x"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("SESSION METADATA MISSING", out)

    def test_missing_marker_empty_trace_passes(self):
        """No marker and no activity — nothing to enforce, safe to pass."""
        write_trace(self.trace_dir, [])
        rc, _ = run_hook(self.trace_dir)
        self.assertEqual(rc, 0)

    def test_no_trace_file_passes(self):
        """If the trace file doesn't exist at all, pass silently."""
        rc, _ = run_hook(self.trace_dir)
        self.assertEqual(rc, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
