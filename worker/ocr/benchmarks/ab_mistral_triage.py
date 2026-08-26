"""Disagreement triage sheet -- the only part of the benchmark that needs a human.

Gate 2 asks whether an engine invented a row. No automatic metric can settle that: an engine line
carrying a number the ground-truth card does not record may be a genuine part of the page (a page
number, a printed phone number, a footer) or a fabrication. The difference matters more than any
other single measurement in the study, and it is visible to a person in about two seconds a row.

So the sheet carries only the rows where a decision is actually needed:

  A. SUSPECT  -- an engine line with three or more numbers, at least one of which appears nowhere
                 in the approved card. Candidate invention. This is what gate 2 counts.
  B. MISSING  -- a truth row one arm found and the other did not. Candidate omission.

Everything both arms agree on is left out. On this corpus that is the large majority of the rows,
which is the whole point: the human looks at ~100 lines instead of ~500.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from ab_mistral_truth import _TOL, _NUMBER_RE, engine_lines, norm_text, numbers


def _known_numbers(card: dict[str, Any]) -> list[float]:
    known = set()
    for token in _NUMBER_RE.findall(json.dumps(card, ensure_ascii=False)):
        try:
            known.add(round(float(token.replace(",", "")), 2))
        except ValueError:
            continue
    return sorted(known)


def _match_rows(card: dict[str, Any], lines: list[str], line_numbers: list[list[float]]):
    used: dict[int, int] = {}
    for row in card["line_items"]:
        q, u, t = row.get("quantity"), row.get("unit_price"), row.get("line_total")
        if not all(isinstance(v, (int, float)) for v in (q, u, t)):
            continue
        for index, values in enumerate(line_numbers):
            if index in used:
                continue
            if all(any(abs(v - target) <= _TOL for v in values) for target in (q, u, t)):
                used[index] = row["row"]
                break
    return used


def build(run_dir: Path, arms: list[str]) -> tuple[list[dict[str, Any]], dict[str, int]]:
    truth_dir = run_dir / "truth"
    cards = [
        json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(truth_dir.glob("*.json"))
    ]
    cards = [c for c in cards if c.get("usable_for_accuracy") and c.get("approved_by_owner")]

    out: list[dict[str, Any]] = []
    counts = {"suspect": 0, "missing": 0}

    for card in cards:
        slug = card["slug"]
        doc = card["file"].split("/")[-1]
        pages = set(card["sampled_pages"]) if card.get("sampled_pages") else None
        known = _known_numbers(card)
        state: dict[str, Any] = {}

        for arm in arms:
            path = run_dir / "derived" / arm / f"{slug}.json"
            if not path.exists():
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
            lines = engine_lines(payload, pages)
            line_numbers = [numbers(line) for line in lines]
            state[arm] = {
                "lines": lines,
                "numbers": line_numbers,
                "used": _match_rows(card, lines, line_numbers),
            }

        rows_with_triple = [
            r for r in card["line_items"]
            if all(isinstance(r.get(k), (int, float)) for k in ("quantity", "unit_price", "line_total"))
        ]

        # A -- NEARMISS: an engine line that carries two of a truth row's three numbers but not the
        # third. This is the category that matters: it is a real row of the document with one figure
        # read wrong, and it names the wrong figure. Bank account numbers and printed phone numbers
        # never land here, which is precisely why the plain "suspect" list was mostly noise.
        for arm, data in state.items():
            for index, values in enumerate(data["numbers"]):
                if index in data["used"] or len(values) < 2:
                    continue
                for row in rows_with_triple:
                    triple = (row["quantity"], row["unit_price"], row["line_total"])
                    hit = [t for t in triple if any(abs(v - t) <= _TOL for v in values)]
                    if len(hit) != 2:
                        continue
                    missed = [t for t in triple if t not in hit][0]
                    label = ("quantity", "unit_price", "line_total")[triple.index(missed)]
                    counts["nearmiss"] = counts.get("nearmiss", 0) + 1
                    out.append({
                        "kind": "NEARMISS",
                        "slug": slug,
                        "doc": doc,
                        "arm": arm,
                        "truth_row": row["row"],
                        "truth_says": f"{row.get('name') or row.get('sku') or ''} | "
                                      f"{triple[0]:g} x {triple[1]:g} = {triple[2]:g}",
                        "engine_line": data["lines"][index][:200],
                        "orphan_numbers": f"{label} צריך להיות {missed:g}",
                        "question": f"מה {arm} קראה במקום {missed:g}?",
                        "verdict": "",
                    })
                    break

        # B -- SUSPECT: an unmatched line whose numbers are unknown to the card AND which carries a
        # money-shaped figure (two decimals). Without the money filter the sheet fills with bank
        # accounts, phone numbers and postcodes, and the hour is spent on things that cost nothing.
        for arm, data in state.items():
            if card.get("sampled_pages"):
                continue  # only part of the document is carded; absence proves nothing
            for index, values in enumerate(data["numbers"]):
                if len(values) < 3 or index in data["used"]:
                    continue
                orphan = [n for n in values if not any(abs(n - k) <= _TOL for k in known)]
                money = [n for n in orphan if abs(n * 100 - round(n * 100)) < 1e-6 and n != int(n)]
                if not money:
                    counts["filtered_non_money"] = counts.get("filtered_non_money", 0) + 1
                    continue
                counts["suspect"] += 1
                out.append({
                    "kind": "SUSPECT",
                    "slug": slug,
                    "doc": doc,
                    "arm": arm,
                    "truth_row": "",
                    "truth_says": "",
                    "engine_line": data["lines"][index][:200],
                    "orphan_numbers": " ".join(f"{n:g}" for n in money[:6]),
                    "question": "האם השורה הזו קיימת במסמך?",
                    "verdict": "",
                })

        # B -- rows one arm found and the other missed
        if len(state) == 2:
            left, right = arms[0], arms[1]
            found = {arm: set(state[arm]["used"].values()) for arm in state}
            for row in card["line_items"]:
                q, u, t = row.get("quantity"), row.get("unit_price"), row.get("line_total")
                if not all(isinstance(v, (int, float)) for v in (q, u, t)):
                    continue
                in_left, in_right = row["row"] in found[left], row["row"] in found[right]
                if in_left == in_right:
                    continue
                missing_arm = right if in_left else left
                counts["missing"] += 1
                out.append({
                    "kind": "MISSING",
                    "slug": slug,
                    "doc": doc,
                    "arm": missing_arm,
                    "truth_row": row["row"],
                    "truth_says": f"{row.get('name') or row.get('sku') or ''} | {q:g} x {u:g} = {t:g}",
                    "engine_line": "(לא נמצאה שורה שנושאת את שלושת המספרים)",
                    "orphan_numbers": "",
                    "question": f"האם {missing_arm} באמת פספסה את השורה?",
                    "verdict": "",
                })

    out.sort(key=lambda r: (r["kind"], r["slug"], r["arm"], str(r["truth_row"])))
    return out, counts


def write_csv(rows: list[dict[str, Any]], target: Path) -> None:
    fields = ["kind", "slug", "doc", "arm", "truth_row", "truth_says",
              "engine_line", "orphan_numbers", "question", "verdict"]
    # utf-8-sig so Excel opens the Hebrew correctly on Windows without an import dialog.
    with target.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
