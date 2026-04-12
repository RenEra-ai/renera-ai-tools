#!/usr/bin/env python3
"""
Unit tests for tps-ead-resolver.py

Covers the 8 required test scenarios from the plugin review, plus the
6 README evaluation scenarios and additional edge cases.

Run:
    python3 test-tps-ead-resolver.py
    python3 test-tps-ead-resolver.py -v   # verbose

All tests are self-contained. No external dependencies beyond the resolver
and the standard library.
"""

import json
import subprocess
import sys
import unittest
from datetime import date
from pathlib import Path

# ---------------------------------------------------------------------------
# Import resolve() directly if possible; fall back to subprocess calls.
# ---------------------------------------------------------------------------
RESOLVER_PATH = Path(__file__).parent / "tps-ead-resolver.py"

# Try direct import first (faster, cleaner assertion messages)
# The module uses a hyphenated filename, so we use importlib.
try:
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "tps_ead_resolver", RESOLVER_PATH
    )
    _mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(_mod)
    resolve = _mod.resolve
    parse_date_iso = _mod.parse_date_iso
    USE_DIRECT = True
except (ImportError, FileNotFoundError, AttributeError):
    USE_DIRECT = False


def run_resolver(**kwargs) -> dict:
    """Call resolve() directly or via subprocess, return result dict."""
    if USE_DIRECT:
        date_args = [
            "tps_through_date", "card_expiry",
            "frn_extension_date", "hr1_extension_date", "replacement_date"
        ]
        parsed = {}
        for k, v in kwargs.items():
            if k in date_args:
                parsed[k] = parse_date_iso(v) if v else None
            else:
                parsed[k] = v
        # Fill defaults
        parsed.setdefault("country", "Ukraine")
        parsed.setdefault("tps_through_date", None)
        parsed.setdefault("category", None)
        parsed.setdefault("card_expiry", None)
        parsed.setdefault("renewal_filed", "unknown")
        parsed.setdefault("in_reregistration", "unknown")
        parsed.setdefault("frn_extension_date", None)
        parsed.setdefault("hr1_extension_date", None)
        parsed.setdefault("replacement_ead", "unknown")
        parsed.setdefault("replacement_date", None)
        return resolve(**parsed)
    else:
        args = [sys.executable, str(RESOLVER_PATH)]
        for k, v in kwargs.items():
            flag = "--" + k.replace("_", "-")
            args += [flag, str(v)]
        result = subprocess.run(args, capture_output=True, text=True)
        assert result.returncode == 0, f"Resolver failed: {result.stderr}"
        return json.loads(result.stdout)


# ---------------------------------------------------------------------------
# Review-required test scenarios (8 mandatory from the review)
# ---------------------------------------------------------------------------

