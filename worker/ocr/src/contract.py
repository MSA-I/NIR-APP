from __future__ import annotations

import json
import math
from typing import Any

from .errors import ProcessingError
from .limits import DEFAULT_LIMITS, ExtractionLimits


BLOCK_TYPES = {"text", "heading", "table", "image", "handwriting"}
MARK_KINDS = {"circle", "check", "cross", "underline", "star", "custom", "unknown"}

# WHAT `normalizations` IS FOR, AND WHY IT IS A CLOSED SET.
#
# A parser may CORRECT text it read from a document. `hebrew_visual_order` is the only such
# correction today and it used to overwrite the text in place: the pre-correction string existed
# nowhere afterwards, and nothing recorded that the correction had fired at all. Reading a stored
# extraction, you could not tell a document that printed Hebrew in logical order from one this
# worker silently repaired -- so "what the document said" and "what this system decided it said"
# were the same field.
#
# One entry per correction the parser EVALUATED, whether or not it changed anything:
#
#   applied=False, original_text=None  -- evaluated, decided the text was already right. The
#                                         stored text IS the original; that is the claim.
#   applied=True,  original_text=str   -- changed. `original_text` is the exact string the
#                                         detector judged, before any character moved.
#
# An EMPTY array is therefore not "nothing was corrected"; it is "no corrector ran on this path",
# which is the honest answer for a spreadsheet or a CSV. The three states stay distinguishable,
# and that distinction is the whole feature.
#
# The id set is closed on purpose, exactly like BLOCK_TYPES and MARK_KINDS. A second corrector is
# a contract change on both sides of the gateway wire and must be seen as one -- an open string
# would let a new correction reach stored evidence without anyone reviewing what it does to it.
HEBREW_VISUAL_ORDER = "hebrew_visual_order"
NORMALIZATION_IDS = {HEBREW_VISUAL_ORDER}
MAX_NORMALIZATION_MEASUREMENTS = 16

# WHAT `document.partial` MEANS. One rule, because every consumer reads the same field:
#
#   True  <=>  this extraction did not LOOK at part of the source.
#
# It is a coverage claim, never a quality claim. A page that was rendered, sent and came back
# empty is COMPLETE, not partial -- a blank verso and a failed read are indistinguishable without
# pixel analysis, and the failed read has its own recovery path in `second_pass.improve`. A page
# nobody rendered is PARTIAL however clean the rest of the document was.
#
# Each parser derives it from what it can prove it skipped, and nothing hardcodes it: see
# `parsers._parse_pdf` (the paid-OCR page cap), `parsers._parse_html` (embedded, non-text
# content) and `parsers._parse_docx` (archive parts that would not open). Parsers that refuse an
# oversized source rather than truncating it are complete by construction and report False.
#
# `service_record_document_packet` refuses an automatic packet split unless this is False, so a
# flag that is always True disables that gate entirely and a flag that is always False removes it.


def _object(
    value: Any, keys: set[str], name: str, *, optional: set[str] | None = None
) -> dict[str, Any]:
    """Exact key-set match, with a named and deliberately tiny escape hatch.

    `optional` exists for ONE case and is not a general loosening: an OCR adapter describes what
    it READ, never how the parser afterwards corrected it, so requiring `normalizations` from
    `OcrAdapter.extract` would force every adapter -- and every benchmark ground-truth file on
    disk -- to assert a decision it never made. The key is optional on the way IN and always
    present on the way OUT (`validate_extraction` materializes `[]`), so the payload this worker
    hands the gateway is still exact, which is what the Edge validator checks key for key.
    """
    if type(value) is not dict:
        raise ProcessingError("invalid_extraction", f"{name} has an invalid shape")
    present = set(value)
    if not keys <= present or not present <= keys | (optional or set()):
        raise ProcessingError("invalid_extraction", f"{name} has an invalid shape")
    return value


def _string(value: Any, name: str, *, nonempty: bool = False) -> str:
    if type(value) is not str or (nonempty and not value):
        raise ProcessingError("invalid_extraction", f"{name} must be a string")
    return value


def _integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ProcessingError("invalid_extraction", f"{name} is outside its bounds")
    return value


def _number(value: Any, name: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value):
        raise ProcessingError("invalid_extraction", f"{name} must be a finite number")
    return float(value)


def _bbox(value: Any, name: str) -> list[float]:
    if type(value) is not list or len(value) != 4:
        raise ProcessingError("invalid_extraction", f"{name} must contain four coordinates")
    result = [_number(item, name) for item in value]
    if any(item < 0 or item > 1 for item in result) or result[2] < result[0] or result[3] < result[1]:
        raise ProcessingError("invalid_extraction", f"{name} is outside normalized bounds")
    return result


