"""A/B OCR benchmark harness: production OpenAI adapter vs Mistral OCR.

Measurement instrument, not a migration. Nothing here is imported by the worker, nothing is
copied into the image (`benchmarks/` is excluded by `.dockerignore`), and no production file
changes to accommodate it.

The commands are split so that exactly one of them touches the network or a credential:

    plan       offline, no key   -- corpus manifest and OCR page budget
    render     offline, no key   -- production-faithful page PNGs (needs cv2 + pdftoppm)
    fetch      NETWORK + KEY     -- the only billed step; caches raw provider envelopes
    derive     offline, no key   -- envelopes -> ExtractionContract v1 (free, re-runnable)
    self-test  offline, no key   -- adapter mapping against recorded envelopes

That split is what makes credential isolation structural rather than a runtime guard:
`render` shells out to `pdftoppm`, which inherits `os.environ`, and it runs before any key has
been loaded. `fetch` loads a key and spawns nothing.

`plan` deliberately avoids importing `src`, so it runs on a bare Python with pypdf and Pillow.
Every other command imports `src` and therefore runs inside the worker image.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import unicodedata
from pathlib import Path
from typing import Any


HARNESS_VERSION = "1"

# Mirrors `src.limits.ExtractionLimits`. Duplicated here, and only here, because `plan` must run
# without the worker's dependency set; `assert_limits_match()` fails the run if they ever diverge.
MAX_AI_PAGES = 20
MAX_PDF_PAGES = 100

IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"}

_MAGIC = (
    (b"%PDF", "application/pdf"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"II*\x00", "image/tiff"),
    (b"MM\x00*", "image/tiff"),
)


def _sniff(path: Path) -> str:
    """Enough magic-byte detection for a benchmark corpus.

    Deliberately not `src.mime.sniff_mime`: that pulls in `olefile` and the whole `src` package,
    which would stop `plan` running outside the image. The corpus is jpg/png/pdf/xlsx and the
    result is recorded in the manifest for review, so a wrong guess is visible rather than silent.
    """
    try:
        head = path.open("rb").read(32)
    except OSError:
        return "application/octet-stream"
    for prefix, mime in _MAGIC:
        if head.startswith(prefix):
            return mime
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"mif1", b"msf1"):
        return "image/heic"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:4] == b"PK\x03\x04":
        suffix = path.suffix.lower()
        return {
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        }.get(suffix, "application/zip")
    return "application/octet-stream"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _pdf_ocr_pages(path: Path) -> tuple[int, list[int], str | None]:
    """(page_count, pages with no text layer, error).

    This is `src.parsers._parse_pdf`'s own predicate (`parsers.py:625-632`), reproduced exactly:
    a PDF page reaches the OCR adapter only when `extract_text()` is empty after stripping.
    Any other rule would put pages in the corpus that production would never send to a provider,
    and the benchmark would be measuring pypdf.
    """
    from pypdf import PdfReader

    try:
        reader = PdfReader(path, strict=True)
    except Exception as exc:  # noqa: BLE001 - corpus triage, the reason is recorded
        return 0, [], f"unreadable: {type(exc).__name__}"
    if reader.is_encrypted:
        return 0, [], "encrypted"
    page_count = len(reader.pages)
    missing: list[int] = []
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:  # noqa: BLE001 - production swallows this identically
            text = ""
        if not text:
            missing.append(page_number)
    return page_count, missing, None


def _image_frames(path: Path) -> tuple[int, str | None]:
    from PIL import Image, ImageSequence

    try:
        with Image.open(path) as image:
            return sum(1 for _ in ImageSequence.Iterator(image)), None
    except Exception as exc:  # noqa: BLE001
        return 0, f"unreadable: {type(exc).__name__}"


def _doc_type_hint(name: str) -> str:
    lowered = name.lower()
    for needle, value in (
        ("credit-note", "credit_note"),
        ("delivery-note", "delivery_note"),
        ("price-list", "price_list"),
        ("invoice", "invoice"),
        ("receipt", "receipt"),
    ):
        if needle in lowered:
            return value
    return "unknown"


def _load_adjudication(corpus_dirs: list[Path]) -> dict[str, dict[str, Any]]:
    known: dict[str, dict[str, Any]] = {}
    for directory in corpus_dirs:
        source = directory / "adjudication.json"
        if not source.exists():
            continue
        try:
            rows = json.loads(source.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for row in rows if type(rows) is list else []:
            if type(row) is dict and type(row.get("file")) is str:
                known[row["file"]] = row
    return known


def command_plan(args: argparse.Namespace) -> int:
    import os

    corpus_dirs = [Path(item).resolve() for item in args.corpus]
    missing_dirs = [str(item) for item in corpus_dirs if not item.is_dir()]
    if missing_dirs:
        print(json.dumps({"error": "corpus directory not found", "paths": missing_dirs}, ensure_ascii=False))
        return 2

    # `render` runs inside the worker image, where the Windows paths recorded below mean nothing.
    # Storing a root plus a relative path lets it re-join against the container mount point, and
    # keeps Hebrew directory names out of every command line.
    docs_root = Path(os.path.commonpath([str(item) for item in corpus_dirs]))

    adjudicated = _load_adjudication(corpus_dirs)
    documents: list[dict[str, Any]] = []
    seen_hashes: dict[str, str] = {}

    for directory in corpus_dirs:
        for path in sorted(p for p in directory.iterdir() if p.is_file()):
            if path.name in {"manifest.json", "adjudication.json"} or path.suffix.lower() == ".json":
                continue
            mime = _sniff(path)
            digest = _sha256(path)
            doc_id = f"{directory.name}/{path.name}"
            record: dict[str, Any] = {
                "doc_id": doc_id,
                # Filesystem- and container-safe handle. The corpus has Hebrew names and spaces;
                # deriving the directory from the hash keeps both out of every later path.
                "slug": digest[:12],
                "path": str(path),
                "rel_path": path.relative_to(docs_root).as_posix(),
                "sha256": digest,
                "bytes": path.stat().st_size,
                "claimed_mime": mime,
                "input_class": None,
                "page_count": 0,
                "ocr_bound_pages": [],
                "ocr_page_budget": [],
                "unattempted_pages": [],
                "partial_expected": False,
                "excluded": None,
                "strata": {
                    "lane": None,
                    "doc_type": adjudicated.get(path.name, {}).get("true_type") or _doc_type_hint(path.name),
                    # Filled by `render` from the real ScanResult metrics -- never guessed here.
                    "degradation": None,
                    "provenance": "internet" if (directory / "manifest.json").exists() else "owner_capture",
                },
                "adjudicated": path.name in adjudicated,
                "error": None,
            }

            if digest in seen_hashes:
                record["excluded"] = "duplicate_of:" + seen_hashes[digest]
                documents.append(record)
                continue
            seen_hashes[digest] = doc_id

            if mime in IMAGE_MIMES:
                frames, error = _image_frames(path)
                record["error"] = error
                record["page_count"] = frames
                record["ocr_bound_pages"] = list(range(1, frames + 1))
                record["input_class"] = "image"
                record["strata"]["lane"] = "phone_photo"
                if error or frames == 0:
                    record["excluded"] = "unreadable"
            elif mime == "application/pdf":
                page_count, missing, error = _pdf_ocr_pages(path)
                record["error"] = error
                record["page_count"] = page_count
                record["ocr_bound_pages"] = missing
                record["strata"]["lane"] = "scanned_pdf"
                if error:
                    record["excluded"] = "unreadable"
                elif not 1 <= page_count <= MAX_PDF_PAGES:
                    record["input_class"] = "pdf_digital"
                    record["excluded"] = "page_limit"
                elif not missing:
                    record["input_class"] = "pdf_digital"
                    # Every page carries a text layer, so production never calls a provider for
                    # this document. Including it would measure pypdf, not OCR.
                    record["excluded"] = "no_ocr_pages"
                elif len(missing) == page_count:
                    record["input_class"] = "pdf_scanned"
                else:
                    record["input_class"] = "pdf_mixed"
            else:
                record["input_class"] = "other"
                record["excluded"] = "not_ocr_path"

            budget = record["ocr_bound_pages"][:MAX_AI_PAGES]
            unattempted = record["ocr_bound_pages"][MAX_AI_PAGES:]
            record["ocr_page_budget"] = budget
            record["unattempted_pages"] = unattempted
            # `parsers.py:732` derives the shipped flag from exactly this.
            record["partial_expected"] = bool(unattempted)
            documents.append(record)

    included = [item for item in documents if item["excluded"] is None]
    totals = {
        "documents_found": len(documents),
        "documents_included": len(included),
        "documents_excluded": len(documents) - len(included),
        "ocr_pages": sum(len(item["ocr_page_budget"]) for item in included),
        "documents_with_partial_expected": sum(1 for item in included if item["partial_expected"]),
        "by_lane": {
            lane: {
                "documents": sum(1 for item in included if item["strata"]["lane"] == lane),
                "pages": sum(len(item["ocr_page_budget"]) for item in included if item["strata"]["lane"] == lane),
            }
            for lane in ("phone_photo", "scanned_pdf")
        },
        "excluded_reasons": _counts(item["excluded"] for item in documents if item["excluded"]),
        "by_doc_type": _counts(item["strata"]["doc_type"] for item in included),
    }

    manifest = {
        "schema_version": "1",
        "harness_version": HARNESS_VERSION,
        "corpus_dirs": [str(item) for item in corpus_dirs],
        "docs_root": str(docs_root),
        "limits": {"max_ai_pages": MAX_AI_PAGES, "max_pdf_pages": MAX_PDF_PAGES},
        "totals": totals,
        "documents": documents,
    }

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    target = out / "corpus.json"
    target.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"written": str(target), "totals": totals}, ensure_ascii=False, indent=2))
    return 0


def _counts(values: Any) -> dict[str, int]:
    result: dict[str, int] = {}
    for value in values:
        key = str(value)
        result[key] = result.get(key, 0) + 1
    return dict(sorted(result.items()))


# ---------------------------------------------------------------------------------------------
# render: offline, no key. Needs cv2 and pdftoppm, so it runs inside the worker image.
# ---------------------------------------------------------------------------------------------

# Objective split, from the measured separation recorded in `src/scanning.py:431-437`: real
# captures ran 345-8717 Laplacian variance and 137-245 luma, blurred and darkened variants ran
# 60-76 and 58-65. Nothing here is judged by eye.
DEGRADED_LAPLACIAN = 200.0
DEGRADED_LUMA = 100.0
DEGRADED_PIXELS = 700_000


def _degradation(metrics: dict[str, Any], width: int, height: int) -> str:
    variance = metrics.get("raw_laplacian_variance")
    luma = metrics.get("raw_luma_mean")
    if type(variance) in (int, float) and float(variance) < DEGRADED_LAPLACIAN:
        return "degraded"
    if type(luma) in (int, float) and float(luma) < DEGRADED_LUMA:
        return "degraded"
    if width * height < DEGRADED_PIXELS:
        return "degraded"
    return "clean"


def command_render(args: argparse.Namespace) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import shutil
    import tempfile

    from src.errors import ProcessingError
    from src.limits import DEFAULT_LIMITS
    from src.parsers import _render_pdf_page
    from src.scanning import scan_document

    run = Path(args.run).resolve()
    manifest_path = run / "corpus.json"
    if not manifest_path.exists():
        print(json.dumps({"error": "corpus.json not found; run `plan` first", "path": str(manifest_path)}))
        return 2
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    docs_root = Path(args.docs_root) if args.docs_root else Path(manifest["docs_root"])

    pages_root = run / "pages"
    pages_root.mkdir(parents=True, exist_ok=True)
    rendered: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []

    for record in manifest["documents"]:
        if record["excluded"]:
            continue
        source = docs_root / record["rel_path"]
        target_dir = pages_root / record["slug"]
        target_dir.mkdir(parents=True, exist_ok=True)
        if not source.exists():
            failures.append({"doc_id": record["doc_id"], "error": "source missing", "path": str(source)})
            continue

        try:
            if record["input_class"] == "image":
                if record["page_count"] != 1:
                    # A multi-frame image would need one scan per frame, and the corpus has none.
                    # Failing is honest; silently rendering frame 1 would understate the document.
                    raise ProcessingError("page_limit", "Multi-frame image is not supported by the harness")
                output = target_dir / "p01.png"
                # The production image lane: every uploaded image is preprocessed by the scan job
                # before OCR claims it (`0136:493-497`, `claim_document_processing_job_input`), so
                # the provider never sees the original capture. Feeding the raw JPEG here would
                # measure a pipeline that does not exist.
                harness_corners = False
                try:
                    result = scan_document(source, output, mode="auto", limits=DEFAULT_LIMITS)
                except ProcessingError as exc:
                    if exc.code != "document_not_detected":
                        raise
                    # Production hands this document back to a person to drag the corners
                    # (`DocumentScanPreview`). Dropping it here would quietly remove the hardest
                    # captures from the corpus, so the harness supplies the full frame -- the same
                    # choice a reviewer makes for a page that fills the photo -- and records that
                    # it did. The count is itself a reported number, not a hidden repair.
                    harness_corners = True
                    result = scan_document(
                        source,
                        output,
                        corners=((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)),
                        mode="auto",
                        limits=DEFAULT_LIMITS,
                    )
                rendered.append(
                    {
                        "harness_manual_corners": harness_corners,
                        "doc_id": record["doc_id"],
                        "slug": record["slug"],
                        "page": 1,
                        "lane": "phone_photo",
                        "rel_png": f"{record['slug']}/p01.png",
                        "sha256": result.output_sha256,
                        "bytes": result.output_bytes,
                        "width": result.width,
                        "height": result.height,
                        "scan": {
                            "output_mode": result.output_mode,
                            "corners_source": result.corners_source,
                            "rotation_degrees": result.rotation_degrees,
                            "metrics": result.metrics,
                        },
                        "degradation": _degradation(result.metrics, result.width, result.height),
                    }
                )
            else:
                # `_render_pdf_page` writes beside the source, and the corpus mount is read-only.
                with tempfile.TemporaryDirectory() as scratch:
                    staged = Path(scratch) / "source.pdf"
                    shutil.copyfile(source, staged)
                    for page_number in record["ocr_page_budget"]:
                        page = _render_pdf_page(staged, page_number, DEFAULT_LIMITS)
                        output = target_dir / f"p{page_number:02d}.png"
                        shutil.move(str(page.path), output)
                        rendered.append(
                            {
                                "doc_id": record["doc_id"],
                                "slug": record["slug"],
                                "page": page_number,
                                "lane": "scanned_pdf",
                                "rel_png": f"{record['slug']}/p{page_number:02d}.png",
                                "sha256": _sha256(output),
                                "bytes": output.stat().st_size,
                                "width": page.width,
                                "height": page.height,
                                "scan": None,
                                # No scan lane, so no measured capture quality. `clean` by
                                # construction rather than by measurement, and labelled as such.
                                "degradation": "clean",
                            }
                        )
        except ProcessingError as exc:
            failures.append({"doc_id": record["doc_id"], "error": exc.code, "message": exc.safe_message})
        except Exception as exc:  # noqa: BLE001 - a render failure is data, not a crash
            failures.append({"doc_id": record["doc_id"], "error": type(exc).__name__, "message": str(exc)})

    summary = {
        "pages_rendered": len(rendered),
        "documents_rendered": len({item["doc_id"] for item in rendered}),
        "failures": len(failures),
        "by_lane": _counts(item["lane"] for item in rendered),
        "by_degradation": _counts(item["degradation"] for item in rendered),
        "by_output_mode": _counts(
            item["scan"]["output_mode"] for item in rendered if item["scan"]
        ),
        "by_corners_source": _counts(
            item["scan"]["corners_source"] for item in rendered if item["scan"]
        ),
        # Captures the detector refused. In production each of these stops for a human to drag
        # the corners, so the number is a product metric and not a harness detail.
        "harness_manual_corners": sum(1 for item in rendered if item.get("harness_manual_corners")),
    }
    (run / "pages.json").write_text(
        json.dumps(
            {
                "schema_version": "1",
                "harness_version": HARNESS_VERSION,
                "summary": summary,
                "pages": rendered,
                "failures": failures,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"written": str(run / "pages.json"), "summary": summary, "failures": failures}, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


# ---------------------------------------------------------------------------------------------
# fetch / derive. One implementation, two names: `fetch` allows the network, `derive` forbids it
# and replays the cache. That is the whole point -- every mapping decision can be revised for
# free, and no page is ever billed twice.
# ---------------------------------------------------------------------------------------------

# $4 per 1,000 pages for OCR 4.1 (docs.mistral.ai, checked 2026-08-18). Used only for the
# dry-run estimate; the reported figure comes from `usage_info.pages_processed`.
MISTRAL_USD_PER_1000_PAGES = 4.0


class _CachedResponse:
    def __init__(self, body: bytes, status: int) -> None:
        self._body = body
        self.status = status

    def read(self, _limit: int | None = None) -> bytes:
        return self._body

    def __enter__(self) -> "_CachedResponse":
        return self

    def __exit__(self, *_args: Any) -> bool:
        return False


class CachingOpener:
    """Record-and-replay HTTP layer shared by both arms.

    Keyed on sha256(url + body) with the calls for one key kept as an ordered list. The ordering
    matters and is not decoration: the OpenAI consensus layer sends the SAME body two or three
    times and depends on the replies possibly differing (`src/ocr.py:387-416`). A cache that
    returned the first reply for every repeat would make consensus always agree and would silently
    delete the only per-line quality signal the product has.

    Authorization headers are never written to disk.
    """

    def __init__(self, cache_dir: Path, *, allow_network: bool) -> None:
        import threading
        import urllib.request as _urllib_request

        from src.gateway import _NoRedirect

        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.allow_network = allow_network
        self._lock = threading.Lock()
        self._consumed: dict[str, int] = {}
        self._real = _urllib_request.build_opener(_NoRedirect())
        self.calls = 0
        self.cache_hits = 0
        self.network_calls = 0
        self.durations_ms: list[float] = []

    def _key(self, request: Any) -> str:
        digest = hashlib.sha256()
        digest.update(request.full_url.encode("utf-8"))
        digest.update(b"\n")
        digest.update(request.data or b"")
        return digest.hexdigest()

    def _entries(self, key: str) -> list[dict[str, Any]]:
        path = self.cache_dir / f"{key}.jsonl"
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def open(self, request: Any, timeout: float | None = None) -> _CachedResponse:
        import time as _time
        import urllib.error as _urllib_error

        key = self._key(request)
        with self._lock:
            self.calls += 1
            index = self._consumed.get(key, 0)
            entries = self._entries(key)
            if index < len(entries):
                self._consumed[key] = index + 1
                self.cache_hits += 1
                entry = entries[index]
                self.durations_ms.append(float(entry.get("duration_ms", 0.0)))
                body = entry["body"].encode("utf-8")
                status = int(entry["status"])
                if status >= 300:
                    raise _urllib_error.HTTPError(request.full_url, status, "cached", {}, None)
                return _CachedResponse(body, status)
            self._consumed[key] = index + 1

        if not self.allow_network:
            raise ProcessingErrorProxy(
                "ocr_provider_unavailable",
                "cache miss while offline: run `fetch` before `derive`",
            )

        started = _time.monotonic()
        try:
            with self._real.open(request, timeout=timeout) as response:
                body = response.read()
                status = response.status
        except _urllib_error.HTTPError as exc:
            body = exc.read()
            status = exc.code
            self._append(key, body, status, (_time.monotonic() - started) * 1000)
            raise
        duration_ms = (_time.monotonic() - started) * 1000
        self._append(key, body, status, duration_ms)
        with self._lock:
            self.network_calls += 1
            self.durations_ms.append(duration_ms)
        return _CachedResponse(body, status)

    def _append(self, key: str, body: bytes, status: int, duration_ms: float) -> None:
        entry = {
            "status": status,
            "duration_ms": round(duration_ms, 3),
            "body": body.decode("utf-8", "replace"),
        }
        with self._lock:
            with (self.cache_dir / f"{key}.jsonl").open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


class ProcessingErrorProxy(Exception):
    """Raised before `src` is importable in a caller's scope; carries the same code shape."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.safe_message = message
        self.retryable = False


