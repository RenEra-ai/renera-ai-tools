#!/usr/bin/env python3
"""
TPS EAD Automatic Extension Resolver
=====================================
NARROW DETERMINISTIC HELPER — NOT the plugin's general legal engine.

This resolver handles ONE specific structured subproblem: TPS-based EAD
automatic extension branch selection. It exists because that subproblem has
structured inputs, concrete testable outputs, and wrong calculation is costly.

The main immigration-attorney agent handles all other immigration topics
through its generic 10-stage reasoning pipeline. Do not create resolver
scripts for topics that are better handled by the generic pipeline.

Criteria for future deterministic helpers (all must be true):
1. The subproblem has structured inputs.
2. The output is concrete and testable.
3. Wrong calculation is costly.
4. The same logic recurs often.
5. Coding reduces ambiguity more than it creates maintenance burden.

SCOPE NOTICE
------------
This resolver is currently strongest for Ukraine TPS cases under the overlapping
FRN-extension and H.R. 1 pending-renewal-extension framework. The eligibility
categories, re-registration window logic, and extension paths are modeled on
Ukraine TPS Federal Register notices from 2022–2025.

For other TPS-designated countries, this resolver provides the correct
non-stacking and cap logic, but the LLM pipeline must supply country-specific
extension dates and verify category eligibility from the country's own Federal
Register notice before calling this script.

Do not treat this as a general TPS authority. Always verify country-specific
rules from the relevant Federal Register notice.

What this script determines
---------------------------
1. Whether the EAD category is in the eligible set for this country.
2. Whether Branch A (country-specific FRN extension) conditions are satisfied.
3. Whether Branch B (H.R. 1 pending-renewal extension) conditions are satisfied,
   including the re-registration window requirement.
4. Whether Branch D (replacement EAD supersedes) applies.
5. Which branch wins under the non-stacking rule.
6. Whether the TPS designated-through date caps the result.
7. What documentary proof is required for each eligible branch.

What this script does NOT determine
------------------------------------
- Current TPS designated-through dates (fetch from Federal Register / USCIS).
- Country-specific FRN extension dates (fetch from Federal Register notice).
- H.R. 1 specific effective dates (fetch from USCIS newsroom / I-9 Central).
- Whether TPS status itself is still valid for this person.

Usage
-----
python tps_ead_resolver.py [options]

All date arguments must be ISO format: YYYY-MM-DD.
Use "none" or "unknown" for missing values.

Required:
  --country              Country name (e.g., "Ukraine")
  --tps-through-date     TPS designated-through date (YYYY-MM-DD)

Optional:
  --category             EAD category code (e.g., "A12", "C19")
  --card-expiry          Printed card expiration date (YYYY-MM-DD)
  --renewal-filed        Whether renewal I-765 was filed: yes / no / unknown
  --renewal-receipt      Receipt date of renewal I-765 (YYYY-MM-DD)
  --in-reregistration    Whether renewal was filed during re-registration: yes / no / unknown
  --frn-extension-date   Country-specific FRN extension through date (YYYY-MM-DD)
  --hr1-extension-date   H.R. 1 pending-renewal extension date (YYYY-MM-DD)
  --replacement-ead      Whether a replacement EAD was already issued: yes / no / unknown
  --replacement-date     Printed expiry on replacement EAD (YYYY-MM-DD)

Output
------
JSON with:
  selected_branch        "A" | "B" | "C" | "D" | "E"
  furthest_valid_date    "YYYY-MM-DD" | null
  cap_applied            true | false
  cap_reason             string | null
  eligible_paths         list of branch letters
  documentary_proof      list of required documents
  conditional_flags      list of facts still needed for a definitive answer
  explanation            plain-language explanation of the result
  scope_warning          country-specific scope limitation note

Exit codes
----------
  0  Success (result produced — may still be conditional)
  1  Fatal input error (e.g., invalid date format)
"""

import argparse
import json
import sys
from datetime import date, datetime
from typing import Optional


# ---------------------------------------------------------------------------
# Country-specific eligibility configuration
#
# Structure: country_name (lowercase) → {categories, notes}
# Each entry covers the eligible EAD categories for that country's TPS
# extension notices. This must be updated when new Federal Register notices
# change eligible categories.
#
# IMPORTANT: These are based on published Federal Register notices. Always
# verify against the current notice before relying on this data.
# ---------------------------------------------------------------------------
COUNTRY_CONFIGS: dict[str, dict] = {
    "ukraine": {
        "eligible_categories": {"A12", "C19"},
        "notes": "Based on Ukraine TPS Federal Register notices 2022–2025.",
        "frn_source": "federalregister.gov — Ukraine TPS extension notices",
        "hr1_eligible": True,
    },
    # Add additional countries here as their Federal Register notices are
    # reviewed and rule-packed. Until then, the resolver uses a generic path.
}