def _confidence(value: Any, name: str) -> float | None:
    if value is None:
        return None
    number = _number(value, name)
    if not 0 <= number <= 1:
        raise ProcessingError("invalid_extraction", f"{name} is outside 0..1")
    return number


def _normalizations(value: Any, limits: ExtractionLimits) -> list[dict[str, Any]]:
    if type(value) is not list:
        raise ProcessingError("invalid_extraction", "normalizations must be an array")
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(value):
        item = _object(
            raw, {"id", "applied", "original_text", "measurements"}, f"normalizations[{index}]"
        )
        identifier = _string(item["id"], f"normalizations[{index}].id", nonempty=True)
        if identifier not in NORMALIZATION_IDS:
            raise ProcessingError("invalid_extraction", "Unknown normalization id")
        if identifier in seen:
            raise ProcessingError("invalid_extraction", "Normalization ids must be unique")
        seen.add(identifier)
        applied = item["applied"]
        if type(applied) is not bool:
            raise ProcessingError("invalid_extraction", "normalizations[].applied must be a bool")
        original = item["original_text"]
        # The pairing itself, enforced rather than described: a correction that changed the text
        # MUST carry what the text was, and one that changed nothing must NOT carry a second copy
        # of the text it left alone. Either half alone is a record nobody can act on.
        if applied:
            original = _string(original, f"normalizations[{index}].original_text")
            if len(original) > limits.max_text_chars:
                raise ProcessingError("invalid_extraction", "Preserved original text is too long")
        elif original is not None:
            raise ProcessingError(
                "invalid_extraction", "An unapplied normalization must not carry an original"
            )
        measurements = item["measurements"]
        if type(measurements) is not list or len(measurements) > MAX_NORMALIZATION_MEASUREMENTS:
            raise ProcessingError("invalid_extraction", "measurements must be a bounded array")
        # Name/value pairs rather than a fixed set of columns: the numbers a detector weighs are
        # its own, and a second detector with different evidence must not need this contract
        # reopened to say what it measured.
        normalized_measurements: list[dict[str, Any]] = []
        names: set[str] = set()
        for position, entry in enumerate(measurements):
            measurement = _object(
                entry, {"name", "value"}, f"normalizations[{index}].measurements[{position}]"
            )
            name = _string(measurement["name"], "measurement name", nonempty=True)
            if len(name) > 100:
                raise ProcessingError("invalid_extraction", "Measurement name is too long")
            if name in names:
                raise ProcessingError("invalid_extraction", "Measurement names must be unique")
            names.add(name)
            # Type-checked through `_number`, stored in the type it arrived in. These are counts;
            # rendering "13 words" as 13.0 in stored evidence would be this contract inventing a
            # precision the detector never claimed.
            value = measurement["value"]
            _number(value, "measurement value")
            normalized_measurements.append({"name": name, "value": value})
        result.append(
            {
                "id": identifier,
                "applied": applied,
                "original_text": original,
                "measurements": normalized_measurements,
            }
        )
    return result


