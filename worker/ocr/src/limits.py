from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExtractionLimits:
    max_file_bytes: int = 10 * 1024 * 1024
    max_pdf_pages: int = 100
    max_spreadsheet_rows: int = 5_000
    max_spreadsheet_columns: int = 1_000
    max_text_chars: int = 2_000_000
    max_decompressed_bytes: int = 100 * 1024 * 1024
    max_payload_bytes: int = 25 * 1024 * 1024
    max_archive_entries: int = 10_000
    max_image_pixels: int = 40_000_000
    tool_timeout_seconds: int = 120
    # Pages sent to a paid OCR provider. A 100-page scan would be 100 billed calls and would blow
    # OCR_JOB_TIMEOUT_SECONDS long before it finished. Pages beyond the cap are never rendered and
    # never read, and `parsers._parse_pdf` now derives `document.partial` from exactly that -- the
    # claim this comment used to make is finally true rather than aspirational.
    #
    # Raising this doubles the provider bill for every long scan, so it is a cost decision and not
    # a knob to turn while widening a page ceiling somewhere else.
    max_ai_pages: int = 20


DEFAULT_LIMITS = ExtractionLimits()
