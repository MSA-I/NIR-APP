"""Mistral OCR adapter -- the production reader.

Selected 18.08.2026 on the ocr-ab/20260818 benchmark: 0.988 line recall against 0.616, zero
confirmed invented rows against three, one billed call per page against 2.62, and a 2.2s median
document against 18.4s. The evidence and the owner's per-row adjudication are in
`NIR-APP-DOCS/ocr-ab/20260818/triage-outcome.md`.

Three rules this file will not break:

1. Nothing is invented. A field Mistral does not return is `None`/`[]`, never a plausible guess.
   The one synthesised value -- the reading-order band used when no measured geometry arrives --
   is copied verbatim from `OpenAiOcrAdapter` (`ocr.py:353-355`) so a reviewer reading the two
   adapters' output cannot tell which one drew a box it did not measure.
2. Block text is stored verbatim. Markdown emphasis characters (`*`, `_`, backticks) occur inside
   real supplier SKUs, so stripping them from the contract would delete data.
3. Retry policy, timeout and response cap match `OpenAiOcrAdapter` exactly. The two adapters must
   fail the same way, or the failure mode becomes a function of which vendor happened to be
   configured.

What this adapter does NOT carry over from `OpenAiOcrAdapter` is the resampling QA layer, and the
omission is deliberate rather than pending. That layer transcribes a page up to three times and
marks `confidence: 0.0` on any line whose numbers no other pass reproduced. It is a check because
a vision model's output varies between passes. Mistral returns its own graded confidence per block
(`confidence_scores_granularity: "block"`), which is measured rather than inferred, and is mapped
straight onto the block. Whether resampling Mistral would add anything on top has not been
measured; until it has, this adapter asserts the provider's number and does not manufacture a
second one that would look like corroboration.
"""

from __future__ import annotations

import base64
import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from threading import Lock, local
from typing import Any, Callable
import time

from .errors import ProcessingError
from .gateway import _NoRedirect
from .limits import DEFAULT_LIMITS, ExtractionLimits
from .ocr import PageImage
from .retry import retry_call


MISTRAL_OCR_URL = "https://api.mistral.ai/v1/ocr"
DEFAULT_MISTRAL_MODEL = "mistral-ocr-latest"

# Matched to OpenAiOcrAdapter so the arms differ in vendor and nothing else.
MISTRAL_ATTEMPTS = 2
MISTRAL_RETRYABLE_STATUS = {429, 500, 502, 503, 504}
MISTRAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

# Mistral's structural block labels (OCR 4+, `include_blocks`) mapped onto the five the contract
# allows (`src/contract.py:11`). `signature -> handwriting` is the loosest of these: it is the
# nearest neighbour, not an identity, and it is recorded in the run manifest as an assumption.
BLOCK_TYPE_MAP = {
    "title": "heading",
    "table": "table",
    "image": "image",
    "signature": "handwriting",
    "text": "text",
    "list": "text",
    "caption": "text",
    "code": "text",
    "references": "text",
    "aside_text": "text",
    "header": "text",
    "footer": "text",
    "equation": "text",
}

_TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?[\s:|-]+\|[\s:|-]*$")
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
_HEADING_RE = re.compile(r"^\s*#{1,6}\s+(.*)$")
_BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*)$")
_FIGURE_RE = re.compile(r"^\s*!\[[^\]]*\]\([^)]*\)\s*$")
# Unescaped pipe: a cell separator. `\|` inside a cell is literal.
_CELL_SPLIT_RE = re.compile(r"(?<!\\)\|")