def validate_extraction(
    payload: Any, limits: ExtractionLimits = DEFAULT_LIMITS
) -> dict[str, Any]:
    root = _object(
        payload,
        {"schema_version", "document", "blocks", "tables", "marks"},
        "payload",
        optional={"normalizations"},
    )
    if root["schema_version"] != "1":
        raise ProcessingError("invalid_extraction", "Unsupported extraction schema version")
    normalizations = _normalizations(root.get("normalizations", []), limits)

    document = _object(
        root["document"], {"page_count", "detected_languages", "plain_text", "partial"}, "document"
    )
    page_count = _integer(document["page_count"], "document.page_count", 1, limits.max_pdf_pages)
    languages = document["detected_languages"]
    if type(languages) is not list or any(type(item) is not str for item in languages):
        raise ProcessingError("invalid_extraction", "detected_languages must contain strings")
    plain_text = _string(document["plain_text"], "document.plain_text")
    if len(plain_text) > limits.max_text_chars or type(document["partial"]) is not bool:
        raise ProcessingError("invalid_extraction", "Document text or partial flag is invalid")

    blocks = root["blocks"]
    tables = root["tables"]
    marks = root["marks"]
    if any(type(items) is not list for items in (blocks, tables, marks)):
        raise ProcessingError("invalid_extraction", "blocks, tables and marks must be arrays")

    normalized_blocks: list[dict[str, Any]] = []
    block_ids: set[str] = set()
    for index, raw in enumerate(blocks):
        item = _object(raw, {"id", "page", "type", "bbox", "text", "confidence"}, f"blocks[{index}]")
        block_id = _string(item["id"], f"blocks[{index}].id", nonempty=True)
        if block_id in block_ids:
            raise ProcessingError("invalid_extraction", "Block ids must be unique")
        block_ids.add(block_id)
        block_type = _string(item["type"], f"blocks[{index}].type")
        if block_type not in BLOCK_TYPES:
            raise ProcessingError("invalid_extraction", "Unknown block type")
        normalized_blocks.append(
            {
                "id": block_id,
                "page": _integer(item["page"], f"blocks[{index}].page", 1, page_count),
                "type": block_type,
                "bbox": _bbox(item["bbox"], f"blocks[{index}].bbox"),
                "text": _string(item["text"], f"blocks[{index}].text"),
                "confidence": _confidence(item["confidence"], f"blocks[{index}].confidence"),
            }
        )

    normalized_tables: list[dict[str, Any]] = []
    table_ids: set[str] = set()
    total_rows = 0
    for table_index, raw in enumerate(tables):
        item = _object(raw, {"id", "page", "bbox", "rows"}, f"tables[{table_index}]")
        table_id = _string(item["id"], f"tables[{table_index}].id", nonempty=True)
        if table_id in table_ids:
            raise ProcessingError("invalid_extraction", "Table ids must be unique")
        table_ids.add(table_id)
        if type(item["rows"]) is not list:
            raise ProcessingError("invalid_extraction", "Table rows must be arrays")
        total_rows += len(item["rows"])
        if total_rows > limits.max_spreadsheet_rows:
            raise ProcessingError("spreadsheet_row_limit", "Spreadsheet row limit exceeded")
        normalized_rows: list[list[dict[str, Any]]] = []
        for row_index, raw_row in enumerate(item["rows"]):
            if type(raw_row) is not list:
                raise ProcessingError("invalid_extraction", "Table rows must be arrays")
            if len(raw_row) > limits.max_spreadsheet_columns:
                raise ProcessingError(
                    "spreadsheet_column_limit", "Spreadsheet column limit exceeded"
                )
            normalized_row: list[dict[str, Any]] = []
            for cell_index, raw_cell in enumerate(raw_row):
                cell = _object(raw_cell, {"text", "bbox"}, "table cell")
                normalized_row.append(
                    {
                        "text": _string(cell["text"], f"cell[{cell_index}].text"),
                        "bbox": None
                        if cell["bbox"] is None
                        else _bbox(cell["bbox"], f"cell[{cell_index}].bbox"),
                    }
                )
            normalized_rows.append(normalized_row)
        normalized_tables.append(
            {
                "id": table_id,
                "page": _integer(item["page"], f"tables[{table_index}].page", 1, page_count),
                "bbox": _bbox(item["bbox"], f"tables[{table_index}].bbox"),
                "rows": normalized_rows,
            }
        )

    normalized_marks: list[dict[str, Any]] = []
    mark_ids: set[str] = set()
    for index, raw in enumerate(marks):
        item = _object(
            raw,
            {"id", "page", "kind", "bbox", "nearby_block_ids", "confidence", "fingerprint"},
            f"marks[{index}]",
        )
        mark_id = _string(item["id"], f"marks[{index}].id", nonempty=True)
        if mark_id in mark_ids:
            raise ProcessingError("invalid_extraction", "Mark ids must be unique")
        mark_ids.add(mark_id)
        kind = _string(item["kind"], f"marks[{index}].kind")
        if kind not in MARK_KINDS:
            raise ProcessingError("invalid_extraction", "Unknown mark kind")
        nearby = item["nearby_block_ids"]
        if type(nearby) is not list or any(type(value) is not str or value not in block_ids for value in nearby):
            raise ProcessingError("invalid_extraction", "nearby_block_ids must reference blocks")
        fingerprint = item["fingerprint"]
        if fingerprint is not None and type(fingerprint) is not str:
            raise ProcessingError("invalid_extraction", "Mark fingerprint must be a string or null")
        normalized_marks.append(
            {
                "id": mark_id,
                "page": _integer(item["page"], f"marks[{index}].page", 1, page_count),
                "kind": kind,
                "bbox": _bbox(item["bbox"], f"marks[{index}].bbox"),
                "nearby_block_ids": list(nearby),
                "confidence": _confidence(item["confidence"], f"marks[{index}].confidence"),
                "fingerprint": fingerprint,
            }
        )

    normalized = {
        "schema_version": "1",
        "document": {
            "page_count": page_count,
            "detected_languages": list(dict.fromkeys(languages)),
            "plain_text": plain_text,
            "partial": document["partial"],
        },
        "blocks": normalized_blocks,
        "tables": normalized_tables,
        "marks": normalized_marks,
        "normalizations": normalizations,
    }
    try:
        serialized = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
    except (TypeError, ValueError) as exc:
        raise ProcessingError("invalid_extraction", "Extraction is not valid JSON") from exc
    if len(serialized) > limits.max_payload_bytes:
        raise ProcessingError("extraction_payload_limit", "Extraction payload limit exceeded")
    return normalized
