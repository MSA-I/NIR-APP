#!/usr/bin/env python3
"""Small, model-free worker check using generated synthetic documents only."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import urllib.error
import urllib.request
import zipfile
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pillow_heif
from PIL import Image

from src import (
    DEFAULT_LIMITS,
    ExtractionLimits,
    GatewayClient,
    GatewayError,
    OpenAiOcrAdapter,
    PageImage,
    ProcessingError,
    WorkerConfig,
    bounded_backoff,
    create_ocr_adapter,
    extract_file,
    job_temp_dir,
    process_one,
    retry_call,
    sniff_mime,
    validate_extraction,
)
from src.gateway import GATEWAY_CONTRACT_HEADER, GATEWAY_CONTRACT_VERSION
from src.worker import WORKER_VERSION


def _contract(page_count: int, text: str) -> dict[str, Any]:
    return {
        "schema_version": "1",
        "document": {
            "page_count": page_count,
            "detected_languages": ["he", "en"],
            "plain_text": text,
            "partial": False,
        },
        "blocks": [
            {
                "id": "synthetic-1",
                "page": 1,
                "type": "text",
                "bbox": [0.0, 0.0, 1.0, 1.0],
                "text": text,
                "confidence": None,
            }
        ],
        "tables": [],
        "marks": [],
    }


class SyntheticOcrAdapter:
    def extract(self, pages: Any, limits: Any) -> dict[str, Any]:
        count = max(1, len(pages))
        return _contract(count, "synthetic visual")


def _write_images(directory: Path) -> None:
    pillow_heif.register_heif_opener()
    register_avif = getattr(pillow_heif, "register_avif_opener", None)
    if register_avif:
        register_avif()
    image = Image.new("RGB", (16, 16), "white")
    for extension, image_format in (
        ("png", "PNG"),
        ("jpg", "JPEG"),
        ("gif", "GIF"),
        ("webp", "WEBP"),
        ("avif", "AVIF"),
    ):
        image.save(directory / f"pixel.{extension}", format=image_format)
    pillow_heif.from_pillow(image).save(directory / "pixel.heic", quality=-1)
    heif_bytes = (directory / "pixel.heic").read_bytes()
    if len(heif_bytes) < 12 or heif_bytes[4:8] != b"ftyp":
        raise AssertionError("heic_fixture_invalid")
    (directory / "pixel.heif").write_bytes(heif_bytes[:8] + b"mif1" + heif_bytes[12:])


def _pdf(objects: list[bytes], destination: Path) -> None:
    body = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, value in enumerate(objects, start=1):
        offsets.append(len(body))
        body.extend(f"{number} 0 obj\n".encode())
        body.extend(value)
        body.extend(b"\nendobj\n")
    xref = len(body)
    body.extend(f"xref\n0 {len(offsets)}\n".encode())
    body.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        body.extend(f"{offset:010d} 00000 n \n".encode())
    body.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    destination.write_bytes(body)


def _write_text_pdf(path: Path) -> None:
    stream = b"BT /F1 14 Tf 40 100 Td (Invoice 123) Tj ET"
    _pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        ],
        path,
    )


def _write_scanned_pdf(path: Path, page_count: int = 1) -> None:
    image = zlib.compress(b"\xff\xff\xff")
    drawing = b"q 100 0 0 100 25 25 cm /Im0 Do Q"
    page_objects: list[bytes] = []
    page_refs: list[str] = []
    for page_index in range(page_count):
        page_object = 3 + page_index * 3
        image_object = page_object + 1
        drawing_object = page_object + 2
        page_refs.append(f"{page_object} 0 R")
        page_objects.extend(
            [
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 150 150] /Resources << /XObject << /Im0 {image_object} 0 R >> >> /Contents {drawing_object} 0 R >>".encode(),
                f"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {len(image)} >>\nstream\n".encode()
                + image
                + b"\nendstream",
                f"<< /Length {len(drawing)} >>\nstream\n".encode() + drawing + b"\nendstream",
            ]
        )
    _pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [{' '.join(page_refs)}] /Count {page_count} >>".encode(),
            *page_objects,
        ],
        path,
    )


def _write_docx(path: Path) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        )
        archive.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Supplier document 123</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
        )


def _write_xlsx(path: Path) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        )
        archive.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Prices" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        archive.writestr(
            "xl/worksheets/sheet1.xml",
            '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>price</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>SKU-123</t></is></c><c r="B2"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
        )


def _write_odt(path: Path) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("mimetype", "application/vnd.oasis.opendocument.text", compress_type=zipfile.ZIP_STORED)
        archive.writestr(
            "content.xml",
            '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>ODT supplier 123</text:p></office:text></office:body></office:document-content>',
        )
        archive.writestr(
            "META-INF/manifest.xml",
            '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
        )


def _write_macro_odt(path: Path, sentinel: Path) -> None:
    sentinel_path = str(sentinel.resolve()).replace("\\", "/").replace('"', '""')
    basic = f'''REM ***** BASIC *****
Sub OnLoad
  Dim handle As Integer
  handle = FreeFile
  Open "{sentinel_path}" For Output As #handle
  Print #handle, "macro executed"
  Close #handle
End Sub
'''
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "mimetype",
            "application/vnd.oasis.opendocument.text",
            compress_type=zipfile.ZIP_STORED,
        )
        archive.writestr(
            "content.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<office:document-content office:version="1.2" '
            'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
            'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
            'xmlns:script="urn:oasis:names:tc:opendocument:xmlns:script:1.0" '
            'xmlns:xlink="http://www.w3.org/1999/xlink">'
            '<office:scripts><office:event-listeners>'
            '<script:event-listener script:language="ooo:script" '
            'script:event-name="dom:load" xlink:type="simple" '
            'xlink:href="vnd.sun.star.script:Standard.Module1.OnLoad?language=Basic&amp;location=document"/>'
            '</office:event-listeners></office:scripts>'
            '<office:body><office:text><text:p>Macro sentinel supplier 123</text:p>'
            '</office:text></office:body></office:document-content>',
        )
        archive.writestr(
            "Basic/script-lc.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<library:libraries xmlns:library="http://openoffice.org/2000/library" '
            'xmlns:xlink="http://www.w3.org/1999/xlink">'
            '<library:library library:name="Standard" library:link="false" '
            'xlink:type="simple" xlink:href="Standard/script-lb.xml"/>'
            '</library:libraries>',
        )
        archive.writestr(
            "Basic/Standard/script-lb.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<library:library xmlns:library="http://openoffice.org/2000/library" '
            'library:name="Standard" library:readonly="false" '
            'library:passwordprotected="false">'
            '<library:element library:name="Module1"/>'
            '</library:library>',
        )
        archive.writestr(
            "Basic/Standard/Module1.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<script:module xmlns:script="http://openoffice.org/2000/script" '
            'script:name="Module1" script:language="StarBasic" script:moduleType="normal"><![CDATA['
            + basic
            + ']]></script:module>',
        )
        archive.writestr(
            "META-INF/manifest.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<manifest:manifest manifest:version="1.2" '
            'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">'
            '<manifest:file-entry manifest:full-path="/" '
            'manifest:media-type="application/vnd.oasis.opendocument.text"/>'
            '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>'
            '<manifest:file-entry manifest:full-path="Basic/" '
            'manifest:media-type="application/vnd.sun.star.basic-library"/>'
            '<manifest:file-entry manifest:full-path="Basic/script-lc.xml" manifest:media-type="text/xml"/>'
            '<manifest:file-entry manifest:full-path="Basic/Standard/" '
            'manifest:media-type="application/vnd.sun.star.basic-library"/>'
            '<manifest:file-entry manifest:full-path="Basic/Standard/script-lb.xml" '
            'manifest:media-type="text/xml"/>'
            '<manifest:file-entry manifest:full-path="Basic/Standard/Module1.xml" '
            'manifest:media-type="text/xml"/>'
            '</manifest:manifest>',
        )
def _convert_office(source: Path, extension: str, scratch: Path) -> Path:
    profile = scratch / f"lo-profile-{extension}"
    output = scratch / f"converted-{extension}"
    output.mkdir()
    env = os.environ.copy()
    env.update(
        {
            "HOME": str(scratch),
            "TMPDIR": str(scratch),
            "XDG_CACHE_HOME": str(scratch / "lo-cache"),
            "XDG_CONFIG_HOME": str(scratch / "lo-config"),
            "SAL_USE_VCLPLUGIN": "svp",
        }
    )
    command = [
        "soffice",
        "--headless",
        "--nologo",
        "--nodefault",
        "--nolockcheck",
        "--norestore",
        "--nofirststartwizard",
        f"-env:UserInstallation={profile.resolve().as_uri()}",
        "--convert-to",
        extension,
        "--outdir",
        str(output),
        str(source),
    ]
    completed = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
    target = output / f"{source.stem}.{extension}"
    if completed.returncode != 0 or not target.is_file():
        raise AssertionError(f"office_fixture_conversion_failed:{extension}")
    return target


def _assert_contains(payload: dict[str, Any], expected: str) -> None:
    checked = validate_extraction(payload, DEFAULT_LIMITS)
    if expected not in checked["document"]["plain_text"]:
        raise AssertionError("parser_expected_text_missing")


def _assert_rejected(path: Path, claimed_mime: str) -> None:
    try:
        extract_file(path, claimed_mime, adapter=SyntheticOcrAdapter(), limits=DEFAULT_LIMITS)
    except Exception:
        return
    raise AssertionError("invalid_fixture_was_silently_accepted")


def _expect_processing_error(operation: Any, code: str) -> None:
    try:
        operation()
    except ProcessingError as error:
        if error.code != code:
            raise AssertionError(f"unexpected_processing_error:{error.code}") from error
        return
    raise AssertionError(f"processing_error_missing:{code}")


def _limit_checks(fixtures: Path, adapter: SyntheticOcrAdapter) -> None:
    wide_html = fixtures / "wide-table.html"
    wide_html.write_text(
        "<table><tr>" + "".join("<td>x</td>" for _ in range(1_001)) + "</tr></table>",
        encoding="utf-8",
    )
    _expect_processing_error(
        lambda: extract_file(wide_html, "text/html", limits=DEFAULT_LIMITS),
        "spreadsheet_column_limit",
    )
    wide_payload = _contract(1, "wide")
    wide_payload["tables"] = [
        {
            "id": "wide-table",
            "page": 1,
            "bbox": [0.0, 0.0, 1.0, 1.0],
            "rows": [
                [{"text": "x", "bbox": None} for _ in range(1_001)]
            ],
        }
    ]
    _expect_processing_error(
        lambda: validate_extraction(wide_payload, DEFAULT_LIMITS),
        "spreadsheet_column_limit",
    )
    _expect_processing_error(
        lambda: extract_file(
            fixtures / "scan.pdf",
            "application/pdf",
            adapter=adapter,
            limits=ExtractionLimits(max_decompressed_bytes=1),
        ),
        "decompressed_size_limit",
    )


def _pdf_batching_check(fixtures: Path) -> dict[str, Any]:
    from src import parsers

    source = fixtures / "scan-batched.pdf"
    _write_scanned_pdf(source, page_count=3)
    original_render = parsers._render_pdf_page
    batches: list[list[int]] = []
    previous_paths: list[Path] = []

    class BatchAdapter:
        def extract(self, pages: list[PageImage], limits: ExtractionLimits) -> dict[str, Any]:
            del limits
            if any(path.exists() for path in previous_paths):
                raise AssertionError("pdf_batch_temp_files_not_removed")
            batches.append([page.page for page in pages])
            previous_paths[:] = [page.path for page in pages]
            text = "\n".join(f"page {page.page}" for page in pages)
            return {
                "schema_version": "1",
                "document": {
                    "page_count": max(page.page for page in pages),
                    "detected_languages": ["en"],
                    "plain_text": text,
                    "partial": True,
                },
                "blocks": [
                    {
                        "id": f"batch-p{page.page}",
                        "page": page.page,
                        "type": "text",
                        "bbox": [0.0, 0.0, 1.0, 1.0],
                        "text": f"page {page.page}",
                        "confidence": None,
                    }
                    for page in pages
                ],
                "tables": [],
                "marks": [],
            }

    def fake_render(path: Path, page: int, limits: ExtractionLimits) -> PageImage:
        del limits
        output = path.parent / f"fake-render-{page}.png"
        output.write_bytes(b"rendered")
        return PageImage(page, output, 10, 10)

    parsers._render_pdf_page = fake_render
    try:
        limits = ExtractionLimits(max_decompressed_bytes=600)
        payload = extract_file(source, "application/pdf", adapter=BatchAdapter(), limits=limits)
        assert batches == [[1, 2], [3]], f"unexpected_pdf_batches:{batches}"
        assert [block["page"] for block in payload["blocks"]] == [1, 2, 3]
        assert not any(path.exists() for path in previous_paths)
        _expect_processing_error(
            lambda: extract_file(
                source,
                "application/pdf",
                adapter=BatchAdapter(),
                limits=ExtractionLimits(max_decompressed_bytes=299),
            ),
            "decompressed_size_limit",
        )
        assert not list(fixtures.glob("fake-render-*.png"))
    finally:
        parsers._render_pdf_page = original_render
    return {"batches": batches, "single_page_limit": "passed", "cleanup": "passed"}


def _macro_security_check(fixtures: Path, scratch: Path) -> None:
    sentinel = scratch / "macro-executed.txt"
    document = fixtures / "macro-sentinel.odt"
    _write_macro_odt(document, sentinel)
    with zipfile.ZipFile(document) as archive:
        names = set(archive.namelist())
        if not {
            "Basic/script-lc.xml",
            "Basic/Standard/script-lb.xml",
            "Basic/Standard/Module1.xml",
        }.issubset(names):
            raise AssertionError("macro_fixture_library_missing")
        content = archive.read("content.xml")
        module = archive.read("Basic/Standard/Module1.xml")
        sentinel_bytes = str(sentinel.resolve()).replace("\\", "/").encode()
        if b"dom:load" not in content or sentinel_bytes not in module:
            raise AssertionError("macro_fixture_sentinel_missing")
    payload = extract_file(
        document,
        "application/vnd.oasis.opendocument.text",
        limits=DEFAULT_LIMITS,
    )
    _assert_contains(payload, "Macro sentinel supplier 123")
    if sentinel.exists():
        raise AssertionError("office_macro_executed")


def _tesseract_evidence() -> dict[str, Any]:
    version = subprocess.run(["tesseract", "--version"], check=True, capture_output=True, text=True, timeout=10).stdout.splitlines()[0]
    listed = subprocess.run(["tesseract", "--list-langs"], check=True, capture_output=True, text=True, timeout=10)
    languages = {line.strip() for line in listed.stdout.splitlines()[1:] if line.strip()}
    if not {"heb", "eng"}.issubset(languages):
        raise AssertionError("tesseract_heb_eng_missing")
    candidates = [
        Path(os.environ["TESSDATA_PREFIX"]) if os.environ.get("TESSDATA_PREFIX") else None,
        Path("/usr/share/tesseract-ocr/5/tessdata"),
        Path("/usr/share/tesseract-ocr/4.00/tessdata"),
        Path("/usr/share/tessdata"),
    ]
    tessdata = next((path for path in candidates if path and (path / "heb.traineddata").is_file()), None)
    if tessdata is None:
        raise AssertionError("tessdata_path_missing")
    hashes = {
        language: hashlib.sha256((tessdata / f"{language}.traineddata").read_bytes()).hexdigest()
        for language in ("heb", "eng")
    }
    return {"version": version, "languages": ["eng", "heb"], "artifact_sha256": hashes}


class _FakeResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self._body = body
        self.status = status

    def read(self, size: int = -1) -> bytes:
        del size
        return self._body

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *args: Any) -> bool:
        del args
        return False


class _FakeOpener:
    """Stands in for urllib's opener so the provider adapter runs with no network at all.

    Accepts either one envelope, replayed for every call, or a list consumed in order so a
    resampling QA pass can be given deliberately disagreeing answers.
    """

    def __init__(self, envelope: dict[str, Any] | list[dict[str, Any]]) -> None:
        self.envelopes = envelope if isinstance(envelope, list) else [envelope]
        self.requests: list[Any] = []

    def open(self, request: Any, timeout: float | None = None) -> _FakeResponse:
        del timeout
        index = min(len(self.requests), len(self.envelopes) - 1)
        self.requests.append(request)
        return _FakeResponse(json.dumps(self.envelopes[index], ensure_ascii=False).encode())


def _openai_envelope(lines: list[str], **overrides: Any) -> dict[str, Any]:
    envelope: dict[str, Any] = {
        "id": "resp_self_check",
        # Dated snapshot on purpose: the adapter must match the alias by prefix, not by equality.
        "model": "gpt-5.6-terra-2026-06-01",
        "status": "completed",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": json.dumps(
                            {"lines": [{"text": line} for line in lines]}, ensure_ascii=False
                        ),
                    }
                ],
            }
        ],
    }
    envelope.update(overrides)
    return envelope


def _openai_qa_check(fixtures: Path) -> dict[str, Any]:
    """The resampling QA layer: transcribe until two independent passes agree on the numbers."""
    page = PageImage(1, fixtures / "pixel.png", 16, 16)
    good = ['מוצר א 4.00 יח\' 19.50 ₪ 78.00']
    # Same numbers, different wording: cosmetic, must count as agreement.
    reworded = ['פריט א 4.00 יח\' 19.50 ₪ 78.00']
    # A decimal shift of exactly the kind measured on the real benchmark.
    shifted = ['מוצר א 4.00 יח\' 195.00 ₪ 78.00']
    dropped = ['מוצר א']

    def run(envelopes: list[list[str]], passes: int | None = None):
        opener = _FakeOpener([_openai_envelope(e) for e in envelopes])
        adapter = OpenAiOcrAdapter(
            "sk-self-check-000000000000", qa_passes=passes, opener=opener, sleep=lambda _s: None
        )
        payload = validate_extraction(adapter.extract([page], DEFAULT_LIMITS), DEFAULT_LIMITS)
        return payload, len(opener.requests)

    payload, calls = run([good, good])
    assert calls == 2, f"a reproduced page should cost exactly two passes, made {calls}"
    assert all(b["confidence"] is None for b in payload["blocks"]), "agreement must not invent a score"

    payload, calls = run([good, reworded])
    assert calls == 2, "different wording with identical numbers must count as reproduction"

    payload, calls = run([good, shifted, good])
    assert calls == 3, f"an unreproduced line should escalate to a third pass, made {calls}"
    assert all(b["confidence"] is None for b in payload["blocks"]), "the third pass reproduced it"

    payload, calls = run([good, shifted, dropped])
    assert calls == 3, f"escalation must stop at three passes, made {calls}"
    assert payload["blocks"], "an unreproducible page must still be returned"
    assert all(b["confidence"] == 0.0 for b in payload["blocks"]), "unstable line was not marked"

    payload, calls = run([good, shifted], passes=1)
    assert calls == 1, "OCR_QA_PASSES=1 must disable the second opinion"
    assert all(b["confidence"] is None for b in payload["blocks"]), \
        "an unchecked page must not be reported as checked-and-failed"

    # The property that page-level comparison could not deliver: one unstable row must not
    # condemn the stable ones beside it.
    stable = 'מוצר א 4.00 יח\' 19.50 ₪ 78.00'
    other = 'מוצר ב 6.00 יח\' 58.00 ₪ 348.00'
    drifted = 'מוצר ב 6.00 יח\' 5.80 ₪ 34.80'
    payload, calls = run([[stable, other], [stable, drifted], [stable, drifted]])
    marked = {b["text"]: b["confidence"] for b in payload["blocks"]}
    assert marked[stable] is None, "a reproduced line was flagged because a neighbour drifted"
    assert marked[other] == 0.0, f"the drifting line was not flagged: {marked}"

    # A line carrying no numbers has nothing for this check to compare and must not be flagged.
    payload, _ = run([['כותרת ללא מספרים', other], ['כותרת ללא מספרים', drifted]])
    marked = {b["text"]: b["confidence"] for b in payload["blocks"]}
    assert marked['כותרת ללא מספרים'] is None, "a text-only line must not be reported as unstable"

    return {
        "agreement": "passed",
        "escalation": "passed",
        "per_line_marking": "passed",
        "text_only_lines": "passed",
        "opt_out": "passed",
    }


def _openai_page_concurrency_check(fixtures: Path) -> dict[str, Any]:
    """Multiple scanned pages run concurrently, but never beyond the configured ceiling."""
    pages = [PageImage(page, fixtures / "pixel.png", 16, 16) for page in range(1, 6)]
    adapter = OpenAiOcrAdapter(
        "sk-self-check-000000000000",
        qa_passes=1,
        page_concurrency=2,
        opener=_FakeOpener(_openai_envelope(["unused"])),
        sleep=lambda _s: None,
    )
    lock = threading.Lock()
    release = threading.Event()
    active = 0
    peak = 0

    def transcribe(page: PageImage, limits: ExtractionLimits) -> tuple[list[str], list[bool]]:
        del limits
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            if peak == 2:
                release.set()
        if not release.wait(2):
            raise AssertionError("openai_pages_were_processed_serially")
        with lock:
            active -= 1
        return [f"page {page.page}"], [True]

    adapter._transcribe_with_consensus = transcribe  # type: ignore[method-assign]
    payload = validate_extraction(adapter.extract(pages, DEFAULT_LIMITS), DEFAULT_LIMITS)
    assert peak == 2, f"unexpected_openai_page_concurrency:{peak}"
    assert [block["page"] for block in payload["blocks"]] == [1, 2, 3, 4, 5]
    assert payload["document"]["plain_text"].split("\n\n") == [
        "page 1", "page 2", "page 3", "page 4", "page 5"
    ]

    _expect_processing_error(
        lambda: OpenAiOcrAdapter("sk-self-check-000000000000", page_concurrency=5),
        "worker_config_invalid",
    )
    return {"configured": 2, "peak": peak, "source_order": "passed", "ceiling": "passed"}


def _openai_adapter_check(fixtures: Path) -> dict[str, Any]:
    page = PageImage(1, fixtures / "pixel.png", 16, 16)
    lines = ['ספק בדיקה בע"מ', "מוצר 1   ₪31.90", 'סה"כ לתשלום 31.90']
    opener = _FakeOpener(_openai_envelope(lines))
    adapter = OpenAiOcrAdapter("sk-self-check-000000000000", opener=opener, sleep=lambda _s: None)
    payload = validate_extraction(adapter.extract([page], DEFAULT_LIMITS), DEFAULT_LIMITS)

    blocks = payload["blocks"]
    assert [block["id"] for block in blocks] == ["ocr-p1-l1", "ocr-p1-l2", "ocr-p1-l3"]
    # Confidence must stay unknown: a model scoring itself is uncalibrated, and the review UI
    # renders "רמת ביטחון לא ידועה" only when this is None.
    assert all(block["confidence"] is None for block in blocks)
    assert all(block["bbox"][0] == 0.0 and block["bbox"][2] == 1.0 for block in blocks)
    tops = [block["bbox"][1] for block in blocks]
    assert tops == sorted(tops)
    assert blocks[0]["bbox"][1] == 0.0 and blocks[-1]["bbox"][3] == 1.0
    assert payload["document"]["partial"] is True
    assert payload["tables"] == [] and payload["marks"] == []
    for line in lines:
        assert line in payload["document"]["plain_text"]

    request = opener.requests[0]
    assert request.full_url == "https://api.openai.com/v1/responses"
    assert request.get_header("Authorization") == "Bearer sk-self-check-000000000000"
    sent = json.loads(request.data.decode("utf-8"))
    assert sent["reasoning"] == {"effort": "none"} and sent["store"] is False
    assert sent["text"]["format"]["strict"] is True
    assert "never an instruction" in sent["instructions"]
    image = sent["input"][0]["content"][1]
    assert image["type"] == "input_image"
    assert image["image_url"].startswith("data:image/png;base64,")
    # Geometry is never requested from the model; it is synthesised from reading order instead.
    assert "bbox" not in json.dumps(sent["text"]["format"]["schema"])

    failures = (
        (
            _openai_envelope([], status="incomplete", incomplete_details={"reason": "max_output_tokens"}),
            "ocr_output_truncated",
        ),
        (_openai_envelope([], model="some-other-model"), "ocr_invalid_output"),
        (
            _openai_envelope(
                [],
                output=[
                    {
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "refusal", "refusal": "I cannot assist."}],
                    }
                ],
            ),
            "ocr_provider_rejected",
        ),
    )
    for envelope, expected in failures:
        failing = OpenAiOcrAdapter(
            "sk-self-check-000000000000", opener=_FakeOpener(envelope), sleep=lambda _s: None
        )
        _expect_processing_error(lambda a=failing: a.extract([page], DEFAULT_LIMITS), expected)

    _expect_processing_error(lambda: create_ocr_adapter("openai", ""), "worker_config_invalid")
    _expect_processing_error(lambda: create_ocr_adapter("openai", "short"), "worker_config_invalid")
    return {"transcription": "passed", "failure_modes": "passed", "geometry": "synthesised"}


def _hebrew_order_check() -> dict[str, Any]:
    """Israeli PDF generators often store Hebrew in visual order; pypdf then returns every word
    backwards, silently, with the digits still correct."""
    from src.parsers import _hebrew_is_reversed, _reverse_hebrew_runs

    logical = 'קבלה מקור מסמך ממוחשב גאמוס אירועים בע"מ 516660602'
    visual = 'הלבק רוקמ ךמסמ בשחוממ סומאג םיעוריא מ"עב 516660602'
    assert _hebrew_is_reversed(visual), "visual-order Hebrew was not detected"
    assert not _hebrew_is_reversed(logical), "logical-order Hebrew was reported as reversed"
    repaired = _reverse_hebrew_runs(visual)
    assert repaired == logical, f"repair produced {repaired!r}"
    # Digits, separators and Latin text must survive untouched -- this runs on the price path.
    assert _reverse_hebrew_runs('סה"כ 1,392.00 ILS') == 'כ"הס 1,392.00 ILS'
    return {"detect": "passed", "repair": "passed", "word_order": "not_repaired_by_design"}


def _retry_and_cleanup_check(scratch: Path) -> None:
    delays: list[float] = []
    attempts = 0

    def flaky() -> str:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise TimeoutError("synthetic")
        return "ok"

    result = retry_call(
        flaky,
        attempts=3,
        retryable=lambda error: isinstance(error, TimeoutError),
        sleep=delays.append,
        base_seconds=0.01,
        max_seconds=0.02,
        jitter_ratio=0,
    )
    assert result == "ok" and attempts == 3 and len(delays) == 2
    assert 0 <= bounded_backoff(100, base_seconds=1, max_seconds=2, jitter_ratio=0) <= 2
    attempts = 0
    try:
        retry_call(flaky, attempts=3, retryable=lambda error: False, sleep=delays.append)
    except TimeoutError:
        pass
    else:
        raise AssertionError("non_retryable_error_was_retried")
    assert attempts == 1

    with job_temp_dir(scratch) as directory:
        success_dir = Path(directory)
        (success_dir / "fixture.bin").write_bytes(b"ok")
    assert not success_dir.exists()
    try:
        with job_temp_dir(scratch) as directory:
            failure_dir = Path(directory)
            (failure_dir / "fixture.bin").write_bytes(b"fail")
            raise RuntimeError("synthetic")
    except RuntimeError:
        pass
    assert not failure_dir.exists()


def _gateway_e2e_check(scratch: Path) -> dict[str, Any]:
    token = "synthetic-worker-token-000000000000"
    org_id = "99999999-9999-4999-8999-999999999999"
    success_job = "11111111-1111-4111-8111-111111111111"
    failure_job = "22222222-2222-4222-8222-222222222222"
    retry_job = "33333333-3333-4333-8333-333333333333"
    attempt_by_job = {
        success_job: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        failure_job: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        retry_job: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }
    state: dict[str, Any] = {
        "claims": [
            {
                "job_id": success_job,
                "processing_attempt_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "processing_attempt_started_at": "2099-01-01T00:00:00Z",
                "document_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "mime_type": "text/plain",
                "file_name": "synthetic.txt",
                "input_checksum": "etag:11111111111111111111111111111111",
                "contract_version": "1",
                "lease_until": "2099-01-01T00:00:00Z",
                "attempt_count": 1,
                "download_path": "/storage/success",
            },
            {
                "job_id": failure_job,
                "processing_attempt_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "processing_attempt_started_at": "2099-01-01T00:00:00Z",
                "document_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                "mime_type": "text/plain",
                "file_name": "invalid.txt",
                "input_checksum": "etag:22222222222222222222222222222222",
                "contract_version": "1",
                "lease_until": "2099-01-01T00:00:00Z",
                "attempt_count": 3,
                "download_path": "/storage/failure",
            },
            {
                "job_id": retry_job,
                "processing_attempt_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "processing_attempt_started_at": "2099-01-01T00:00:00Z",
                "document_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "mime_type": "text/plain",
                "file_name": "unavailable.txt",
                "input_checksum": "etag:33333333333333333333333333333333",
                "contract_version": "1",
                "lease_until": "2099-01-01T00:00:00Z",
                "attempt_count": 1,
                "download_path": "/storage/retry-failure",
            },
        ],
        "download_attempts": 0,
        "download_acknowledged": [],
        "complete": [],
        "complete_attempts": 0,
        "fail": [],
        "failure_reporting": False,
        "heartbeat_during_fail": False,
        "errors": [],
        "contract_rejections": 0,
        "advertise_wrong_contract_once": True,
    }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            del format, args

        def send_json(
            self,
            status: int,
            payload: dict[str, Any],
            *,
            contract_version: str = GATEWAY_CONTRACT_VERSION,
        ) -> None:
            body = json.dumps(payload, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header(GATEWAY_CONTRACT_HEADER, contract_version)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/storage/success":
                state["download_attempts"] += 1
                body = b"Gateway supplier 123"
                if state["download_attempts"] == 1:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body[:7])
                    self.wfile.flush()
                    self.close_connection = True
                    return
            elif self.path == "/storage/failure":
                body = b"\xff\xfe\xfa"
            elif self.path == "/storage/retry-failure":
                self.send_json(503, {"ok": False})
                return
            else:
                self.send_json(404, {"ok": False})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if self.path != "/functions/v1/document-processing":
                self.send_json(404, {"ok": False, "error": {"code": "not_found", "message": "Not found"}})
                return
            if self.headers.get("x-ocr-worker-token") != token:
                self.send_json(401, {"ok": False, "error": {"code": "invalid_worker_token", "message": "Invalid token"}})
                return
            if self.headers.get(GATEWAY_CONTRACT_HEADER) != GATEWAY_CONTRACT_VERSION:
                state["contract_rejections"] += 1
                self.send_json(409, {
                    "ok": False,
                    "error": {
                        "code": "gateway_contract_mismatch",
                        "message": "Worker and document gateway contracts do not match",
                    },
                })
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                request = json.loads(self.rfile.read(length).decode("utf-8", "strict"))
            except (ValueError, UnicodeError, json.JSONDecodeError):
                self.send_json(400, {"ok": False, "error": {"code": "invalid_json", "message": "Invalid JSON"}})
                return
            action = request.get("action")
            if action == "claim":
                if state["advertise_wrong_contract_once"]:
                    state["advertise_wrong_contract_once"] = False
                    self.send_json(
                        200,
                        {"ok": True, "data": None},
                        contract_version="stale",
                    )
                    return
                job = state["claims"].pop(0) if state["claims"] else None
                if job is not None:
                    job = dict(job)
                    job["download_url"] = f"http://127.0.0.1:{self.server.server_port}{job.pop('download_path')}"
                    job["download_expires_in"] = 120
                    job["download_lease_id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, job["job_id"] + ":lease"))
                    job["download_lease_token"] = str(uuid.uuid5(uuid.NAMESPACE_URL, job["job_id"] + ":token"))
                self.send_json(200, {"ok": True, "data": job})
                return
            if action == "ack_download":
                if (
                    request.get("job_id") not in {success_job, failure_job}
                    or request.get("lease_owner") != "self-check-worker"
                    or request.get("lease_seconds") != 120
                ):
                    state["errors"].append("invalid_download_ack")
                state["download_acknowledged"].append(request.get("job_id"))
                self.send_json(200, {"ok": True, "data": {
                    "job_id": request.get("job_id"),
                    "org_id": org_id,
                    "processing_attempt_id": attempt_by_job[request["job_id"]],
                    "egress_lease_id": request.get("download_lease_id"),
                    "acknowledged_at": "2099-01-01T00:00:00Z",
                    "job_lease_until": "2099-01-01T00:02:00Z",
                    "egress_expires_at": "2099-01-01T00:02:00Z",
                    "idempotent": False,
                }})
                return
            if action == "complete":
                try:
                    validate_extraction(request["payload"])
                    if (
                        request.get("job_id") != success_job
                        or request.get("processing_attempt_id") != attempt_by_job[success_job]
                    ):
                        raise AssertionError
                except Exception:
                    state["errors"].append("invalid_complete")
                    self.send_json(400, {"ok": False, "error": {"code": "invalid_request", "message": "Invalid request"}})
                    return
                state["complete_attempts"] += 1
                if state["complete_attempts"] == 1:
                    self.send_json(503, {
                        "ok": False,
                        "error": {
                            "code": "service_unavailable",
                            "message": "Evidence recorded; apply response was lost",
                        },
                    })
                    return
                state["complete"].append(request["job_id"])
                self.send_json(200, {"ok": True, "data": {
                    "job_id": success_job,
                    "processing_attempt_id": attempt_by_job[success_job],
                    "egress_lease_id": request.get("download_lease_id"),
                    "extraction_id": str(uuid.UUID(int=3)),
                    "evidence_sha256": "a" * 64,
                    "payload_sha256": "c" * 64,
                    "business_applied": True,
                    "access_mode": "active",
                    "idempotent": False,
                }})
                return
            if action == "fail":
                expected = {
                    failure_job: ("invalid_utf8", False, "failed"),
                    retry_job: ("download_failed", True, "queued"),
                }.get(request.get("job_id"))
                if expected is None or (request.get("error_code"), request.get("retryable")) != expected[:2]:
                    state["errors"].append("invalid_fail")
                state["fail"].append(request.get("job_id"))
                if expected is None:
                    self.send_json(400, {"ok": False})
                    return
                if request.get("job_id") == failure_job:
                    state["failure_reporting"] = True
                    time.sleep(1.2)
                    state["failure_reporting"] = False
                self.send_json(200, {"ok": True, "data": {
                    "job_id": request.get("job_id"),
                    "processing_attempt_id": attempt_by_job[request["job_id"]],
                    "egress_lease_id": request.get("download_lease_id"),
                    "evidence_sha256": "b" * 64,
                    "job_status": expected[2],
                    "retryable": expected[1],
                    "business_applied": True,
                    "access_mode": "active",
                    "idempotent": False,
                }})
                return
            if action == "heartbeat":
                if state["failure_reporting"] and request.get("job_id") == failure_job:
                    state["heartbeat_during_fail"] = True
                self.send_json(200, {"ok": True, "data": {
                    "job_id": request.get("job_id"),
                    "processing_attempt_id": attempt_by_job[request["job_id"]],
                    "egress_lease_id": request.get("download_lease_id"),
                    "acknowledged_at": "2099-01-01T00:00:00Z",
                    "job_lease_until": "2099-01-01T00:02:00Z",
                    "egress_expires_at": "2099-01-01T00:02:00Z",
                }})
                return
            self.send_json(400, {"ok": False, "error": {"code": "invalid_request", "message": "Invalid request"}})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    temp_root = scratch / "gateway-jobs"
    config = WorkerConfig(
        supabase_url=base_url,
        token=token,
        worker_id="self-check-worker",
        adapter_name="disabled",
        lease_seconds=120,
        heartbeat_seconds=1,
        poll_seconds=1,
        max_backoff_seconds=1,
        request_timeout_seconds=5,
        job_timeout_seconds=30,
        max_memory_mb=2_048,
        max_job_attempts=3,
        temp_root=temp_root,
    )
    try:
        claims_before_contract_probe = len(state["claims"])
        stale_request = urllib.request.Request(
            f"{base_url}/functions/v1/document-processing",
            data=json.dumps({
                "action": "claim",
                "lease_owner": "stale-worker",
                "lease_seconds": 120,
            }).encode(),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "x-ocr-worker-token": token,
                GATEWAY_CONTRACT_HEADER: "1",
            },
        )
        try:
            urllib.request.urlopen(stale_request, timeout=5)
        except urllib.error.HTTPError as error:
            assert error.code == 409
            stale_response = json.loads(error.read().decode("utf-8"))
            assert stale_response["error"]["code"] == "gateway_contract_mismatch"
        else:
            raise AssertionError("stale_gateway_contract_was_accepted")
        assert len(state["claims"]) == claims_before_contract_probe

        try:
            GatewayClient(base_url, "wrong-worker-token-00000000000", timeout_seconds=5).claim("rejected", 120)
        except GatewayError as error:
            assert error.code == "invalid_worker_token"
        else:
            raise AssertionError("gateway_wrong_token_was_accepted")
        client = GatewayClient(base_url, token, timeout_seconds=5)
        try:
            client.claim("self-check-worker", 120)
        except GatewayError as error:
            assert error.code == "gateway_contract_mismatch"
        else:
            raise AssertionError("mismatched_gateway_advertisement_was_accepted")
        assert len(state["claims"]) == claims_before_contract_probe
        assert process_one(client, config) is True
        assert process_one(client, config) is True
        assert process_one(client, config) is True
        assert process_one(client, config) is False
        assert state["download_attempts"] == 2
        assert state["download_acknowledged"] == [success_job, failure_job]
        assert state["complete"] == [success_job]
        assert state["complete_attempts"] == 2
        assert state["fail"] == [failure_job, retry_job]
        assert state["heartbeat_during_fail"] is True
        assert state["contract_rejections"] == 1
        assert state["errors"] == []
        assert not list(temp_root.glob("job-*"))
        return {
            "token_rejection": "passed",
            "contract_version": GATEWAY_CONTRACT_VERSION,
            "stale_contract_rejected_before_claim": "passed",
            "mismatched_gateway_advertisement_rejected": "passed",
            "download_retry": "passed",
            "download_ack_before_ocr": "passed",
            "complete_receipt": "passed",
            "complete_recovery_retry": "passed",
            "failure_receipt": "passed",
            "heartbeat_through_failure_receipt": "passed",
            "retry_requeue": "passed",
        }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def main() -> int:
    scratch_root = Path(os.environ.get("OCR_TEMP_ROOT", Path(__file__).resolve().parent / ".self-check-tmp"))
    remove_scratch_root = not scratch_root.exists()
    scratch_root.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix="self-check-", dir=scratch_root))
    parser_names: list[str] = []
    adapter = SyntheticOcrAdapter()
    try:
        fixtures = scratch / "fixtures"
        fixtures.mkdir()
        (fixtures / "plain.txt").write_text("Supplier plain 123", encoding="utf-8")
        (fixtures / "prices.csv").write_text("sku,price\nSKU-123,2\n", encoding="utf-8")
        (fixtures / "page.html").write_text("<!doctype html><p>HTML supplier 123</p><script>ignore me</script>", encoding="utf-8")
        (fixtures / "note.rtf").write_text(r"{\rtf1\ansi RTF supplier 123}", encoding="ascii")
        (fixtures / "invalid.txt").write_bytes(b"\xff\xfe\xfa")
        (fixtures / "executable.txt").write_bytes(b"MZ\x00\x00synthetic")
        _write_images(fixtures)
        _write_text_pdf(fixtures / "text.pdf")
        _write_scanned_pdf(fixtures / "scan.pdf")
        _write_docx(fixtures / "document.docx")
        _write_xlsx(fixtures / "prices.xlsx")
        _write_odt(fixtures / "document.odt")

        expected_image_mimes = {
            "png": "image/png",
            "jpg": "image/jpeg",
            "gif": "image/gif",
            "webp": "image/webp",
            "avif": "image/avif",
            "heic": "image/heic",
            "heif": "image/heif",
        }
        for extension, expected_mime in expected_image_mimes.items():
            assert sniff_mime(fixtures / f"pixel.{extension}", "application/pdf") == expected_mime
        cases = [
            ("txt", fixtures / "plain.txt", "text/plain", None, "Supplier plain 123"),
            ("csv", fixtures / "prices.csv", "text/csv", None, "SKU-123"),
            ("html", fixtures / "page.html", "text/html", None, "HTML supplier 123"),
            ("rtf", fixtures / "note.rtf", "application/rtf", None, "RTF supplier 123"),
            ("docx", fixtures / "document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", None, "Supplier document 123"),
            ("xlsx", fixtures / "prices.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", None, "SKU-123"),
            ("odt", fixtures / "document.odt", "application/vnd.oasis.opendocument.text", None, "ODT supplier 123"),
            ("pdf-text", fixtures / "text.pdf", "application/pdf", adapter, "Invoice 123"),
            ("pdf-scan", fixtures / "scan.pdf", "application/pdf", adapter, "synthetic visual"),
            ("png", fixtures / "pixel.png", "image/png", adapter, "synthetic visual"),
            ("jpeg", fixtures / "pixel.jpg", "image/jpeg", adapter, "synthetic visual"),
            ("gif", fixtures / "pixel.gif", "image/gif", adapter, "synthetic visual"),
            ("webp", fixtures / "pixel.webp", "image/webp", adapter, "synthetic visual"),
            ("avif", fixtures / "pixel.avif", "image/avif", adapter, "synthetic visual"),
            ("heic", fixtures / "pixel.heic", "image/heic", adapter, "synthetic visual"),
            ("heif", fixtures / "pixel.heif", "image/heif", adapter, "synthetic visual"),
        ]
        legacy_xls = _convert_office(fixtures / "prices.xlsx", "xls", scratch)
        legacy_doc = _convert_office(fixtures / "document.docx", "doc", scratch)
        cases.extend(
            [
                ("xls", legacy_xls, "application/vnd.ms-excel", None, "SKU-123"),
                ("doc", legacy_doc, "application/msword", None, "Supplier document 123"),
            ]
        )
        for name, path, mime, selected_adapter, expected in cases:
            payload = extract_file(path, mime, adapter=selected_adapter, limits=DEFAULT_LIMITS)
            _assert_contains(payload, expected)
            if name == "html" and "ignore me" in payload["document"]["plain_text"]:
                raise AssertionError("html_script_text_must_be_ignored")
            if name == "xlsx" and (
                "2" not in payload["document"]["plain_text"]
                or "=1+1" in payload["document"]["plain_text"]
            ):
                raise AssertionError("spreadsheet_formula_must_use_cached_display_value")
            parser_names.append(name)
        _assert_rejected(fixtures / "invalid.txt", "text/plain")
        _assert_rejected(fixtures / "executable.txt", "text/plain")
        _limit_checks(fixtures, adapter)
        pdf_batching = _pdf_batching_check(fixtures)
        _macro_security_check(fixtures, scratch)
        _retry_and_cleanup_check(scratch)
        hebrew_order = _hebrew_order_check()
        openai_adapter = _openai_adapter_check(fixtures)
        openai_qa = _openai_qa_check(fixtures)
        openai_page_concurrency = _openai_page_concurrency_check(fixtures)
        gateway = _gateway_e2e_check(scratch)
        evidence = _tesseract_evidence()
        print(
            json.dumps(
                {
                    "status": "self_check_passed",
                    "worker_version": WORKER_VERSION,
                    "gateway_contract_version": GATEWAY_CONTRACT_VERSION,
                    "parsers": parser_names,
                    "limits": "passed",
                    "pdf_batching": pdf_batching,
                    "macro_security": "passed",
                    "retry_cleanup": "passed",
                    "hebrew_order": hebrew_order,
                    "openai_adapter": openai_adapter,
                    "openai_qa": openai_qa,
                    "openai_page_concurrency": openai_page_concurrency,
                    "gateway_e2e": gateway,
                    "tesseract": evidence,
                },
                sort_keys=True,
            )
        )
        return 0
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        if remove_scratch_root:
            try:
                scratch_root.rmdir()
            except OSError:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
