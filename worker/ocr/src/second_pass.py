"""One differently-preprocessed retry of a page whose first OCR read measurably failed.

For a photographed document the provider never sees the capture. `claim_document_processing_job_input`
swaps the OCR job's source to the scan derivative, so the vision model transcribes whatever the scan
lane produced -- now grayscale by default (`scanning._select_mode`). Grayscale keeps every
intermediate tone, which is the right default, but it is not right for every page: a page the model
could not read at all may still be readable once the ink is separated from the paper.

This module is that recovery, and nothing more. It runs INSIDE the worker, on a page the first
extraction demonstrably failed on, and it keeps the second result only when the second result is
measurably better. It never runs by default, never runs twice on the same page, and never turns a
usable read into a failed job.
"""

from __future__ import annotations

from typing import Any

import cv2

from .contract import validate_extraction
from .errors import ProcessingError
from .limits import ExtractionLimits
from .ocr import OcrAdapter, PageImage
from .scanning import binarize


# WHAT COUNTS AS "THE FIRST PASS FAILED".
#
# Deliberately NOT `document.partial`: both OCR adapters hardcode `"partial": True` on every
# payload they return (ocr.py, TesseractOcrAdapter and OpenAiOcrAdapter alike), so in this lane the
# flag is a constant and a trigger built on it would fire on every page of every scan. It describes
# the extraction method, not the extraction's health.
#
# Two signals remain, and both are things the worker already measured rather than opinions:
#
#   1. The page produced no text lines at all. Unambiguous: there is nothing to regress and
#      nothing to interpret.
#   2. A large majority of the page's lines carry `confidence == 0.0`. That value is written in
#      exactly one place (`OpenAiOcrAdapter.extract`) and means a specific measured thing: up to
#      three independent transcription passes of this page ran, and no other pass reproduced this
#      line's numbers. Lines carrying no numbers are never flagged, and with `OCR_QA_PASSES=1`
#      nothing is flagged at all, so this signal cannot fire where no check was performed.
#
# The ratio is set far above anything a healthy page reaches -- a clean page settles at two
# agreeing passes with zero flagged lines -- so it says "this page could not be read stably",
# never "this page could have been read better". It is not itself calibrated against a measured
# distribution of failures, because obtaining one costs paid provider calls; it is a named
# constant precisely so it can be lowered against evidence later without hunting for it.
SECOND_PASS_FLAGGED_LINE_RATIO = 0.75
# Below this a ratio is noise: on a three-line page a single unstable total is 33%.
SECOND_PASS_MIN_PAGE_LINES = 5
# Cost ceiling, counted PER DOCUMENT rather than per call. A systematically unreadable 20-page
# packet must not double the document's bill, and three retried pages is enough to establish that
# re-binarizing does not help it. The distinction matters because `_parse_pdf` renders in
# memory-bounded batches and calls this once per batch: a per-call cap would have let a seven-batch
# document retry twenty-one pages. The running total lives in the shared `audit` dict, which is
# the same object for every batch of one document.
SECOND_PASS_MAX_PAGES = 3


def _page_lines(payload: dict[str, Any], page_number: int) -> list[dict[str, Any]]:
    return [
        block
        for block in payload["blocks"]
        if block["page"] == page_number and block["text"]
    ]


def _flagged_ratio(lines: list[dict[str, Any]]) -> float:
    if not lines:
        return 0.0
    flagged = sum(1 for block in lines if block["confidence"] == 0.0)
    return flagged / len(lines)


def _extraction_failed(lines: list[dict[str, Any]]) -> bool:
    if not lines:
        return True
    if len(lines) < SECOND_PASS_MIN_PAGE_LINES:
        return False
    return _flagged_ratio(lines) >= SECOND_PASS_FLAGGED_LINE_RATIO


def _is_better(first: list[dict[str, Any]], second: list[dict[str, Any]]) -> bool:
    """Better means MEASURED better, in both directions at once.

    More text lines recovered, and a consensus-flag ratio that is no worse. Either half alone is
    gameable: a pass that splits the same sentence across more lines gains lines without gaining
    content, and a pass that returns two confident lines in place of forty shaky ones improves the
    ratio by discarding the invoice. Requiring both, and requiring strict improvement on the first,
    means a first read that was merely mediocre is never replaced -- if the second pass is not
    better, the first one stands.
    """
    if len(second) <= len(first):
        return False
    return _flagged_ratio(second) <= _flagged_ratio(first)