def _data_uri(image_bytes: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64," + base64.b64encode(image_bytes).decode("ascii")


def _clamp(value: float) -> float:
    return 0.0 if value < 0 else 1.0 if value > 1 else value


def _measured_bbox(block: dict[str, Any], width: int, height: int) -> list[float] | None:
    """Pixel corners -> normalised contract bbox, or None when the block carries no geometry.

    Returns None rather than a default so the caller can fall back to the synthesised band and the
    run can report how many blocks actually had measured geometry.
    """
    if width <= 0 or height <= 0:
        return None
    corners = (
        block.get("top_left_x"),
        block.get("top_left_y"),
        block.get("bottom_right_x"),
        block.get("bottom_right_y"),
    )
    if any(corner is None for corner in corners) or any(
        type(corner) not in (int, float) for corner in corners
    ):
        return None
    x0, y0, x1, y1 = (float(corner) for corner in corners)
    xs = sorted((_clamp(x0 / width), _clamp(x1 / width)))
    ys = sorted((_clamp(y0 / height), _clamp(y1 / height)))
    return [xs[0], ys[0], xs[1], ys[1]]


def _block_confidence(block: dict[str, Any]) -> float | None:
    scores = block.get("confidence_scores")
    if type(scores) is not dict:
        return None
    value = scores.get("average_content_confidence_score")
    if type(value) not in (int, float):
        return None
    number = float(value)
    return number if 0.0 <= number <= 1.0 else None


def _split_table_row(line: str) -> list[str]:
    cells = [cell.strip().replace("\\|", "|") for cell in _CELL_SPLIT_RE.split(line.strip())]
    # A GFM row is bounded by pipes, which produces an empty first and last field.
    if cells and not cells[0]:
        cells = cells[1:]
    if cells and not cells[-1]:
        cells = cells[:-1]
    return cells


def _classify_markdown_line(line: str) -> tuple[str, str] | None:
    """(contract block type, text) for one Markdown line, or None when the line is syntax."""
    if not line.strip():
        return None
    if _TABLE_SEPARATOR_RE.match(line) and "-" in line:
        return None
    if _TABLE_ROW_RE.match(line):
        return ("table", line.strip())
    if _FIGURE_RE.match(line):
        return ("image", "")
    heading = _HEADING_RE.match(line)
    if heading:
        return ("heading", heading.group(1).strip())
    bullet = _BULLET_RE.match(line)
    if bullet:
        return ("text", bullet.group(1).strip())
    return ("text", line.strip())


class MistralOcrAdapter:
    def __init__(
        self,
        api_key: str,
        *,
        model: str = DEFAULT_MISTRAL_MODEL,
        emit_tables: bool = True,
        opener: Any | None = None,
        sleep: Callable[[float], None] = time.sleep,
        progress: Callable[[int, int], None] | None = None,
    ) -> None:
        if len(api_key) < 20:
            raise ProcessingError("worker_config_invalid", "Mistral API key is missing or too short")
        self.api_key = api_key
        self.model = model
        # The `tables_on/tables_off` ablation. OpenAI always emits `tables: []`, and
        # `interpret-document` forwards `tables[]` to the interpreting model
        # (`core.ts:699,752`), so populating it changes the downstream prompt as well as the OCR
        # output. Measuring both isolates "the model read better" from "the interpreter got more".
        self.emit_tables = emit_tables
        self.injected_opener = opener
        self.thread_local = local()
        self.sleep = sleep
        # Filled per call so the harness can record what the provider actually served. An alias
        # that silently moves mid-run invalidates the comparison, so the run fails on a change.
        self.observed_models: list[str] = []
        self.observed_pages_processed = 0
        self.progress = progress
        self.progress_lock = Lock()
        self.progress_done = 0
        self.progress_total: int | None = None

    # -- progress --------------------------------------------------------------------------

    def begin_progress(self, total_pages: int) -> None:
        """Declare the DOCUMENT's page count before the first batch.

        `extract()` cannot infer it: a PDF is rendered in memory-bounded batches, so `len(pages)`
        there is the batch and not the document. Same contract as `OpenAiOcrAdapter`, because
        `worker._extract_document` calls this on whichever adapter is configured.
        """
        with self.progress_lock:
            self.progress_done = 0
            self.progress_total = total_pages if total_pages > 0 else None

    def _report_page_done(self, total: int) -> None:
        if self.progress is None:
            return
        with self.progress_lock:
            self.progress_done += 1
            done = min(self.progress_done, total)
        try:
            self.progress(done, total)
        except Exception:
            # A status line must never be able to fail a paid transcription.
            pass

    # -- transport -------------------------------------------------------------------------

    def _request_body(self, image_bytes: bytes) -> bytes:
        payload = {
            "model": self.model,
            "document": {"type": "image_url", "image_url": _data_uri(image_bytes)},
            # Real paragraph geometry and graded confidence, the two things the current adapter
            # cannot produce. Both are the reason this benchmark exists.
            "include_blocks": True,
            "confidence_scores_granularity": "block",
            # Deliberately absent: bbox_annotation_format / document_annotation_format. They
            # invoke an extra model pass and would turn OCR-vs-OCR into OCR-vs-OCR+LLM.
        }
        return json.dumps(payload).encode("utf-8")

    def _post(self, body: bytes, limits: ExtractionLimits) -> dict[str, Any]:
        request = urllib.request.Request(
            MISTRAL_OCR_URL,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
        )
        try:
            opener = self.injected_opener
            if opener is None:
                opener = getattr(self.thread_local, "opener", None)
                if opener is None:
                    opener = urllib.request.build_opener(_NoRedirect())
                    self.thread_local.opener = opener
            with opener.open(request, timeout=limits.tool_timeout_seconds) as response:
                raw = response.read(MISTRAL_MAX_RESPONSE_BYTES + 1)
                status = response.status
        except urllib.error.HTTPError as exc:
            raw = exc.read(64 * 1024)
            status = exc.code
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ProcessingError(
                "ocr_provider_unavailable", "OCR provider is unavailable", retryable=True
            ) from exc
        if not 200 <= status < 300:
            raise ProcessingError(
                "ocr_provider_rate_limited" if status == 429 else "ocr_provider_unavailable",
                "OCR provider rejected the request",
                retryable=status in MISTRAL_RETRYABLE_STATUS,
            )
        if len(raw) > MISTRAL_MAX_RESPONSE_BYTES:
            raise ProcessingError("ocr_invalid_output", "OCR provider response is too large")
        try:
            envelope = json.loads(raw.decode("utf-8", "strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProcessingError("ocr_invalid_output", "OCR provider returned invalid JSON") from exc
        if type(envelope) is not dict:
            raise ProcessingError("ocr_invalid_output", "OCR provider returned an invalid response")
        return envelope

    def transcribe_page(self, page: PageImage, limits: ExtractionLimits) -> dict[str, Any]:
        """One billed call. Returns the raw provider envelope so the harness can cache it."""
        try:
            image_bytes = page.path.read_bytes()
        except OSError as exc:
            raise ProcessingError("ocr_failed", "Rendered page could not be read") from exc
        body = self._request_body(image_bytes)
        try:
            envelope = retry_call(
                lambda: self._post(body, limits),
                attempts=MISTRAL_ATTEMPTS,
                retryable=lambda exc: isinstance(exc, ProcessingError) and exc.retryable,
                sleep=self.sleep,
                base_seconds=0.5,
                max_seconds=4.0,
            )
        except ProcessingError as exc:
            # Same cost ceiling as the OpenAI adapter: the adapter already retried, so the job
            # runner must not multiply paid calls again.
            if exc.retryable:
                raise ProcessingError(exc.code, exc.safe_message, retryable=False) from exc
            raise
        served = envelope.get("model")
        if type(served) is str and served:
            self.observed_models.append(served)
        usage = envelope.get("usage_info")
        if type(usage) is dict and type(usage.get("pages_processed")) is int:
            self.observed_pages_processed += usage["pages_processed"]
        return envelope

    # -- mapping ---------------------------------------------------------------------------

    def page_payload(
        self, envelope: dict[str, Any], page_number: int
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str, int]:
        """Provider envelope -> (blocks, tables, page text, measured-geometry count).

        Pure. The harness re-runs this over cached envelopes for free, which is why every mapping
        decision can be revised without paying the provider again.
        """
        pages = envelope.get("pages")
        if type(pages) is not list or not pages:
            raise ProcessingError("ocr_invalid_output", "OCR provider returned no pages")
        if len(pages) != 1:
            raise ProcessingError("ocr_invalid_output", "Per-page call returned more than one page")
        page = pages[0]
        if type(page) is not dict:
            raise ProcessingError("ocr_invalid_output", "OCR provider returned an invalid page")

        dimensions = page.get("dimensions") if type(page.get("dimensions")) is dict else {}
        width = dimensions.get("width") if type(dimensions.get("width")) is int else 0
        height = dimensions.get("height") if type(dimensions.get("height")) is int else 0

        raw_blocks = page.get("blocks")
        if type(raw_blocks) is list and raw_blocks:
            entries = self._entries_from_blocks(raw_blocks, width, height)
        else:
            markdown = page.get("markdown")
            if type(markdown) is not str:
                raise ProcessingError("ocr_invalid_output", "OCR provider returned no page content")
            entries = self._entries_from_markdown(markdown)

        total = len(entries)
        blocks: list[dict[str, Any]] = []
        measured = 0
        for index, entry in enumerate(entries, start=1):
            bbox = entry["bbox"]
            if bbox is None:
                # Synthesised reading-order band, identical to `src/ocr.py:353-355`. Full width
                # claims no horizontal precision; the vertical band is true by construction.
                bbox = [0.0, (index - 1) / total, 1.0, index / total]
            else:
                measured += 1
            blocks.append(
                {
                    "id": f"mistral-p{page_number}-b{index}",
                    "page": page_number,
                    "type": entry["type"],
                    "bbox": bbox,
                    "text": entry["text"],
                    "confidence": entry["confidence"],
                }
            )

        tables = self._tables_from_entries(entries, page_number) if self.emit_tables else []
        page_text = "\n".join(block["text"] for block in blocks if block["text"])
        return blocks, tables, page_text, measured

    def _entries_from_blocks(
        self, raw_blocks: list[Any], width: int, height: int
    ) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for raw in raw_blocks:
            if type(raw) is not dict:
                raise ProcessingError("ocr_invalid_output", "OCR provider returned an invalid block")
            label = raw.get("type")
            content = raw.get("content")
            if type(content) is not str:
                content = ""
            block_type = BLOCK_TYPE_MAP.get(label if type(label) is str else "", "text")
            bbox = _measured_bbox(raw, width, height)
            confidence = _block_confidence(raw)
            if block_type == "table":
                # A table block carries several Markdown rows. Each becomes its own block so the
                # rows are addressable: `interpret-document` rejects any `evidence_block_ids`
                # entry that is not present in `blocks[]` (`core.ts:974,1006-1009`), so a line
                # item with no block of its own could never be cited as evidence. Same reason
                # `parsers._spreadsheet_contract` appends both a table and a block
                # (`parsers.py:152,158`).
                rows = [
                    line
                    for line in content.splitlines()
                    if _TABLE_ROW_RE.match(line) and not (_TABLE_SEPARATOR_RE.match(line) and "-" in line)
                ]
                if rows:
                    for row in rows:
                        entries.append(
                            {"type": "table", "text": row.strip(), "bbox": bbox, "confidence": confidence}
                        )
                    continue
            if block_type in ("image", "handwriting") and not content.strip():
                # A figure or a signature legitimately carries no text, and the detected region is
                # itself the finding. Dropping it would discard evidence that something is there;
                # emitting it with `text: ""` reports exactly what the provider said and no more.
                entries.append({"type": block_type, "text": "", "bbox": bbox, "confidence": confidence})
                continue
            for line in content.splitlines() or [""]:
                classified = _classify_markdown_line(line)
                if classified is None:
                    continue
                _, text = classified
                entries.append(
                    {"type": block_type, "text": text, "bbox": bbox, "confidence": confidence}
                )
        return entries

    def _entries_from_markdown(self, markdown: str) -> list[dict[str, Any]]:
        entries: list[dict[str, Any]] = []
        for line in markdown.splitlines():
            classified = _classify_markdown_line(line)
            if classified is None:
                continue
            block_type, text = classified
            entries.append({"type": block_type, "text": text, "bbox": None, "confidence": None})
        return entries

    def _tables_from_entries(
        self, entries: list[dict[str, Any]], page_number: int
    ) -> list[dict[str, Any]]:
        tables: list[dict[str, Any]] = []
        run: list[str] = []

        def flush() -> None:
            if not run:
                return
            rows = [[{"text": cell, "bbox": None} for cell in _split_table_row(line)] for line in run]
            tables.append(
                {
                    "id": f"mistral-p{page_number}-t{len(tables) + 1}",
                    "page": page_number,
                    # Cell geometry is not returned; a full-page box is the existing precedent for
                    # a table whose corners are unknown (`parsers.py:40` FULL_BBOX).
                    "bbox": [0.0, 0.0, 1.0, 1.0],
                    "rows": rows,
                }
            )
            run.clear()

        for entry in entries:
            if entry["type"] == "table" and _TABLE_ROW_RE.match(entry["text"]):
                run.append(entry["text"])
            else:
                flush()
        flush()
        return tables

    # -- OcrAdapter protocol ---------------------------------------------------------------

    def extract(self, pages: list[PageImage], limits: ExtractionLimits = DEFAULT_LIMITS) -> dict[str, Any]:
        blocks: list[dict[str, Any]] = []
        tables: list[dict[str, Any]] = []
        page_text: list[str] = []
        self.measured_geometry_blocks = 0
        # Deliberately NOT reset: on the batched PDF path `extract` runs once per batch, and
        # resetting here restarts the counter mid-document. `begin_progress()` owns the reset.
        page_count = self.progress_total if self.progress_total is not None else len(pages)
        # One billed call per page and a 2.2s median document leave no case for page concurrency
        # here yet; the OpenAI adapter needs it only because it pays for two or three passes.
        for page in pages:
            envelope = self.transcribe_page(page, limits)
            page_blocks, page_tables, text, measured = self.page_payload(envelope, page.page)
            blocks.extend(page_blocks)
            tables.extend(page_tables)
            page_text.append(text)
            self.measured_geometry_blocks += measured
            self._report_page_done(page_count)

        plain_text = "\n\n".join(page_text)
        if len(plain_text) > limits.max_text_chars:
            raise ProcessingError("text_length_limit", "Extracted text exceeds the text limit")
        return {
            "schema_version": "1",
            "document": {
                "page_count": max((page.page for page in pages), default=1),
                # The API returns no language claim. `parsers._languages` derives one from the
                # characters actually present, but running it here would make this adapter's
                # contract differ from OpenAI's in a second place at once; the harness computes it
                # for both arms instead, at scoring time.
                "detected_languages": [],
                "plain_text": plain_text,
                # Every page in `pages` was sent and a failure raises rather than skipping, so
                # nothing went unlooked-at. Same reasoning as `src/ocr.py:365-380`.
                "partial": False,
            },
            "blocks": blocks,
            "tables": tables,
            "marks": [],
        }
