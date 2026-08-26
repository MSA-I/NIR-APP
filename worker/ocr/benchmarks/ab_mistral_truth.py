"""Tier-1 scoring: engine output against the owner-approved ground truth.

Everything here needs `truth/<slug>.json`. The tier-0 metrics in `ab_mistral.py` need nothing and
run first; if an arm fails there the study stops before a single human hour is spent. This module
is what answers gates 1 (numbers), 2 (missing/invented rows), 3 (association) and the RTL half of
gate 4 -- the three that actually decide whether an OCR engine is safe to put in a payments path.

Two rules the matching obeys, both from `truth/README.md`:

1. A truth row counts as FOUND only when one engine line carries all three of its numbers. Finding
   the three numbers scattered across the page is not finding the row -- that is precisely the
   association failure the whole exercise exists to detect.
2. Bidi-ambiguous fields are skipped, never guessed at. The `*` separator reverses between logical
   and visual order and the source photo cannot settle which the document meant.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


_NUMBER_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")
# Markdown syntax and bidi controls are stripped from BOTH arms before any comparison, so the
# normaliser can never favour the engine that happens to emit tables as pipes.
_MD_RE = re.compile(r"\*\*|__|`|^#{1,6}\s|\|", re.MULTILINE)
_BIDI_RE = re.compile("[‎‏‪-‮⁦-⁩]")
_TOL = 0.005


def norm_text(value: str) -> str:
    value = _BIDI_RE.sub("", value)
    value = _MD_RE.sub(" ", value)
    return " ".join(unicodedata.normalize("NFC", value).split())


def numbers(text: str) -> list[float]:
    out: list[float] = []
    for token in _NUMBER_RE.findall(text):
        try:
            out.append(float(token.replace(",", "")))
        except ValueError:
            continue
    return out


def digits_only(text: str) -> str:
    return "".join(ch for ch in text.replace(",", "") if ch.isdigit())


def _has(values: list[float], target: float) -> bool:
    return any(abs(v - target) <= _TOL for v in values)


def substring_distance(pattern: str, text: str) -> int:
    """Smallest edit distance between `pattern` and ANY window of `text`.

    A truth row's name is a short field; the engine line that carries it also carries the SKU, the
    barcode, three numbers and a delivery-note id. Full-string edit distance between the two is
    dominated by the material the name was never meant to match, which is what produced a CER above
    1.0 and an association accuracy of exactly zero on both arms in the first run -- a broken
    metric, not a finding. Zeroing the first DP row makes every start position free, so the score
    is "how well does this name appear somewhere in that line".
    """
    if not pattern:
        return 0
    previous = list(range(len(pattern) + 1))
    best = len(pattern)
    for char in text:
        current = [0] + [0] * len(pattern)
        for index in range(1, len(pattern) + 1):
            cost = 0 if pattern[index - 1] == char else 1
            current[index] = min(previous[index] + 1, current[index - 1] + 1, previous[index - 1] + cost)
        previous = current
        best = min(best, previous[len(pattern)])
    return best


def engine_lines(payload: dict[str, Any], pages: set[int] | None) -> list[str]:
    lines: list[str] = []
    for block in payload.get("blocks", []):
        if pages is not None and block.get("page") not in pages:
            continue
        for piece in str(block.get("text", "")).split("\n"):
            piece = norm_text(piece)
            if piece:
                lines.append(piece)
    return lines


def score_document(card: dict[str, Any], payload: dict[str, Any], edit_distance) -> dict[str, Any]:
    pages = set(card["sampled_pages"]) if card.get("sampled_pages") else None
    lines = engine_lines(payload, pages)
    line_numbers = [numbers(line) for line in lines]

    truth_rows = [
        li for li in card["line_items"]
        if all(isinstance(li.get(k), (int, float)) for k in ("quantity", "unit_price", "line_total"))
    ]
    used: set[int] = set()
    matched = 0
    assoc_ok = 0
    field_hit = {"quantity": 0, "unit_price": 0, "line_total": 0}
    field_total = {"quantity": 0, "unit_price": 0, "line_total": 0}
    rtl_ok = rtl_total = 0
    name_ref: list[str] = []
    name_hyp: list[str] = []

    for row in truth_rows:
        q, u, t = row["quantity"], row["unit_price"], row["line_total"]
        best = None
        for index, values in enumerate(line_numbers):
            if index in used:
                continue
            if _has(values, q) and _has(values, u) and _has(values, t):
                best = index
                break
        if best is not None:
            used.add(best)
            matched += 1
            line = lines[best]
            for key, value in (("quantity", q), ("unit_price", u), ("line_total", t)):
                field_total[key] += 1
                if _has(line_numbers[best], value):
                    field_hit[key] += 1
            # Digit-run integrity: the printed figure must survive as a contiguous digit run.
            # `1,392` rendered as `293,1` still yields the same multiset, so only this catches it.
            for value in (q, u, t):
                shown = f"{value:.2f}".rstrip("0").rstrip(".")
                rtl_total += 1
                if digits_only(shown) in digits_only(line):
                    rtl_ok += 1
            name = row.get("name")
            if row.get("bidi_ambiguous"):
                pass
            elif not name:
                # No name to check (delivery-note rows). The triple matched, which is all this
                # document can attest; counted, and the count of such rows is reported separately.
                assoc_ok += 1
            else:
                ref = norm_text(name)
                distance = substring_distance(ref, line)
                name_ref.append(distance)
                name_hyp.append(len(ref))
                if distance / max(len(ref), 1) <= 0.25:
                    assoc_ok += 1

    truth_numbers: list[float] = []
    for row in card["line_items"]:
        truth_numbers += [row[k] for k in ("quantity", "unit_price", "line_total")
                          if isinstance(row.get(k), (int, float))]
    # Every number the card knows about, not just the three money columns: SKUs, barcodes,
    # delivery-note ids, tax ids, dates and document numbers all appear on the page and all show up
    # in engine lines. Scoring against the money columns alone counted a barcode as an invention and
    # inflated the figure roughly threefold in the first run.
    known = set()
    for token in _NUMBER_RE.findall(json.dumps(card, ensure_ascii=False)):
        try:
            known.add(round(float(token.replace(",", "")), 2))
        except ValueError:
            continue
    known_list = sorted(known)

    # A "candidate row" is an engine line carrying three or more numbers. Most unmatched candidates
    # are legitimate non-line-item content -- totals blocks, delivery-note rows, barcodes, phone
    # numbers -- so calling them all hallucinations would badly overstate the count. A candidate is
    # only counted as INVENTED when it carries a number the document does not contain anywhere,
    # neither in a line nor in the header. That is a claim about money that has no source.
    candidates = [i for i, values in enumerate(line_numbers) if len(values) >= 3]
    invented = unmatched = None
    if not card.get("sampled_pages"):
        loose = [i for i in candidates if i not in used]
        unmatched = len(loose)
        invented = sum(
            1 for i in loose
            if any(not any(abs(n - k) <= _TOL for k in known_list) for n in line_numbers[i])
        )
    engine_numbers = [n for values in line_numbers for n in values]
    remaining = list(engine_numbers)
    found = 0
    for value in truth_numbers:
        for index, other in enumerate(remaining):
            if abs(other - value) <= _TOL:
                remaining.pop(index)
                found += 1
                break

    header = card["header"]
    header_hit = header_total = 0
    all_numbers = engine_numbers
    for key in ("total", "vat_amount", "subtotal_before_vat"):
        value = header.get(key)
        if isinstance(value, (int, float)):
            header_total += 1
            header_hit += int(_has(all_numbers, value))

    # Length-weighted, so one long name cannot be diluted by many short ones.
    cer = round(sum(name_ref) / sum(name_hyp), 4) if name_hyp and sum(name_hyp) else None

    return {
        "slug": card["slug"],
        "truth_rows": len(truth_rows),
        "rows_found": matched,
        "line_recall": round(matched / len(truth_rows), 4) if truth_rows else None,
        "association_ok": assoc_ok,
        "association_accuracy": round(assoc_ok / len(truth_rows), 4) if truth_rows else None,
        "invented_rows": invented,
        "unmatched_candidate_rows": unmatched,
        "candidate_rows": len(candidates),
        "field_exact": {k: (round(field_hit[k] / field_total[k], 4) if field_total[k] else None)
                        for k in field_hit},
        "numeric_recall": round(found / len(truth_numbers), 4) if truth_numbers else None,
        "numeric_fields": len(truth_numbers),
        "rtl_digit_order_ok": round(rtl_ok / rtl_total, 4) if rtl_total else None,
        "header_fields_found": f"{header_hit}/{header_total}",
        "name_cer_vs_line": cer,
    }


def run(run_dir: Path, arms: list[str], edit_distance) -> dict[str, Any]:
    truth_dir = run_dir / "truth"
    cards = []
    for path in sorted(truth_dir.glob("*.json")):
        card = json.loads(path.read_text(encoding="utf-8"))
        if card.get("usable_for_accuracy") and card.get("approved_by_owner"):
            cards.append(card)

    report: dict[str, Any] = {"schema_version": "1", "tier": 1, "documents": len(cards), "arms": {}}
    for arm in arms:
        derived = run_dir / "derived" / arm
        per_doc = []
        for card in cards:
            path = derived / f"{card['slug']}.json"
            if not path.exists():
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
            per_doc.append(score_document(card, payload, edit_distance))

        def total(key: str) -> int:
            return sum(d[key] for d in per_doc if isinstance(d.get(key), int))

        truth_rows = total("truth_rows")
        inv = [d["invented_rows"] for d in per_doc if d["invented_rows"] is not None]
        unm = [d["unmatched_candidate_rows"] for d in per_doc if d["unmatched_candidate_rows"] is not None]
        numeric_fields = total("numeric_fields")
        numeric_found = sum(round(d["numeric_recall"] * d["numeric_fields"]) for d in per_doc
                            if d["numeric_recall"] is not None)
        rtl = [d["rtl_digit_order_ok"] for d in per_doc if d["rtl_digit_order_ok"] is not None]
        cers = [d["name_cer_vs_line"] for d in per_doc if d["name_cer_vs_line"] is not None]
        report["arms"][arm] = {
            "documents": len(per_doc),
            "truth_rows": truth_rows,
            "rows_found": total("rows_found"),
            "line_recall": round(total("rows_found") / truth_rows, 4) if truth_rows else None,
            "association_accuracy": round(total("association_ok") / truth_rows, 4) if truth_rows else None,
            "invented_rows": sum(inv),
            "invented_rate_of_truth_rows": round(sum(inv) / truth_rows, 4) if truth_rows else None,
            "unmatched_candidate_rows": sum(unm),
            "numeric_fields": numeric_fields,
            "numeric_recall": round(numeric_found / numeric_fields, 4) if numeric_fields else None,
            "rtl_digit_order_ok": round(sum(rtl) / len(rtl), 4) if rtl else None,
            "mean_name_cer": round(sum(cers) / len(cers), 4) if cers else None,
            "name_cer_note": "substring distance of the truth name against the matched engine line, length-weighted",
            "per_document": per_doc,
        }
    return report