class TestReviewRequiredScenarios(unittest.TestCase):
    """The 8 scenarios listed in issue 5.2 of the plugin review."""

    def test_1_frn_only(self):
        """FRN only: Branch A applies, correct date returned."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="no",
            frn_extension_date="2025-04-19",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "A")
        self.assertEqual(r["furthest_valid_date"], "2025-04-19")
        self.assertFalse(r["cap_applied"])
        self.assertIn("A", r["eligible_paths"])
        self.assertNotIn("B", r["eligible_paths"])

    def test_2_hr1_only(self):
        """H.R. 1 only: Branch B applies, renewal in re-reg window, no FRN date."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "B")
        self.assertEqual(r["furthest_valid_date"], "2026-07-15")
        self.assertIn("B", r["eligible_paths"])
        self.assertNotIn("A", r["eligible_paths"])

    def test_3_both_apply_branch_b_wins(self):
        """Both A and B apply; B wins because it reaches further."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2025-04-19",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "C")
        self.assertEqual(r["furthest_valid_date"], "2026-07-15")
        self.assertIn("A", r["eligible_paths"])
        self.assertIn("B", r["eligible_paths"])
        # Non-stacking note should be the first flag
        self.assertIn("non-stacking", r["conditional_flags"][0].lower())

    def test_4_both_apply_branch_a_wins(self):
        """Both A and B apply; A wins because it reaches further."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2027-01-01",
            hr1_extension_date="2026-07-15",
            tps_through_date="2028-01-01",
        )
        self.assertEqual(r["selected_branch"], "C")
        self.assertEqual(r["furthest_valid_date"], "2027-01-01")

    def test_5_cap_applies(self):
        """Cap: extension date exceeds TPS designated-through date."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2025-04-19",
            hr1_extension_date="2027-12-31",
            tps_through_date="2026-10-19",
        )
        self.assertTrue(r["cap_applied"])
        self.assertEqual(r["furthest_valid_date"], "2026-10-19")
        self.assertIsNotNone(r["cap_reason"])
        self.assertIn("2026-10-19", r["cap_reason"])

    def test_6_replacement_ead_overrides(self):
        """Branch D: replacement EAD issued — printed date governs."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            replacement_ead="yes",
            replacement_date="2026-10-19",
            frn_extension_date="2025-04-19",
        )
        self.assertEqual(r["selected_branch"], "D")
        self.assertEqual(r["furthest_valid_date"], "2026-10-19")
        self.assertEqual(r["eligible_paths"], ["D"])
        # No other branch should be computed
        self.assertNotIn("A", r["eligible_paths"])

    def test_7_ineligible_category(self):
        """Branch E: EAD category not eligible."""
        r = run_resolver(
            country="Ukraine",
            category="C09",
            frn_extension_date="2025-04-19",
        )
        self.assertEqual(r["selected_branch"], "E")
        self.assertEqual(r["eligible_paths"], [])
        self.assertIsNone(r["furthest_valid_date"])

    def test_8_unknown_decisive_fact(self):
        """Conditional: re-registration window unknown — conditional flag set."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="unknown",
            frn_extension_date="2025-04-19",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        # Branch A should still be selected (only confirmed path)
        self.assertEqual(r["selected_branch"], "A")
        self.assertEqual(r["furthest_valid_date"], "2025-04-19")
        # But there must be a conditional flag about the re-registration window
        flags_text = " ".join(r["conditional_flags"]).lower()
        self.assertIn("re-registration", flags_text)


# ---------------------------------------------------------------------------
# README evaluation scenarios (6 from the README)
# ---------------------------------------------------------------------------

class TestREADMEScenarios(unittest.TestCase):

    def test_readme_1_no_renewal_frn_only(self):
        """README #1: Ukraine A12, no renewal, FRN = Apr 19 → A → 2026-04-19"""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="no",
            frn_extension_date="2026-04-19",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "A")
        self.assertEqual(r["furthest_valid_date"], "2026-04-19")

    def test_readme_2_renewal_in_window_hr1_wins(self):
        """README #2: Ukraine A12, renewal in window, HR1 = Jul 15 → C (B wins) → 2026-07-15"""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2026-04-19",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "C")
        self.assertEqual(r["furthest_valid_date"], "2026-07-15")

    def test_readme_3_replacement_ead(self):
        """README #3: Replacement EAD issued Oct 19 → D → 2026-10-19"""
        r = run_resolver(
            country="Ukraine",
            replacement_ead="yes",
            replacement_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "D")
        self.assertEqual(r["furthest_valid_date"], "2026-10-19")

    def test_readme_4_ineligible_category(self):
        """README #4: Category C9 (not eligible) → E → no extension"""
        r = run_resolver(
            country="Ukraine",
            category="C9",
            frn_extension_date="2026-04-19",
        )
        self.assertEqual(r["selected_branch"], "E")
        self.assertIsNone(r["furthest_valid_date"])

    def test_readme_5_unknown_reregistration_conditional(self):
        """README #5: Renewal filed, unknown if in re-reg window → A (conditional) → 2026-04-19 + flag"""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="unknown",
            frn_extension_date="2026-04-19",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "A")
        self.assertEqual(r["furthest_valid_date"], "2026-04-19")
        # Must have re-registration conditional flag
        flags_text = " ".join(r["conditional_flags"]).lower()
        self.assertIn("re-registration", flags_text)

    def test_readme_6_hr1_capped(self):
        """README #6: HR1 date exceeds TPS through-date → C (capped) → 2026-10-19"""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2026-04-19",
            hr1_extension_date="2027-12-31",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "C")
        self.assertEqual(r["furthest_valid_date"], "2026-10-19")
        self.assertTrue(r["cap_applied"])


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