# Generic fallback — eligible categories that appear in most TPS EAD guidance
GENERIC_ELIGIBLE_CATEGORIES = {"A12", "C19"}

# Normalize common alternate representations
CATEGORY_ALIASES = {
    "(A)(12)": "A12",
    "(a)(12)": "A12",
    "A(12)":   "A12",
    "(C)(19)": "C19",
    "(c)(19)": "C19",
    "C(19)":   "C19",
}


def normalize_category(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    alias = CATEGORY_ALIASES.get(raw.strip())
    if alias:
        return alias
    cleaned = raw.strip().upper().replace(" ", "").replace("(", "").replace(")", "")
    return cleaned


def get_country_config(country: str) -> dict:
    """Return country-specific config, or generic config with a scope warning."""
    key = country.strip().lower()
    if key in COUNTRY_CONFIGS:
        return COUNTRY_CONFIGS[key]
    return {
        "eligible_categories": GENERIC_ELIGIBLE_CATEGORIES,
        "notes": (
            f"Country '{country}' is not in the resolver's verified country pack. "
            f"The generic eligible-category set is used as a fallback. "
            f"Verify the exact eligible categories from the Federal Register notice "
            f"for {country} TPS before relying on this result."
        ),
        "frn_source": "Federal Register — country-specific TPS notice",
        "hr1_eligible": None,  # Unknown for unmodeled countries
    }


def parse_date_iso(s: Optional[str]) -> Optional[date]:
    """
    Parse ISO YYYY-MM-DD format only.
    Rejects ambiguous MM/DD/YYYY and DD/MM/YYYY formats.
    Returns None for missing/unknown values.
    """
    if not s or s.lower() in ("none", "unknown", "null", ""):
        return None
    try:
        return datetime.strptime(s.strip(), "%Y-%m-%d").date()
    except ValueError:
        raise ValueError(
            f"Cannot parse date: {s!r}. Required format: YYYY-MM-DD. "
            f"Example: 2025-04-19"
        )


def resolve(
    country: str,
    tps_through_date: Optional[date],
    category: Optional[str],
    card_expiry: Optional[date],
    renewal_filed: str,           # "yes" | "no" | "unknown"
    in_reregistration: str,       # "yes" | "no" | "unknown"
    frn_extension_date: Optional[date],
    hr1_extension_date: Optional[date],
    replacement_ead: str,         # "yes" | "no" | "unknown"
    replacement_date: Optional[date],
) -> dict:
    """Core resolution logic. Returns a result dict."""

    config = get_country_config(country)
    eligible_categories = config["eligible_categories"]
    hr1_eligible_for_country = config.get("hr1_eligible")

    result = {
        "selected_branch": None,
        "furthest_valid_date": None,
        "cap_applied": False,
        "cap_reason": None,
        "eligible_paths": [],
        "documentary_proof": [],
        "conditional_flags": [],
        "explanation": "",
        "scope_warning": config["notes"],
    }

    # ------------------------------------------------------------------
    # Branch D — replacement EAD already issued (supersedes all branches)
    # ------------------------------------------------------------------
    if replacement_ead == "yes":
        if replacement_date:
            result["selected_branch"] = "D"
            result["eligible_paths"] = ["D"]
            result["furthest_valid_date"] = str(replacement_date)
            result["documentary_proof"] = [
                "Replacement EAD card (the printed expiration date on the card governs)"
            ]
            result["explanation"] = (
                f"USCIS approved and issued a replacement EAD with a printed expiry of "
                f"{replacement_date}. That date governs. No automatic extension "
                f"calculation is needed — the card itself is the proof."
            )
            return result
        else:
            result["conditional_flags"].append(
                "You indicated a replacement EAD was issued but did not provide "
                "the printed expiry date. Please provide the date on the face of "
                "the new card — that date governs."
            )

    if replacement_ead == "unknown":
        result["conditional_flags"].append(
            "It is unknown whether USCIS already issued a replacement EAD. "
            "If yes, the printed date on the new card governs and the extension "
            "calculation below may not apply."
        )

    # ------------------------------------------------------------------
    # Category eligibility check
    # ------------------------------------------------------------------
    norm_category = normalize_category(category)

    if norm_category and norm_category not in eligible_categories:
        result["selected_branch"] = "E"
        result["eligible_paths"] = []
        result["explanation"] = (
            f"EAD category '{norm_category}' is not in the eligible set "
            f"{sorted(eligible_categories)} for {country} TPS-based automatic "
            f"extension under current USCIS guidance. Verify the exact category "
            f"code printed on the face of the card. If the code is different, "
            f"rerun with the correct code."
        )
        result["conditional_flags"].append(
            f"If the category code on the card is actually A12 or C19, rerun "
            f"with that corrected value — the result will be different."
        )
        return result

    if not norm_category:
        result["conditional_flags"].append(
            "The EAD category code is unknown. The result below assumes the category "
            "is eligible (A12 or C19). If the actual code is different, Branch E "
            "(no extension) may apply instead."
        )

    # ------------------------------------------------------------------
    # Branch A — country-specific FRN extension
    # Condition: a country-specific FRN extension date exists for this country.
    # ------------------------------------------------------------------
    if frn_extension_date:
        result["eligible_paths"].append("A")
    else:
        result["conditional_flags"].append(
            f"No country-specific FRN extension date was provided for {country} TPS. "
            f"Branch A requires this date from the Federal Register notice. "
            f"Source: {config['frn_source']}"
        )

    # ------------------------------------------------------------------
    # Branch B — H.R. 1 pending-renewal extension
    # Conditions:
    #   1. H.R. 1 applies to this country (verified for Ukraine; unknown otherwise)
    #   2. A renewal I-765 was filed
    #   3. That renewal was filed during the TPS re-registration window
    #   4. An H.R. 1 extension date exists
    # ------------------------------------------------------------------

    # Check 1: Does H.R. 1 apply to this country?
    if hr1_eligible_for_country is False:
        result["conditional_flags"].append(
            f"H.R. 1 pending-renewal extension is not modeled for {country}. "
            f"Branch B does not apply based on current country configuration."
        )
    elif hr1_eligible_for_country is None:
        result["conditional_flags"].append(
            f"It is unknown whether H.R. 1 applies to {country} TPS. "
            f"Branch B eligibility cannot be confirmed without verifying the "
            f"Federal Register notice and USCIS I-9 Central for {country}."
        )

    if hr1_eligible_for_country is True:
        # Check 2: Was a renewal I-765 filed?
        if renewal_filed == "yes":
            # Check 3: Was it filed during the re-registration window?
            if in_reregistration == "yes":
                if hr1_extension_date:
                    result["eligible_paths"].append("B")
                else:
                    result["conditional_flags"].append(
                        "Branch B conditions are satisfied (renewal filed during "
                        "re-registration window), but the H.R. 1 extension date "
                        "was not provided. Fetch it from USCIS I-9 Central or "
                        "USCIS newsroom for the current H.R. 1 EAD extension date."
                    )
            elif in_reregistration == "unknown":
                result["conditional_flags"].append(
                    "A renewal I-765 was filed, but it is unknown whether it was "
                    "filed during the TPS re-registration window. If it was, "
                    "Branch B (H.R. 1 pending-renewal extension) may apply and "
                    "could produce a later date than Branch A. "
                    "Check your re-registration window dates from the Federal Register notice."
                )
            elif in_reregistration == "no":
                result["conditional_flags"].append(
                    "A renewal I-765 was filed but NOT during the TPS re-registration "
                    "window. Branch B (H.R. 1 pending-renewal extension) does not apply."
                )
        elif renewal_filed == "unknown":
            result["conditional_flags"].append(
                "It is unknown whether a renewal I-765 was filed. If one was filed "
                "during the re-registration window, Branch B (H.R. 1 extension) may "
                "apply and could produce a later date. Check your Form I-797C receipt."
            )
        elif renewal_filed == "no":
            result["conditional_flags"].append(
                "No renewal I-765 was filed. Branch B (H.R. 1 pending-renewal "
                "extension) does not apply — it requires a pending renewal filed "
                "during the re-registration window."
            )

    # ------------------------------------------------------------------
    # No eligible paths found
    # ------------------------------------------------------------------
    if not result["eligible_paths"]:
        result["selected_branch"] = "E"
        result["explanation"] = (
            "No automatic extension path was identified based on the provided facts. "
            "Possible reasons: (1) no country-specific FRN extension date was provided, "
            "(2) no qualifying pending renewal was found for Branch B. "
            "Verify the Federal Register notice for this TPS designation and whether "
            "a renewal I-765 was filed during the re-registration window. "
            "If the EAD has no valid automatic extension, it expired on the printed "
            "date and the person cannot legally work until a new EAD is issued."
        )
        if card_expiry:
            result["furthest_valid_date"] = str(card_expiry)
            result["explanation"] += f" The card expired on {card_expiry}."
        return result

    # ------------------------------------------------------------------
    # Collect candidate (branch, date) pairs for non-stacking comparison
    # ------------------------------------------------------------------
    candidates = []
    proof_map = {}

    if "A" in result["eligible_paths"] and frn_extension_date:
        candidates.append(("A", frn_extension_date))
        proof_map["A"] = [
            "Expired EAD card (carry the physical card)",
            f"Copy of the Federal Register notice showing the extension "
            f"through {frn_extension_date} for {country} TPS",
        ]

    if "B" in result["eligible_paths"] and hr1_extension_date:
        candidates.append(("B", hr1_extension_date))
        proof_map["B"] = [
            "Expired EAD card (carry the physical card)",
            "Form I-797C receipt notice for the pending I-765 renewal "
            "(the receipt notice + expired card together serve as proof)",
        ]

    # ------------------------------------------------------------------
    # Apply non-stacking rule: choose the branch reaching furthest
    # ------------------------------------------------------------------
    if len(candidates) > 1:
        result["selected_branch"] = "C"
        best_branch, best_date = max(candidates, key=lambda x: x[1])
        losing_branches = [b for b, _ in candidates if b != best_branch]
        non_stacking_note = (
            f"Both Branch A and Branch B apply. Under the non-stacking rule, "
            f"you use the path reaching the furthest date — Branch {best_branch} "
            f"({best_date}). You do NOT add the two dates together. "
            f"Branch(es) {losing_branches} also applied but produced an earlier date."
        )
        result["conditional_flags"].insert(0, non_stacking_note)
    elif len(candidates) == 1:
        best_branch, best_date = candidates[0]
        result["selected_branch"] = best_branch
    else:
        # Candidates were identified as eligible but dates are missing
        result["selected_branch"] = "E"
        result["explanation"] = (
            "Extension paths were identified as potentially applicable but the "
            "specific extension dates were not provided. Rerun with "
            "--frn-extension-date and/or --hr1-extension-date from the "
            "Federal Register notice and USCIS guidance."
        )
        return result

    # ------------------------------------------------------------------
    # Apply TPS designated-through date cap
    # ------------------------------------------------------------------
    if tps_through_date and best_date > tps_through_date:
        result["cap_applied"] = True
        result["cap_reason"] = (
            f"The extension date {best_date} exceeds the TPS designated-through "
            f"date of {tps_through_date}. The extension is capped at "
            f"{tps_through_date} — the extension cannot go beyond the period "
            f"for which TPS is designated."
        )
        best_date = tps_through_date

    # ------------------------------------------------------------------
    # Finalize result
    # ------------------------------------------------------------------
    result["furthest_valid_date"] = str(best_date)
    result["documentary_proof"] = proof_map.get(best_branch, proof_map.get(
        "A" if best_branch == "C" else best_branch, []
    ))

    branch_explanation = {
        "A": f"Branch A (country-specific FRN extension) applies and produces {best_date}.",
        "B": f"Branch B (H.R. 1 pending-renewal extension) applies and produces {best_date}.",
        "C": f"Branch C (both A and B apply; non-stacking rule selects the furthest date): {best_date}.",
    }

    result["explanation"] = (
        branch_explanation.get(result["selected_branch"], f"Branch {result['selected_branch']} applies.")
        + (" " + result["cap_reason"] if result["cap_applied"] else "")
    )

    return result


def main():
    parser = argparse.ArgumentParser(
        description="TPS EAD Automatic Extension Resolver",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--country", default="Unknown", help="Country of TPS designation")
    parser.add_argument("--tps-through-date", default=None, help="TPS designated-through date (YYYY-MM-DD)")
    parser.add_argument("--category", default=None, help="EAD category code (e.g., A12, C19)")
    parser.add_argument("--card-expiry", default=None, help="Printed card expiration date (YYYY-MM-DD)")
    parser.add_argument("--renewal-filed", choices=["yes", "no", "unknown"], default="unknown")
    parser.add_argument("--in-reregistration", choices=["yes", "no", "unknown"], default="unknown")
    parser.add_argument("--frn-extension-date", default=None, help="FRN extension through date (YYYY-MM-DD)")
    parser.add_argument("--hr1-extension-date", default=None, help="H.R. 1 extension date (YYYY-MM-DD)")
    parser.add_argument("--replacement-ead", choices=["yes", "no", "unknown"], default="unknown")
    parser.add_argument("--replacement-date", default=None, help="Replacement EAD printed expiry (YYYY-MM-DD)")

    args = parser.parse_args()

    try:
        tps_through = parse_date_iso(args.tps_through_date)
        card_expiry = parse_date_iso(args.card_expiry)
        frn_date = parse_date_iso(args.frn_extension_date)
        hr1_date = parse_date_iso(args.hr1_extension_date)
        replacement_date = parse_date_iso(args.replacement_date)
    except ValueError as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)

    output = resolve(
        country=args.country,
        tps_through_date=tps_through,
        category=args.category,
        card_expiry=card_expiry,
        renewal_filed=args.renewal_filed,
        in_reregistration=args.in_reregistration,
        frn_extension_date=frn_date,
        hr1_extension_date=hr1_date,
        replacement_ead=args.replacement_ead,
        replacement_date=replacement_date,
    )

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
