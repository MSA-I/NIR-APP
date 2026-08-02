#!/usr/bin/env python3
"""Run the real OpenAI OCR adapter over one document and print the extraction contract.

Deliberately NOT part of run.py. That harness executes models inside a --network=none container
and verifies pinned model-artifact hashes, which a hosted API cannot satisfy by construction:
there is no artifact to hash and the call needs the network. Weakening those checks to fit an
API provider would weaken them for the local candidates too.

This makes one real, billed call per rendered page. Digital PDFs and spreadsheets cost nothing --
the native parsers handle them and the adapter is never reached.

The image deliberately does not ship this file -- a diagnostic has no business in the production
worker image -- so it is bind-mounted next to src/ at run time:

    docker run --rm --network bridge \
      -e OPENAI_API_KEY=... -e OCR_OPENAI_MODEL=gpt-5.6-terra \
      -v "/abs/path/probe_openai.py:/app/probe_openai.py:ro" \
      -v "/abs/path/invoice.jpg:/input/source:ro" \
      --entrypoint python supplyflow-ocr-worker:acceptance \
      /app/probe_openai.py /input/source image/jpeg
"""

from __future__ import annotations

import json
import mimetypes
import os
import sys
from pathlib import Path

# Works both from the repo layout (benchmarks/) and bind-mounted straight into /app.
_here = Path(__file__).resolve().parent
sys.path[:0] = [str(_here), str(_here.parent)]

from src import DEFAULT_LIMITS, create_ocr_adapter, extract_file  # noqa: E402


def main() -> int:
    if not 2 <= len(sys.argv) <= 3:
        print("usage: probe_openai.py <source-file> [claimed-mime]", file=sys.stderr)
        return 2
    source = Path(sys.argv[1])
    if not source.is_file():
        print(f"not a file: {source}", file=sys.stderr)
        return 2
    claimed_mime = sys.argv[2] if len(sys.argv) == 3 else mimetypes.guess_type(source.name)[0]
    if not claimed_mime:
        print("could not guess the MIME type; pass it as the second argument", file=sys.stderr)
        return 2
    key = os.environ.get("OPENAI_API_KEY", "")
    if len(key) < 20:
        print("OPENAI_API_KEY is missing or too short", file=sys.stderr)
        return 2

    payload = extract_file(
        source,
        claimed_mime,
        adapter=create_ocr_adapter("openai", key),
        limits=DEFAULT_LIMITS,
    )
    # plain_text first: it is what a human compares against the page. The full contract follows
    # so block ids, pages and the synthesised bands can be inspected too.
    print("----- plain_text -----")
    print(payload["document"]["plain_text"])
    print("----- contract -----")
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