class TestEdgeCases(unittest.TestCase):

    def test_replacement_ead_without_date_produces_flag(self):
        """Replacement EAD = yes but no date → conditional flag, not Branch D result."""
        r = run_resolver(
            country="Ukraine",
            replacement_ead="yes",
            frn_extension_date="2025-04-19",
        )
        # Should NOT return Branch D cleanly; should flag the missing date
        flags_text = " ".join(r["conditional_flags"]).lower()
        self.assertIn("replacement", flags_text)
        # Branch D should not be cleanly selected without the date
        self.assertNotEqual(r["selected_branch"], "D")

    def test_no_paths_at_all(self):
        """No FRN date, renewal=no → Branch E."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="no",
        )
        self.assertEqual(r["selected_branch"], "E")

    def test_unknown_country_emits_scope_warning(self):
        """Unknown country → scope_warning present and generic category set used."""
        r = run_resolver(
            country="Venezuela",
            category="A12",
            frn_extension_date="2025-09-01",
        )
        self.assertIn("scope_warning", r)
        self.assertIn("Venezuela", r["scope_warning"])
        # Branch A should still work with FRN date provided
        self.assertEqual(r["selected_branch"], "A")

    def test_unknown_country_hr1_flagged(self):
        """Unknown country → H.R. 1 eligibility is flagged as unknown."""
        r = run_resolver(
            country="Venezuela",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2025-09-01",
            hr1_extension_date="2026-03-01",
        )
        flags_text = " ".join(r["conditional_flags"]).lower()
        self.assertIn("h.r. 1", flags_text)

    def test_non_stacking_note_first_flag(self):
        """Non-stacking note is the first conditional flag when both branches apply."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2025-04-19",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        self.assertTrue(len(r["conditional_flags"]) >= 1)
        self.assertIn("non-stacking", r["conditional_flags"][0].lower())

    def test_documentary_proof_present_for_branch_b(self):
        """Branch B result should include receipt notice in documentary_proof."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "B")
        proof_text = " ".join(r["documentary_proof"]).lower()
        self.assertIn("i-797c", proof_text)
        self.assertIn("receipt", proof_text)

    def test_iso_date_only_rejects_ambiguous_format(self):
        """parse_date_iso should reject MM/DD/YYYY — ambiguous format not allowed."""
        if not USE_DIRECT:
            self.skipTest("Requires direct import to test parse_date_iso")
        with self.assertRaises(ValueError):
            parse_date_iso("04/19/2025")

    def test_category_alias_normalization(self):
        """(C)(19) alias should resolve to C19 and be treated as eligible."""
        r = run_resolver(
            country="Ukraine",
            category="(C)(19)",
            frn_extension_date="2025-04-19",
            renewal_filed="no",
        )
        # Should not hit Branch E for ineligible category
        self.assertNotEqual(r["selected_branch"], "E")
        self.assertIn("A", r["eligible_paths"])

    def test_renewal_not_in_reregistration_no_branch_b(self):
        """Renewal filed but NOT during re-registration → Branch B excluded."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="no",
            frn_extension_date="2025-04-19",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        self.assertNotIn("B", r["eligible_paths"])
        self.assertEqual(r["selected_branch"], "A")

    def test_c_branch_proof_uses_winning_branch_proof(self):
        """Branch C should use proof from the winning branch (B in this case)."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2025-04-19",
            hr1_extension_date="2026-07-15",
            tps_through_date="2026-10-19",
        )
        self.assertEqual(r["selected_branch"], "C")
        proof_text = " ".join(r["documentary_proof"]).lower()
        # Winning branch is B, so proof should include receipt notice
        self.assertIn("i-797c", proof_text)

    def test_no_tps_through_date_skips_cap(self):
        """No TPS through-date provided → cap logic skipped entirely."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2025-04-19",
            hr1_extension_date="2099-12-31",
        )
        self.assertEqual(r["selected_branch"], "C")
        self.assertEqual(r["furthest_valid_date"], "2099-12-31")
        self.assertFalse(r["cap_applied"])

    def test_equal_extension_dates_picks_first(self):
        """When FRN and HR1 dates are equal, Branch C selects one deterministically."""
        r = run_resolver(
            country="Ukraine",
            category="A12",
            renewal_filed="yes",
            in_reregistration="yes",
            frn_extension_date="2026-07-15",
            hr1_extension_date="2026-07-15",
            tps_through_date="2027-01-01",
        )
        self.assertEqual(r["selected_branch"], "C")
        self.assertEqual(r["furthest_valid_date"], "2026-07-15")
        self.assertIn("A", r["eligible_paths"])
        self.assertIn("B", r["eligible_paths"])


# ---------------------------------------------------------------------------
# Structural / output contract tests
# ---------------------------------------------------------------------------

class TestOutputContract(unittest.TestCase):
    """Ensure all required output fields are always present."""

    REQUIRED_FIELDS = [
        "selected_branch",
        "furthest_valid_date",
        "cap_applied",
        "cap_reason",
        "eligible_paths",
        "documentary_proof",
        "conditional_flags",
        "explanation",
        "scope_warning",
    ]

    def _run_basic(self, **kwargs):
        return run_resolver(country="Ukraine", category="A12", **kwargs)

    def _check_fields(self, result):
        for field in self.REQUIRED_FIELDS:
            self.assertIn(field, result, f"Missing required field: {field}")

    def test_branch_a_has_all_fields(self):
        r = self._run_basic(renewal_filed="no", frn_extension_date="2025-04-19")
        self._check_fields(r)

    def test_branch_b_has_all_fields(self):
        r = self._run_basic(
            renewal_filed="yes", in_reregistration="yes",
            hr1_extension_date="2026-07-15",
        )
        self._check_fields(r)

    def test_branch_c_has_all_fields(self):
        r = self._run_basic(
            renewal_filed="yes", in_reregistration="yes",
            frn_extension_date="2025-04-19", hr1_extension_date="2026-07-15",
        )
        self._check_fields(r)

    def test_branch_d_has_all_fields(self):
        r = run_resolver(country="Ukraine", replacement_ead="yes", replacement_date="2026-10-19")
        self._check_fields(r)

    def test_branch_e_has_all_fields(self):
        r = self._run_basic(renewal_filed="no")
        self._check_fields(r)

    def test_selected_branch_always_one_of_valid_values(self):
        for scenario in [
            dict(renewal_filed="no", frn_extension_date="2025-04-19"),
            dict(renewal_filed="yes", in_reregistration="yes", hr1_extension_date="2026-07-15"),
            dict(renewal_filed="no"),
        ]:
            r = self._run_basic(**scenario)
            self.assertIn(r["selected_branch"], {"A", "B", "C", "D", "E"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
