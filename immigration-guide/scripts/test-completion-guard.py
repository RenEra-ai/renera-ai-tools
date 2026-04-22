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
PROMPT_GATE_PATH = SCRIPT_DIR / "prompt-gate.py"
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
    """Missing classification marker always blocks — the only honest signal
    about whether enforcement should have run is prompt-gate's marker, and
    its absence means we cannot verify T3/T4 compliance."""

    def test_missing_marker_with_fetch_blocks(self):
        write_trace(self.trace_dir, [
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://www.uscis.gov/tps"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("SESSION METADATA MISSING", out)

    def test_missing_marker_with_non_tier1_fetch_blocks(self):
        write_trace(self.trace_dir, [
            {"type": "fetch", "tool": "WebFetch",
             "url_or_query": "https://froy.com/x"},
        ])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("SESSION METADATA MISSING", out)

    def test_missing_marker_empty_trace_blocks(self):
        """Empty trace in writable storage blocks — prompt-gate should have
        written a marker. Absence means the hook did not run."""
        write_trace(self.trace_dir, [])
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("SESSION METADATA MISSING", out)

    def test_no_trace_file_blocks(self):
        """No trace file at all in writable storage blocks — same reasoning
        as the empty-trace case."""
        rc, out = run_hook(self.trace_dir)
        self.assertEqual(rc, 2)
        self.assertIn("SESSION METADATA MISSING", out)


class TestStaleTraceFailSafe(unittest.TestCase):
    """Regression: stale classification data must not survive into a new
    turn when the plugin directory or trace file loses write permission
    between turns. The reviewer reproduced the bypass by seeding a stale
    tier=NONE marker, locking the directory to 0555, then issuing a
    live-law prompt plus a non-Tier-1 fetch — the old NONE marker
    survived and completion-guard exited 0."""

    def test_readonly_dir_prompt_gate_replaces_stale_marker_in_place(self):
        """The reviewer's exact scenario. prompt-gate cannot unlink the
        stale trace in a 0555 directory, but open("w") on the existing
        file still truncates it (write perm is on the file, not the dir).
        The new T3 marker must overwrite the stale NONE."""
        tmp = tempfile.mkdtemp(prefix="stale-readonly-dir-")
        try:
            trace_path = Path(tmp) / "source_trace.jsonl"
            trace_path.write_text(
                '{"ts":"2026-01-01T00:00:00+00:00",'
                '"type":"classification","tier":"NONE"}\n'
            )
            os.chmod(tmp, 0o555)
            env = os.environ.copy()
            env["CLAUDE_PLUGIN_DATA"] = tmp
            env["CLAUDE_PLUGIN_ROOT"] = str(PLUGIN_ROOT)
            result = subprocess.run(
                [sys.executable, str(PROMPT_GATE_PATH)],
                input='{"prompt":"can i still work on my TPS EAD"}',
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0,
                             f"prompt-gate failed: {result.stderr}")
            content = trace_path.read_text().strip()
            entries = [json.loads(line) for line in content.splitlines() if line]
            self.assertEqual(len(entries), 1,
                             f"Stale marker survived alongside new marker: {entries}")
            self.assertEqual(entries[0]["tier"], "T3",
                             f"Fresh T3 marker should have replaced stale NONE: {entries[0]}")
            self.assertEqual(entries[0]["bundle"], "tps_ead")
        finally:
            os.chmod(tmp, 0o755)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_readonly_dir_end_to_end_blocks_unsourced_t3(self):
        """Full reproduction of the reviewer's bypass: stale NONE marker,
        directory chmod 0555, new T3 prompt, then a non-Tier-1 fetch.
        After the fix, completion-guard must BLOCK, not exit 0."""
        tmp = tempfile.mkdtemp(prefix="stale-e2e-")
        try:
            trace_path = Path(tmp) / "source_trace.jsonl"
            trace_path.write_text(
                '{"type":"classification","tier":"NONE"}\n'
            )
            os.chmod(tmp, 0o555)
            env = os.environ.copy()
            env["CLAUDE_PLUGIN_DATA"] = tmp
            env["CLAUDE_PLUGIN_ROOT"] = str(PLUGIN_ROOT)
            # Step 1: prompt-gate with a T3 prompt
            subprocess.run(
                [sys.executable, str(PROMPT_GATE_PATH)],
                input='{"prompt":"can i still work on my TPS EAD"}',
                env=env, capture_output=True, text=True, timeout=10,
            )
            # Step 2: simulate source-trace appending a non-Tier-1 fetch
            # (this is valid because the file is still writable even though
            # the directory is read-only)
            with open(trace_path, "a", encoding="utf-8") as f:
                f.write('{"tool":"WebFetch","type":"fetch",'
                        '"url_or_query":"https://froy.com/x"}\n')
            # Step 3: Stop hook fires
            result = subprocess.run(
                [sys.executable, str(HOOK_PATH)],
                input="{}",
                env=env, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 2,
                             "BYPASS REGRESSION: T3 turn with non-Tier-1 fetch "
                             "exited 0; stale NONE marker must not silence "
                             "enforcement. Output: " + result.stdout)
            self.assertIn("MISSING TIER 1 SOURCE", result.stdout)
        finally:
            os.chmod(tmp, 0o755)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_readonly_trace_file_blocks_with_storage_message(self):
        """Narrower case: the directory is writable but the trace file
        itself is read-only (e.g. chmod 0444 on the file). prompt-gate
        cannot truncate it, so a prior turn's marker survives. completion
        -guard's trace-file probe must catch this."""
        tmp = tempfile.mkdtemp(prefix="stale-readonly-file-")
        try:
            trace_path = Path(tmp) / "source_trace.jsonl"
            trace_path.write_text('{"type":"classification","tier":"NONE"}\n')
            os.chmod(trace_path, 0o444)
            env = os.environ.copy()
            env["CLAUDE_PLUGIN_DATA"] = tmp
            env["CLAUDE_PLUGIN_ROOT"] = str(PLUGIN_ROOT)
            result = subprocess.run(
                [sys.executable, str(HOOK_PATH)],
                input="{}",
                env=env, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("PLUGIN STORAGE UNWRITABLE", result.stdout)
        finally:
            try:
                os.chmod(trace_path, 0o644)
            except OSError:
                pass
            shutil.rmtree(tmp, ignore_errors=True)


class TestBrokenStorageFailSafe(unittest.TestCase):
    """Fully broken CLAUDE_PLUGIN_DATA must not bypass enforcement. When the
    directory is unwritable, prompt-gate could not have written the marker
    and source-trace could not have logged fetches — so an empty/absent
    trace is silent failure, not a safe pass."""

    def test_nonexistent_plugin_data_blocks_with_storage_message(self):
        tmp = tempfile.mkdtemp(prefix="completion-guard-broken-")
        try:
            broken = Path(tmp) / "does" / "not" / "exist"
            env = os.environ.copy()
            env["CLAUDE_PLUGIN_DATA"] = str(broken)
            env["CLAUDE_PLUGIN_ROOT"] = str(PLUGIN_ROOT)
            result = subprocess.run(
                [sys.executable, str(HOOK_PATH)],
                input="{}",
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("PLUGIN STORAGE UNWRITABLE", result.stdout)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_readonly_plugin_data_blocks_with_storage_message(self):
        """chmod the directory to read-only; the probe write must fail."""
        tmp = tempfile.mkdtemp(prefix="completion-guard-ro-")
        try:
            os.chmod(tmp, 0o555)
            env = os.environ.copy()
            env["CLAUDE_PLUGIN_DATA"] = tmp
            env["CLAUDE_PLUGIN_ROOT"] = str(PLUGIN_ROOT)
            result = subprocess.run(
                [sys.executable, str(HOOK_PATH)],
                input="{}",
                env=env,
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("PLUGIN STORAGE UNWRITABLE", result.stdout)
        finally:
            os.chmod(tmp, 0o755)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
