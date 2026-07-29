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


DEFAULT_LIMITS = ExtractionLimits()