def _binarized_page(page: PageImage) -> PageImage | None:
    """Re-binarize one already-rendered page with the scan lane's own parameters."""
    image = cv2.imread(str(page.path), cv2.IMREAD_GRAYSCALE)
    if image is None or image.size == 0:
        return None
    output = page.path.with_name(f"{page.path.stem}-binarized.png")
    try:
        written = cv2.imwrite(str(output), binarize(image))
    except cv2.error:
        written = False
    if not written:
        output.unlink(missing_ok=True)
        return None
    return PageImage(page.page, output, int(image.shape[1]), int(image.shape[0]))


def improve(
    payload: dict[str, Any],
    pages: list[PageImage],
    adapter: OcrAdapter,
    limits: ExtractionLimits,
    audit: dict[str, Any],
) -> dict[str, Any]:
    """Return `payload`, or a copy in which measurably-failed pages carry a better second read.

    Costs at most one additional `adapter.extract()` call per invocation, and across every
    invocation sharing one `audit` -- that is, across one document -- at most
    `SECOND_PASS_MAX_PAGES` pages in total, only ones `_extraction_failed` selected. It can never
    recurse: the second result is never itself re-examined.
    """
    if not pages:
        return payload
    budget = SECOND_PASS_MAX_PAGES - len(audit.get("attempted_pages", []))
    if budget <= 0:
        return payload
    if payload["marks"]:
        # Marks reference block ids, and replacing a page's blocks can orphan those references.
        # Neither OCR adapter emits marks, so this is a guard against a future adapter rather
        # than a live path -- but a dangling reference would fail `validate_extraction` and lose
        # a document that already had a usable read.
        return payload

    failing = [page for page in pages if _extraction_failed(_page_lines(payload, page.page))]
    if not failing:
        return payload

    binarized: list[PageImage] = []
    try:
        for page in failing[:budget]:
            replacement = _binarized_page(page)
            if replacement is not None:
                binarized.append(replacement)
        if not binarized:
            return payload

        audit.setdefault("attempted_pages", []).extend(page.page for page in binarized)
        audit["extra_extractions"] = audit.get("extra_extractions", 0) + 1
        try:
            second = validate_extraction(adapter.extract(binarized, limits), limits)
        except ProcessingError as exc:
            # A recovery attempt must never fail a document that already has a usable read, and
            # must never raise a retryable error that the job runner would multiply into more
            # paid calls. The first result is the answer; the failure is recorded as evidence.
            audit["error"] = exc.code[:100]
            return payload

        improved = [
            page.page
            for page in binarized
            if _is_better(
                _page_lines(payload, page.page), _page_lines(second, page.page)
            )
        ]
        if not improved:
            return payload

        by_page: dict[int, list[dict[str, Any]]] = {}
        for block in payload["blocks"]:
            by_page.setdefault(block["page"], []).append(block)
        for page_number in improved:
            by_page[page_number] = [
                block for block in second["blocks"] if block["page"] == page_number
            ]

        ordered: list[dict[str, Any]] = []
        remaining = dict(by_page)
        for page in pages:
            ordered.extend(remaining.pop(page.page, []))
        for page_number in sorted(remaining):
            ordered.extend(remaining[page_number])

        # Rebuilt the way both adapters build it -- page order as handed to `extract`, lines
        # joined by newline, pages by blank line -- so an unchanged document is byte-identical.
        plain_text = "\n\n".join(
            "\n".join(block["text"] for block in by_page.get(page.page, []) if block["text"])
            for page in pages
        )
        merged = {
            "schema_version": payload["schema_version"],
            "document": {**payload["document"], "plain_text": plain_text},
            "blocks": ordered,
            "tables": payload["tables"],
            "marks": payload["marks"],
        }
        try:
            validated = validate_extraction(merged, limits)
        except ProcessingError as exc:
            audit["error"] = exc.code[:100]
            return payload
        audit.setdefault("improved_pages", []).extend(improved)
        return validated
    finally:
        for page in binarized:
            page.path.unlink(missing_ok=True)
