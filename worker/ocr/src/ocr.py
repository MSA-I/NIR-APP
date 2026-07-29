from __future__ import annotations

import csv
import io
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from .errors import ProcessingError
from .limits import ExtractionLimits


@dataclass(frozen=True, slots=True)
class PageImage:
    page: int
    path: Path
    width: int
    height: int


class OcrAdapter(Protocol):
    def extract(self, pages: list[PageImage], limits: ExtractionLimits) -> dict[str, Any]: ...


class DisabledOcrAdapter:
    def extract(self, pages: list[PageImage], limits: ExtractionLimits) -> dict[str, Any]:
        del pages, limits
        raise ProcessingError(
            "ocr_model_not_selected",
            "No production OCR model has passed the required benchmark",
        )


class TesseractOcrAdapter:
    """CPU baseline only; selection as production default requires benchmark evidence."""

    def __init__(self, languages: str = "heb+eng") -> None:
        self.languages = languages

    @staticmethod
    def version() -> str:
        try:
            result = subprocess.run(
                ["tesseract", "--version"],
                capture_output=True,
                text=True,
                check=True,
                timeout=10,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise ProcessingError("ocr_runtime_unavailable", "Tesseract runtime is unavailable") from exc
        return result.stdout.splitlines()[0].strip()[:200]

    def extract(self, pages: list[PageImage], limits: ExtractionLimits) -> dict[str, Any]:
        blocks: list[dict[str, Any]] = []
        page_text: list[str] = []
        for page in pages:
            try:
                result = subprocess.run(
                    [
                        "tesseract",
                        str(page.path),
                        "stdout",
                        "-l",
                        self.languages,
                        "--psm",
                        "6",
                        "tsv",
                    ],
                    capture_output=True,
                    check=True,
                    timeout=limits.tool_timeout_seconds,
                )
            except subprocess.TimeoutExpired as exc:
                raise ProcessingError("ocr_timeout", "OCR exceeded its time limit", retryable=True) from exc
            except (OSError, subprocess.CalledProcessError) as exc:
                raise ProcessingError("ocr_failed", "OCR engine failed", retryable=True) from exc
            try:
                decoded = result.stdout.decode("utf-8", "strict")
            except UnicodeDecodeError as exc:
                raise ProcessingError("ocr_invalid_output", "OCR returned invalid UTF-8") from exc

            grouped: dict[tuple[str, str, str], list[dict[str, str]]] = {}
            for row in csv.DictReader(io.StringIO(decoded), delimiter="\t"):
                text = (row.get("text") or "").strip()
                if not text:
                    continue
                key = (row.get("block_num", "0"), row.get("par_num", "0"), row.get("line_num", "0"))
                grouped.setdefault(key, []).append(row)

            lines: list[str] = []
            for line_index, words in enumerate(grouped.values(), start=1):
                text = " ".join((word.get("text") or "").strip() for word in words).strip()
                if not text:
                    continue
                try:
                    left = min(int(word["left"]) for word in words)
                    top = min(int(word["top"]) for word in words)
                    right = max(int(word["left"]) + int(word["width"]) for word in words)
                    bottom = max(int(word["top"]) + int(word["height"]) for word in words)
                    confidences = [float(word["conf"]) for word in words if float(word["conf"]) >= 0]
                except (KeyError, TypeError, ValueError) as exc:
                    raise ProcessingError("ocr_invalid_output", "OCR returned malformed coordinates") from exc
                confidence = None if not confidences else max(0.0, min(1.0, sum(confidences) / len(confidences) / 100))
                blocks.append(
                    {
                        "id": f"ocr-p{page.page}-l{line_index}",
                        "page": page.page,
                        "type": "text",
                        "bbox": [
                            max(0.0, min(1.0, left / page.width)),
                            max(0.0, min(1.0, top / page.height)),
                            max(0.0, min(1.0, right / page.width)),
                            max(0.0, min(1.0, bottom / page.height)),
                        ],
                        "text": text,
                        "confidence": confidence,
                    }
                )
                lines.append(text)
            page_text.append("\n".join(lines))

        plain_text = "\n\n".join(page_text)
        if len(plain_text) > limits.max_text_chars:
            raise ProcessingError("text_length_limit", "Extracted text exceeds the text limit")
        return {
            "schema_version": "1",
            "document": {
                "page_count": max((page.page for page in pages), default=1),
                "detected_languages": [],
                "plain_text": plain_text,
                "partial": True,
            },
            "blocks": blocks,
            "tables": [],
            "marks": [],
        }


def create_ocr_adapter(name: str) -> OcrAdapter:
    normalized = name.strip().lower()
    if normalized == "disabled":
        return DisabledOcrAdapter()
    if normalized == "tesseract":
        return TesseractOcrAdapter()
    raise ProcessingError("ocr_adapter_invalid", "Configured OCR adapter is not supported")
