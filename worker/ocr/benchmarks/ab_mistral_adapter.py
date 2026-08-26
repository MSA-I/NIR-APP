"""Benchmark entry point for the Mistral adapter.

The class itself lives in `src/ocr_mistral.py` and is what the worker runs in production. The
benchmark imports it rather than keeping a copy, so "what was measured" and "what ships" cannot
drift apart -- the failure mode this file existed to create when it held its own copy.

`emit_tables` stays a constructor flag because the `tables_on/tables_off` ablation needs it:
`interpret-document` forwards `tables[]` to the interpreting model (`core.ts:699,752`), so
populating it changes the downstream prompt as well as the OCR output.
"""

from __future__ import annotations

from src.ocr_mistral import (  # noqa: F401  -- re-exported for the harness
    DEFAULT_MISTRAL_MODEL,
    MISTRAL_ATTEMPTS,
    MISTRAL_MAX_RESPONSE_BYTES,
    MISTRAL_OCR_URL,
    MISTRAL_RETRYABLE_STATUS,
    MistralOcrAdapter,
)

__all__ = [
    "DEFAULT_MISTRAL_MODEL",
    "MISTRAL_ATTEMPTS",
    "MISTRAL_MAX_RESPONSE_BYTES",
    "MISTRAL_OCR_URL",
    "MISTRAL_RETRYABLE_STATUS",
    "MistralOcrAdapter",
]