def _read_key(path: Path) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise SystemExit(f"key file could not be read: {path} ({type(exc).__name__})") from exc
    if len(value) < 20:
        raise SystemExit(f"key file is empty or too short: {path}")
    return value


def _run_arm(args: argparse.Namespace, *, allow_network: bool) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

    from src.errors import ProcessingError
    from src.limits import DEFAULT_LIMITS
    from src.ocr import OpenAiOcrAdapter, PageImage

    from ab_mistral_adapter import MistralOcrAdapter

    run = Path(args.run).resolve()
    pages_path = run / "pages.json"
    if not pages_path.exists():
        print(json.dumps({"error": "pages.json not found; run `render` first"}))
        return 2
    rendered = json.loads(pages_path.read_text(encoding="utf-8"))["pages"]

    by_doc: dict[str, list[dict[str, Any]]] = {}
    for page in rendered:
        by_doc.setdefault(page["slug"], []).append(page)
    for pages in by_doc.values():
        pages.sort(key=lambda item: item["page"])
    slugs = sorted(by_doc)
    if args.limit:
        slugs = slugs[: args.limit]

    arm = args.arm
    engine = "openai" if arm == "openai" else "mistral"
    cache_dir = run / "raw" / engine
    total_pages = sum(len(by_doc[slug]) for slug in slugs)

    if args.dry_run:
        opener = CachingOpener(cache_dir, allow_network=False)
        cached_keys = len(list(cache_dir.glob("*.jsonl"))) if cache_dir.exists() else 0
        estimate = {
            "arm": arm,
            "documents": len(slugs),
            "pages": total_pages,
            "cached_request_keys": cached_keys,
            "expected_provider_calls": total_pages * (3 if arm == "openai" else 1),
        }
        if engine == "mistral":
            estimate["estimated_usd"] = round(total_pages * MISTRAL_USD_PER_1000_PAGES / 1000, 4)
        else:
            # Vision token counts are not knowable before the call, so no number is invented here.
            estimate["estimated_usd"] = None
            estimate["note"] = "OpenAI cost is measured from the recorded usage block, not estimated"
        print(json.dumps(estimate, ensure_ascii=False, indent=2))
        return 0

    key_path = Path(args.key_file) if args.key_file else None
    api_key = _read_key(key_path) if key_path else ""
    if allow_network and not api_key:
        print(json.dumps({"error": "--key-file is required for fetch"}))
        return 2

    opener = CachingOpener(cache_dir, allow_network=allow_network)
    derived_dir = run / "derived" / arm
    derived_dir.mkdir(parents=True, exist_ok=True)

    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    observed_models: set[str] = set()
    mistral_pages_processed = 0

    import time as _time

    for slug in slugs:
        pages = by_doc[slug]
        page_images = [
            PageImage(page["page"], run / "pages" / page["rel_png"], page["width"], page["height"])
            for page in pages
        ]
        if arm == "openai":
            adapter: Any = OpenAiOcrAdapter(
                api_key or "x" * 32,
                opener=opener,
                qa_passes=args.qa_passes,
                page_concurrency=args.page_concurrency,
                sleep=lambda _s: None if not allow_network else _time.sleep(_s),
            )
        else:
            adapter = MistralOcrAdapter(
                api_key or "x" * 32,
                opener=opener,
                emit_tables=(arm != "mistral-tables-off"),
                sleep=lambda _s: None if not allow_network else _time.sleep(_s),
            )

        before_calls = opener.calls
        started = _time.monotonic()
        try:
            payload = adapter.extract(page_images, DEFAULT_LIMITS)
        except ProcessingError as exc:
            failures.append({"slug": slug, "doc_id": pages[0]["doc_id"], "error": exc.code, "message": exc.safe_message})
            continue
        except ProcessingErrorProxy as exc:
            failures.append({"slug": slug, "doc_id": pages[0]["doc_id"], "error": exc.code, "message": exc.safe_message})
            continue
        wall_ms = (_time.monotonic() - started) * 1000

        from src.contract import validate_extraction

        try:
            validated = validate_extraction(payload, DEFAULT_LIMITS)
        except ProcessingError as exc:
            failures.append({"slug": slug, "doc_id": pages[0]["doc_id"], "error": exc.code, "message": exc.safe_message})
            continue

        (derived_dir / f"{slug}.json").write_text(
            json.dumps(validated, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        if arm != "openai":
            observed_models.update(adapter.observed_models)
            mistral_pages_processed += adapter.observed_pages_processed
        results.append(
            {
                "slug": slug,
                "doc_id": pages[0]["doc_id"],
                "pages": len(pages),
                "provider_calls": opener.calls - before_calls,
                "document_wall_ms": round(wall_ms, 1),
                "blocks": len(validated["blocks"]),
                "tables": len(validated["tables"]),
                "chars": len(validated["document"]["plain_text"]),
                "measured_geometry_blocks": getattr(adapter, "measured_geometry_blocks", 0),
            }
        )

    if len(observed_models) > 1:
        # A moving alias mid-run makes every comparison in the report ambiguous.
        failures.append({"error": "model_alias_changed_mid_run", "observed": sorted(observed_models)})

    summary = {
        "arm": arm,
        "documents": len(results),
        "failures": len(failures),
        "provider_calls": opener.calls,
        "cache_hits": opener.cache_hits,
        "network_calls": opener.network_calls,
        "observed_models": sorted(observed_models),
        "mistral_pages_processed": mistral_pages_processed or None,
        "measured_usd": round(mistral_pages_processed * MISTRAL_USD_PER_1000_PAGES / 1000, 4)
        if mistral_pages_processed
        else None,
    }
    (run / f"arm-{arm}.json").write_text(
        json.dumps(
            {"schema_version": "1", "summary": summary, "documents": results, "failures": failures},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(json.dumps({"summary": summary, "failures": failures[:5]}, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


def command_fetch(args: argparse.Namespace) -> int:
    return _run_arm(args, allow_network=True)


def command_derive(args: argparse.Namespace) -> int:
    args.key_file = None
    return _run_arm(args, allow_network=False)


# ---------------------------------------------------------------------------------------------
# score -- tier 0 only. Every metric below is computable with NO ground truth and NO human hour,
# which is the point: if an arm fails here the study stops before anyone transcribes anything.
# Ground-truth metrics (CER, field accuracy, line recall, association) arrive in tier 1.
# ---------------------------------------------------------------------------------------------

_NUMBER_RE = __import__("re").compile(r"\d[\d,]*(?:\.\d+)?")
_MARKDOWN_RESIDUE_RE = __import__("re").compile(r"\*\*|__|`|^#{1,6}\s", __import__("re").MULTILINE)


def _numbers(text: str) -> list[float]:
    values: list[float] = []
    for match in _NUMBER_RE.findall(text):
        try:
            values.append(float(match.replace(",", "")))
        except ValueError:
            continue
    return values


def _row_arithmetic(plain_text: str) -> tuple[int, int]:
    """(candidate rows, rows whose numbers satisfy quantity x price = line total).

    A reference-free correctness proxy, and the cheapest one there is. It reproduces the identity
    `0108_document_reconciliation_assessment.sql:307-312` blocks a document on, but reads it off
    the OCR text instead of an interpretation, so it costs nothing and needs no human. A misread
    digit almost always breaks the identity; a correctly read row almost always satisfies it.

    It is a proxy and is reported as one: a line can carry three unrelated numbers, and a row
    whose quantity is 1 satisfies the identity trivially.
    """
    candidates = consistent = 0
    for line in plain_text.splitlines():
        values = _numbers(line)
        if len(values) < 3:
            continue
        candidates += 1
        found = False
        for i, left in enumerate(values):
            for j, right in enumerate(values):
                if i == j or left == 0 or right == 0:
                    continue
                product = left * right
                for k, total in enumerate(values):
                    if k in (i, j) or total == 0:
                        continue
                    if abs(product - total) <= max(0.05, abs(total) * 0.005):
                        found = True
                        break
                if found:
                    break
            if found:
                break
        consistent += int(found)
    return candidates, consistent


def command_score(args: argparse.Namespace) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

    from src.parsers import _hebrew_is_reversed

    from run import _edit_distance, _normalize_text, _percentile

    run = Path(args.run).resolve()
    arms = [item for item in args.arm] if args.arm else ["openai", "mistral"]

    per_arm: dict[str, Any] = {}
    texts: dict[str, dict[str, str]] = {}

    for arm in arms:
        derived_dir = run / "derived" / arm
        summary_path = run / f"arm-{arm}.json"
        if not derived_dir.is_dir() or not summary_path.exists():
            print(json.dumps({"error": f"arm {arm} has not been fetched"}))
            return 2
        arm_summary = json.loads(summary_path.read_text(encoding="utf-8"))
        engine = "openai" if arm == "openai" else "mistral"
        geometry_counts = {
            item["slug"]: item.get("measured_geometry_blocks", 0) for item in arm_summary["documents"]
        }

        documents: list[dict[str, Any]] = []
        texts[arm] = {}
        for path in sorted(derived_dir.glob("*.json")):
            payload = json.loads(path.read_text(encoding="utf-8"))
            plain = payload["document"]["plain_text"]
            texts[arm][path.stem] = plain
            candidates, consistent = _row_arithmetic(plain)
            blocks = payload["blocks"]
            documents.append(
                {
                    "slug": path.stem,
                    "chars": len(plain),
                    "blocks": len(blocks),
                    "tables": len(payload["tables"]),
                    "hebrew_reversed": _hebrew_is_reversed(plain),
                    "arithmetic_candidate_rows": candidates,
                    "arithmetic_consistent_rows": consistent,
                    "markdown_residue_blocks": sum(
                        1 for block in blocks if _MARKDOWN_RESIDUE_RE.search(block["text"])
                    ),
                    # Counted by the adapter at mapping time, not inferred from bbox shape here:
                    # a genuinely measured box may legitimately start at x=0, and guessing from
                    # the coordinates would undercount exactly the blocks flush to the margin.
                    "measured_geometry_blocks": geometry_counts.get(path.stem, 0),
                    "graded_confidence_blocks": sum(
                        1 for block in blocks if block["confidence"] not in (None, 0.0)
                    ),
                }
            )

        # Cost and per-call latency come from the recorded envelopes, which is the only place they
        # exist: production discards `usage` in `src/ocr.py:_parse`.
        call_ms: list[float] = []
        input_tokens = output_tokens = pages_processed = calls = 0
        for cache_file in (run / "raw" / engine).glob("*.jsonl"):
            for line in cache_file.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                entry = json.loads(line)
                calls += 1
                call_ms.append(float(entry.get("duration_ms", 0.0)))
                try:
                    body = json.loads(entry["body"])
                except json.JSONDecodeError:
                    continue
                usage = body.get("usage") or {}
                input_tokens += int(usage.get("input_tokens") or 0)
                output_tokens += int(usage.get("output_tokens") or 0)
                info = body.get("usage_info") or {}
                pages_processed += int(info.get("pages_processed") or 0)

        wall = [item["document_wall_ms"] for item in arm_summary["documents"]]
        candidates = sum(item["arithmetic_candidate_rows"] for item in documents)
        consistent = sum(item["arithmetic_consistent_rows"] for item in documents)
        total_blocks = sum(item["blocks"] for item in documents)
        per_arm[arm] = {
            "documents": len(documents),
            "contract_valid": len(documents),
            "failures": arm_summary["summary"]["failures"],
            "provider_calls": calls,
            "calls_per_page": round(calls / 56, 2) if calls else None,
            "document_wall_ms_p50": _percentile(wall, 0.5),
            "document_wall_ms_p95": _percentile(wall, 0.95),
            "call_ms_p50": _percentile(call_ms, 0.5),
            "call_ms_p95": _percentile(call_ms, 0.95),
            "input_tokens": input_tokens or None,
            "output_tokens": output_tokens or None,
            "mistral_pages_processed": pages_processed or None,
            "measured_usd": round(pages_processed * MISTRAL_USD_PER_1000_PAGES / 1000, 4)
            if pages_processed
            else None,
            "hebrew_reversed_documents": sum(1 for item in documents if item["hebrew_reversed"]),
            "arithmetic_candidate_rows": candidates,
            "arithmetic_consistent_rate": round(consistent / candidates, 4) if candidates else None,
            "total_blocks": total_blocks,
            "total_chars": sum(item["chars"] for item in documents),
            "tables_emitted": sum(item["tables"] for item in documents),
            "measured_geometry_rate": round(
                sum(item["measured_geometry_blocks"] for item in documents) / total_blocks, 4
            )
            if total_blocks
            else None,
            "graded_confidence_rate": round(
                sum(item["graded_confidence_blocks"] for item in documents) / total_blocks, 4
            )
            if total_blocks
            else None,
            "markdown_residue_rate": round(
                sum(item["markdown_residue_blocks"] for item in documents) / total_blocks, 4
            )
            if total_blocks
            else None,
            "per_document": documents,
        }

    agreement: list[dict[str, Any]] = []
    if len(arms) == 2:
        left, right = arms
        for slug in sorted(set(texts[left]) & set(texts[right])):
            a = _normalize_text(texts[left][slug])
            b = _normalize_text(texts[right][slug])
            distance = _edit_distance(a, b)
            numbers_a, numbers_b = _numbers(a), _numbers(b)
            shared = len(set(numbers_a) & set(numbers_b))
            agreement.append(
                {
                    "slug": slug,
                    # Disagreement magnitude. NOT accuracy: it says how far apart the arms are,
                    # never which one is right. It exists to size the human triage queue.
                    "cross_engine_cer": round(distance / max(len(a), len(b), 1), 4),
                    "chars": {left: len(a), right: len(b)},
                    "numbers": {left: len(numbers_a), right: len(numbers_b)},
                    "shared_numbers": shared,
                    "number_agreement": round(shared / max(len(set(numbers_a) | set(numbers_b)), 1), 4),
                }
            )

    report = {
        "schema_version": "1",
        "harness_version": HARNESS_VERSION,
        "tier": 0,
        "note": "No ground truth is used here. Nothing below is an accuracy claim.",
        "arms": per_arm,
        "cross_engine": {
            "documents": len(agreement),
            "cer_p50": _percentile([item["cross_engine_cer"] for item in agreement], 0.5),
            "cer_p95": _percentile([item["cross_engine_cer"] for item in agreement], 0.95),
            "number_agreement_p50": _percentile(
                [item["number_agreement"] for item in agreement], 0.5
            ),
            "per_document": agreement,
        },
    }
    (run / "metrics-tier0.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    headline = {
        arm: {
            key: value
            for key, value in values.items()
            if key not in ("per_document",)
        }
        for arm, values in per_arm.items()
    }
    print(
        json.dumps(
            {
                "written": str(run / "metrics-tier0.json"),
                "arms": headline,
                "cross_engine": {
                    key: value for key, value in report["cross_engine"].items() if key != "per_document"
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


# ---------------------------------------------------------------------------------------------
# self-test: offline, no key, no network. Imports `src`, so it runs inside the worker image.
# ---------------------------------------------------------------------------------------------


class _FakeResponse:
    def __init__(self, payload: bytes, status: int = 200) -> None:
        self._payload = payload
        self.status = status

    def read(self, _limit: int | None = None) -> bytes:
        return self._payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *_args: Any) -> bool:
        return False


class _FakeOpener:
    """Records the request and replays a scripted envelope. Never touches a socket."""

    def __init__(self, envelopes: list[dict[str, Any]]) -> None:
        self.envelopes = list(envelopes)
        self.requests: list[Any] = []

    def open(self, request: Any, timeout: float | None = None) -> _FakeResponse:  # noqa: ARG002
        self.requests.append(request)
        envelope = self.envelopes.pop(0) if self.envelopes else {}
        if isinstance(envelope, int):
            raise AssertionError("unreachable")
        return _FakeResponse(json.dumps(envelope).encode("utf-8"))


def _blocks_envelope() -> dict[str, Any]:
    """Shape recorded from the documented OCR 4.1 response. Values are synthetic."""
    return {
        "model": "mistral-ocr-4.1-2026-07-16",
        "usage_info": {"pages_processed": 1, "doc_size_bytes": 1234},
        "pages": [
            {
                "index": 0,
                "dimensions": {"dpi": 200, "width": 1000, "height": 2000},
                "markdown": "unused when blocks are present",
                "blocks": [
                    {
                        "type": "title",
                        "top_left_x": 100,
                        "top_left_y": 40,
                        "bottom_right_x": 900,
                        "bottom_right_y": 140,
                        "content": "חשבונית מס 12345",
                        "confidence_scores": {
                            "average_content_confidence_score": 0.97,
                            "minimum_content_confidence_score": 0.91,
                            "block_type_confidence_score": 0.99,
                        },
                    },
                    {
                        "type": "text",
                        "top_left_x": 100,
                        "top_left_y": 160,
                        "bottom_right_x": 900,
                        "bottom_right_y": 220,
                        "content": "מק\"ט A*B_1 בכמות 2.5",
                        "confidence_scores": {"average_content_confidence_score": 0.62},
                    },
                    {
                        "type": "table",
                        "top_left_x": 50,
                        "top_left_y": 240,
                        "bottom_right_x": 950,
                        "bottom_right_y": 600,
                        "content": "| פריט | כמות | מחיר |\n|---|---:|---:|\n| עגבניות | 2.5 | 3.50 |\n| מלפפון | 1 | 1,392.00 |",
                        "confidence_scores": {"average_content_confidence_score": 0.88},
                    },
                    {
                        "type": "signature",
                        "top_left_x": 600,
                        "top_left_y": 1800,
                        "bottom_right_x": 950,
                        "bottom_right_y": 1950,
                        "content": "",
                        "confidence_scores": {"average_content_confidence_score": None},
                    },
                ],
            }
        ],
    }


def _markdown_envelope() -> dict[str, Any]:
    return {
        "model": "mistral-ocr-4.1-2026-07-16",
        "usage_info": {"pages_processed": 1},
        "pages": [
            {
                "index": 0,
                "dimensions": {"dpi": 200, "width": 1000, "height": 2000},
                "markdown": "# כותרת\n\n- שורה ראשונה\n\n| א | ב |\n|---|---|\n| 1 | 2 |\n",
            }
        ],
    }


def _write_png(path: Path) -> None:
    from PIL import Image

    Image.new("RGB", (8, 8), (255, 255, 255)).save(path, format="PNG")


def command_self_test(_args: argparse.Namespace) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import tempfile

    from src.contract import validate_extraction
    from src.errors import ProcessingError
    from src.limits import DEFAULT_LIMITS
    from src.ocr import PageImage

    from ab_mistral_adapter import MistralOcrAdapter

    checks: list[str] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        if not condition:
            raise AssertionError(f"{name} failed. {detail}".strip())
        checks.append(name)

    # The one number `plan` duplicates. If the worker ever changes it, the corpus budget silently
    # stops matching production, so fail loudly here rather than quietly there.
    check(
        "limits_match_production",
        DEFAULT_LIMITS.max_ai_pages == MAX_AI_PAGES and DEFAULT_LIMITS.max_pdf_pages == MAX_PDF_PAGES,
        f"src limits are {DEFAULT_LIMITS.max_ai_pages}/{DEFAULT_LIMITS.max_pdf_pages}",
    )

    with tempfile.TemporaryDirectory() as scratch:
        page_path = Path(scratch) / "p1.png"
        _write_png(page_path)
        page = PageImage(1, page_path, 8, 8)

        # --- blocks path -------------------------------------------------------------------
        opener = _FakeOpener([_blocks_envelope()])
        adapter = MistralOcrAdapter("k" * 32, opener=opener, sleep=lambda _s: None)
        payload = adapter.extract([page], DEFAULT_LIMITS)
        validated = validate_extraction(payload, DEFAULT_LIMITS)

        request = opener.requests[0]
        body = json.loads(request.data.decode("utf-8"))
        check("request_url", request.full_url == "https://api.mistral.ai/v1/ocr", request.full_url)
        check("request_bearer", request.headers.get("Authorization") == "Bearer " + "k" * 32)
        check("request_model", body["model"] == "mistral-ocr-latest")
        check("request_include_blocks", body["include_blocks"] is True)
        check("request_confidence_granularity", body["confidence_scores_granularity"] == "block")
        check(
            "request_no_annotation_pass",
            "bbox_annotation_format" not in body and "document_annotation_format" not in body,
        )
        check(
            "request_data_uri",
            body["document"]["type"] == "image_url"
            and body["document"]["image_url"].startswith("data:image/png;base64,"),
        )

        blocks = validated["blocks"]
        by_type = [block["type"] for block in blocks]
        check("maps_title_to_heading", by_type[0] == "heading", str(by_type))
        check("maps_signature_to_handwriting", "handwriting" in by_type, str(by_type))
        check("table_rows_become_blocks", by_type.count("table") == 3, str(by_type))
        check(
            "separator_row_dropped",
            all("---" not in block["text"] for block in blocks),
            "a GFM separator survived into the contract",
        )
        check(
            "inline_markdown_preserved",
            any("A*B_1" in block["text"] for block in blocks),
            "emphasis characters were stripped from a SKU",
        )
        check(
            "bbox_normalised_from_pixels",
            blocks[0]["bbox"] == [0.1, 0.02, 0.9, 0.07],
            str(blocks[0]["bbox"]),
        )
        check("confidence_graded", blocks[0]["confidence"] == 0.97, str(blocks[0]["confidence"]))
        check(
            "confidence_absent_is_null",
            blocks[by_type.index("handwriting")]["confidence"] is None,
        )
        check("ids_unique_and_prefixed", blocks[0]["id"] == "mistral-p1-b1", blocks[0]["id"])
        check("marks_empty", validated["marks"] == [])
        check("partial_false", validated["document"]["partial"] is False)
        check("languages_not_invented", validated["document"]["detected_languages"] == [])
        check("measured_geometry_counted", adapter.measured_geometry_blocks == len(blocks))
        check("model_echo_recorded", adapter.observed_models == ["mistral-ocr-4.1-2026-07-16"])
        check("usage_recorded", adapter.observed_pages_processed == 1)

        tables = validated["tables"]
        check("table_emitted", len(tables) == 1, str(len(tables)))
        check("table_rows", len(tables[0]["rows"]) == 3, str(len(tables[0]["rows"])))
        check(
            "table_cells_split",
            [cell["text"] for cell in tables[0]["rows"][1]] == ["עגבניות", "2.5", "3.50"],
            str([cell["text"] for cell in tables[0]["rows"][1]]),
        )
        check("table_cell_bbox_null", tables[0]["rows"][0][0]["bbox"] is None)
        check(
            "table_text_also_in_plain_text",
            "1,392.00" in validated["document"]["plain_text"],
            "line-item numbers must survive into plain_text",
        )

        # --- tables_off ablation ------------------------------------------------------------
        opener_off = _FakeOpener([_blocks_envelope()])
        adapter_off = MistralOcrAdapter(
            "k" * 32, opener=opener_off, sleep=lambda _s: None, emit_tables=False
        )
        payload_off = validate_extraction(adapter_off.extract([page], DEFAULT_LIMITS), DEFAULT_LIMITS)
        check("tables_off_empties_tables", payload_off["tables"] == [])
        check(
            "tables_off_keeps_text",
            payload_off["document"]["plain_text"] == validated["document"]["plain_text"],
            "the ablation must lose structure only, never text",
        )

        # --- markdown fallback ----------------------------------------------------------------
        opener_md = _FakeOpener([_markdown_envelope()])
        adapter_md = MistralOcrAdapter("k" * 32, opener=opener_md, sleep=lambda _s: None)
        payload_md = validate_extraction(adapter_md.extract([page], DEFAULT_LIMITS), DEFAULT_LIMITS)
        md_types = [block["type"] for block in payload_md["blocks"]]
        check("markdown_heading", md_types[0] == "heading", str(md_types))
        check("markdown_bullet_marker_stripped", payload_md["blocks"][1]["text"] == "שורה ראשונה")
        check("markdown_table_rows", md_types.count("table") == 2, str(md_types))
        check(
            "markdown_fallback_uses_synthetic_band",
            payload_md["blocks"][0]["bbox"][0] == 0.0 and payload_md["blocks"][0]["bbox"][2] == 1.0,
            str(payload_md["blocks"][0]["bbox"]),
        )
        check("markdown_confidence_unknown", payload_md["blocks"][0]["confidence"] is None)

        # --- failure envelopes ------------------------------------------------------------
        for name, envelope, code in (
            ("empty_pages", {"pages": []}, "ocr_invalid_output"),
            ("multi_page_reply", {"pages": [{"markdown": "a"}, {"markdown": "b"}]}, "ocr_invalid_output"),
            ("no_content", {"pages": [{"index": 0}]}, "ocr_invalid_output"),
        ):
            failing = MistralOcrAdapter("k" * 32, opener=_FakeOpener([envelope]), sleep=lambda _s: None)
            try:
                failing.extract([page], DEFAULT_LIMITS)
            except ProcessingError as exc:
                check(f"error_{name}", exc.code == code, exc.code)
            else:
                raise AssertionError(f"error_{name} did not raise")

    print(json.dumps({"self_test": "ok", "checks": len(checks), "names": checks}, ensure_ascii=False, indent=2))
    return 0


def command_triage(args: argparse.Namespace) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import ab_mistral_triage

    run = Path(args.run).resolve()
    arms = list(args.arm) if args.arm else ["openai", "mistral"]
    rows, counts = ab_mistral_triage.build(run, arms)
    target = run / "triage.csv"
    ab_mistral_triage.write_csv(rows, target)
    print(json.dumps({"written": str(target), "rows": len(rows), "by_kind": counts,
                      "by_arm": _counts(r["arm"] for r in rows)},
                     ensure_ascii=False, indent=2))
    return 0


def command_score_truth(args: argparse.Namespace) -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from run import _edit_distance

    import ab_mistral_truth

    run = Path(args.run).resolve()
    arms = list(args.arm) if args.arm else ["openai", "mistral"]
    report = ab_mistral_truth.run(run, arms, _edit_distance)
    (run / "metrics-tier1.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    headline = {
        arm: {k: v for k, v in values.items() if k != "per_document"}
        for arm, values in report["arms"].items()
    }
    print(json.dumps({"written": str(run / "metrics-tier1.json"),
                      "documents": report["documents"], "arms": headline},
                     ensure_ascii=False, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ab_mistral", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    plan = sub.add_parser("plan", help="build the corpus manifest and OCR page budget (offline)")
    plan.add_argument("--corpus", action="append", required=True, help="corpus directory (repeatable)")
    plan.add_argument("--out", required=True, help="run directory; corpus.json is written there")
    plan.set_defaults(func=command_plan)

    render = sub.add_parser("render", help="production-faithful page PNGs (offline; needs cv2 + pdftoppm)")
    render.add_argument("--run", required=True, help="run directory holding corpus.json")
    render.add_argument("--docs-root", help="corpus root inside this filesystem; defaults to the planned one")
    render.set_defaults(func=command_render)

    for name, help_text, func in (
        ("fetch", "the only billed step; records raw provider envelopes", command_fetch),
        ("derive", "replay the cache into ExtractionContract v1; offline and free", command_derive),
    ):
        arm_parser = sub.add_parser(name, help=help_text)
        arm_parser.add_argument("--run", required=True, help="run directory holding pages.json")
        arm_parser.add_argument(
            "--arm", required=True, choices=("openai", "mistral", "mistral-tables-off")
        )
        arm_parser.add_argument("--key-file", help="path to the provider key; read at run time only")
        arm_parser.add_argument("--limit", type=int, help="first N documents only, for a dry run")
        arm_parser.add_argument("--qa-passes", type=int, default=3, help="OpenAI arm only")
        arm_parser.add_argument("--page-concurrency", type=int, default=3, help="OpenAI arm only")
        arm_parser.add_argument(
            "--dry-run", action="store_true", help="print page counts and cost estimate, call nothing"
        )
        arm_parser.set_defaults(func=func)

    triage = sub.add_parser("triage", help="disagreement sheet for human adjudication; offline")
    triage.add_argument("--run", required=True, help="run directory")
    triage.add_argument("--arm", action="append", help="arm (repeatable; default openai+mistral)")
    triage.set_defaults(func=command_triage)

    truth = sub.add_parser("score-truth", help="tier-1 metrics against the approved ground truth")
    truth.add_argument("--run", required=True, help="run directory holding truth/ and derived/")
    truth.add_argument("--arm", action="append", help="arm to score (repeatable; default openai+mistral)")
    truth.set_defaults(func=command_score_truth)

    score = sub.add_parser("score", help="tier-0 metrics; no ground truth, no key, no network")
    score.add_argument("--run", required=True, help="run directory")
    score.add_argument("--arm", action="append", help="arm to score (repeatable; default openai+mistral)")
    score.set_defaults(func=command_score)

    selftest = sub.add_parser("self-test", help="offline adapter checks; no key, no network")
    selftest.set_defaults(func=command_self_test)

    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
