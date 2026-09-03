#!/usr/bin/env python3
"""Small, model-free worker check using generated synthetic documents only."""

from __future__ import annotations

import hashlib
import io
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
from PIL import Image, ImageDraw

from src import (
    DEFAULT_LIMITS,
    ExtractionLimits,
    GatewayClient,
    GatewayError,
    MistralOcrAdapter,
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
from src.worker import (
    WORKER_VERSION,
    _pipeline_identity,
    _provider_api_key,
    _scrub_credential_env,
)


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


def _write_docx(path: Path, header_text: str | None = None) -> None:
    """`header_text` writes a `word/header1.xml`, the part `_parse_docx` used to never open."""
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
        if header_text is not None:
            archive.writestr(
                "word/header1.xml",
                '<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                f"<w:p><w:r><w:t>{header_text}</w:t></w:r></w:p></w:hdr>",
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


def _partial_flag_check(fixtures: Path) -> dict[str, Any]:
    """`document.partial` says whether anything was left unlooked-at, and now has to earn it.

    The flag gates `service_record_document_packet`, which refuses an automatic split unless the
    extraction was complete. While it was hardcoded `True` that gate could never open for any
    document at all, and every review screen told every reviewer their clean PDF was half read.
    Both directions are asserted here on the same file, with only the cap changed -- and so is the
    case that must NOT set it: a page that was sent and came back empty.

    Model-free and offline: page rendering is stubbed and the adapter is a local stand-in.
    """
    from src import parsers

    source = fixtures / "scan-page-cap.pdf"
    _write_scanned_pdf(source, page_count=4)
    seen: list[int] = []

    class TranscribingAdapter:
        def __init__(self, silent_pages: set[int] | None = None) -> None:
            self.silent_pages = silent_pages or set()

        def extract(self, pages: list[PageImage], limits: ExtractionLimits) -> dict[str, Any]:
            del limits
            seen.extend(page.page for page in pages)
            read = [page for page in pages if page.page not in self.silent_pages]
            return {
                "schema_version": "1",
                "document": {
                    "page_count": max(page.page for page in pages),
                    "detected_languages": ["en"],
                    "plain_text": "\n\n".join(f"page {page.page}" for page in read),
                    # Every page in `pages` was looked at, including a silent one.
                    "partial": False,
                },
                "blocks": [
                    {
                        "id": f"cap-p{page.page}",
                        "page": page.page,
                        "type": "text",
                        "bbox": [0.0, 0.0, 1.0, 1.0],
                        "text": f"page {page.page}",
                        "confidence": None,
                    }
                    for page in read
                ],
                "tables": [],
                "marks": [],
            }

    def fake_render(path: Path, page: int, limits: ExtractionLimits) -> PageImage:
        del limits
        output = path.parent / f"cap-render-{page}.png"
        output.write_bytes(b"rendered")
        return PageImage(page, output, 10, 10)

    original_render = parsers._render_pdf_page
    parsers._render_pdf_page = fake_render
    try:
        seen.clear()
        capped = extract_file(
            source,
            "application/pdf",
            adapter=TranscribingAdapter(),
            limits=ExtractionLimits(max_ai_pages=2, max_decompressed_bytes=10_000),
        )
        assert seen == [1, 2], f"the page cap did not bound the paid path: {seen}"
        assert capped["document"]["page_count"] == 4
        assert capped["document"]["partial"] is True, \
            "pages dropped by max_ai_pages were reported as read"

        seen.clear()
        whole = extract_file(
            source,
            "application/pdf",
            adapter=TranscribingAdapter(),
            limits=ExtractionLimits(max_ai_pages=4, max_decompressed_bytes=10_000),
        )
        assert seen == [1, 2, 3, 4], f"the uncapped run skipped a page: {seen}"
        assert whole["document"]["partial"] is False, \
            "a scan whose every page was transcribed still claimed a gap"

        # The arm that is deliberately absent. Page 2 was rendered, sent and read, and yielded
        # nothing -- indistinguishable from a blank verso without pixel analysis. Counting it
        # would mark most scanned packets partial for having a blank back side.
        seen.clear()
        empty_page = extract_file(
            source,
            "application/pdf",
            adapter=TranscribingAdapter(silent_pages={2}),
            limits=ExtractionLimits(max_ai_pages=4, max_decompressed_bytes=10_000),
        )
        assert seen == [1, 2, 3, 4], f"the empty-page run skipped a page: {seen}"
        assert empty_page["document"]["partial"] is False, \
            "an attempted page that came back empty was reported as never read"
    finally:
        parsers._render_pdf_page = original_render
        for leftover in fixtures.glob("cap-render-*.png"):
            leftover.unlink(missing_ok=True)

    # A PDF with a text layer on every page never enters the OCR branch, and a spreadsheet cannot
    # be truncated at all -- `_parse_xlsx` refuses an oversized file rather than cutting it. Both
    # must therefore report a complete read.
    text_layer = extract_file(fixtures / "text.pdf", "application/pdf", limits=DEFAULT_LIMITS)
    assert text_layer["document"]["partial"] is False, "a full text-layer PDF reported a gap"
    spreadsheet = extract_file(
        fixtures / "prices.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        limits=DEFAULT_LIMITS,
    )
    assert spreadsheet["document"]["partial"] is False, "a fully parsed spreadsheet reported a gap"

    # HTML and DOCX are decided by what those parsers structurally cannot see, not by a constant.
    wrapper = fixtures / "image-wrapper.html"
    wrapper.write_text('<!doctype html><p>Invoice</p><img src="scan.png">', encoding="utf-8")
    assert extract_file(wrapper, "text/html", limits=DEFAULT_LIMITS)["document"]["partial"] is True
    assert extract_file(
        fixtures / "page.html", "text/html", limits=DEFAULT_LIMITS
    )["document"]["partial"] is False

    # A Word header is read rather than flagged. Anything else would mark every file that carries
    # a letterhead or a page number partial, which is the defect this work exists to remove.
    headed = fixtures / "headed.docx"
    _write_docx(headed, header_text='ח.פ. 512345678')
    headed_payload = extract_file(
        headed,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        limits=DEFAULT_LIMITS,
    )
    assert "512345678" in headed_payload["document"]["plain_text"], "the header was not extracted"
    assert headed_payload["document"]["partial"] is False, "an extracted header was still flagged"
    assert extract_file(
        fixtures / "document.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        limits=DEFAULT_LIMITS,
    )["document"]["partial"] is False

    return {
        "ai_page_cap": "partial",
        "same_scan_uncapped": "complete",
        "attempted_but_empty_page": "complete",
        "text_layer_pdf": "complete",
        "spreadsheet": "complete",
        "html_image_wrapper": "partial",
        "docx_header": "extracted",
    }


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


def _openai_page_progress_check(fixtures: Path) -> dict[str, Any]:
    """Progress counts finished pages, in completion order, and never blocks the transcription."""
    pages = [PageImage(page, fixtures / "pixel.png", 16, 16) for page in range(1, 5)]
    reports: list[tuple[int, int]] = []
    adapter = OpenAiOcrAdapter(
        "sk-self-check-000000000000",
        qa_passes=1,
        page_concurrency=2,
        opener=_FakeOpener(_openai_envelope(["unused"])),
        sleep=lambda _s: None,
        progress=lambda done, total: reports.append((done, total)),
    )
    lock = threading.Lock()

    def transcribe(page: PageImage, limits: ExtractionLimits) -> tuple[list[str], list[bool]]:
        del limits
        # Page 1 finishes last. A counter driven by the ordered result list would report "1 of 4"
        # while three pages were already paid for and done.
        if page.page == 1:
            time.sleep(0.05)
        with lock:
            return [f"page {page.page}"], [True]

    adapter._transcribe_with_consensus = transcribe  # type: ignore[method-assign]
    payload = validate_extraction(adapter.extract(pages, DEFAULT_LIMITS), DEFAULT_LIMITS)
    assert [block["page"] for block in payload["blocks"]] == [1, 2, 3, 4]
    assert [done for done, _total in reports] == [1, 2, 3, 4], f"unordered_progress:{reports}"
    assert {total for _done, total in reports} == {4}, f"unexpected_progress_total:{reports}"

    # A reporter that throws is a broken status line, not a broken document.
    exploding = OpenAiOcrAdapter(
        "sk-self-check-000000000000",
        qa_passes=1,
        page_concurrency=1,
        opener=_FakeOpener(_openai_envelope(["unused"])),
        sleep=lambda _s: None,
        progress=lambda _done, _total: (_ for _ in ()).throw(RuntimeError("progress sink down")),
    )
    exploding._transcribe_with_consensus = (  # type: ignore[method-assign]
        lambda page, limits: ([f"page {page.page}"], [True])
    )
    survived = validate_extraction(exploding.extract(pages, DEFAULT_LIMITS), DEFAULT_LIMITS)
    assert len(survived["blocks"]) == 4

    # The batched PDF path calls extract() once per memory-bounded batch. Reporting len(pages)
    # there described the BATCH, so a four-page scan on the live site reported "page 1 of 2" and
    # the counter restarted at every flush. begin_progress() declares the document total once.
    batched = OpenAiOcrAdapter(
        "sk-self-check-000000000000",
        qa_passes=1,
        page_concurrency=1,
        opener=_FakeOpener(_openai_envelope(["unused"])),
        sleep=lambda _s: None,
        progress=lambda done, total: reports.append((done, total)),
    )
    batched._transcribe_with_consensus = (  # type: ignore[method-assign]
        lambda page, limits: ([f"page {page.page}"], [True])
    )
    reports.clear()
    batched.begin_progress(4)
    for batch in ([pages[0], pages[1]], [pages[2], pages[3]]):
        validate_extraction(batched.extract(batch, DEFAULT_LIMITS), DEFAULT_LIMITS)
    assert reports == [(1, 4), (2, 4), (3, 4), (4, 4)], f"batched_progress_wrong:{reports}"

    return {
        "reports": 4,
        "completion_order": "passed",
        "sink_failure": "ignored",
        "batched_document_total": "passed",
    }


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
    # An adapter attempts every page it is handed, so it never has a coverage gap to report --
    # including for a page that came back with nothing, which was looked at and found empty. This
    # assertion used to read `is True` and passed only because the adapter hardcoded it there.
    assert payload["document"]["partial"] is False, "a fully transcribed page reported a gap"
    empty = OpenAiOcrAdapter(
        "sk-self-check-000000000000",
        qa_passes=1,
        opener=_FakeOpener(_openai_envelope([])),
        sleep=lambda _s: None,
    )
    silent = validate_extraction(empty.extract([page], DEFAULT_LIMITS), DEFAULT_LIMITS)
    assert silent["document"]["partial"] is False, \
        "an empty read is a quality question, not a coverage one"
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


def _write_grayscale_page(path: Path, *, width: int = 320, height: int = 400) -> None:
    """A page with intermediate tones, which is what the scan lane now hands to OCR."""
    image = Image.new("L", (width, height), 235)
    draw = ImageDraw.Draw(image)
    for index in range(8):
        y = 40 + index * ((height - 80) // 8)
        draw.line((30, y, width - 30, y), fill=40 + index * 18, width=3)
    image.save(path, format="PNG")


def _ocr_payload(lines_by_page: dict[int, list[tuple[str, float | None]]]) -> dict[str, Any]:
    """The shape both OCR adapters return, with `confidence` under the caller's control.

    0.0 is the consensus flag: no other transcription pass reproduced that line's numbers.
    """
    blocks: list[dict[str, Any]] = []
    page_text: list[str] = []
    for page in sorted(lines_by_page):
        entries = lines_by_page[page]
        total = max(1, len(entries))
        for index, (text, confidence) in enumerate(entries, start=1):
            blocks.append(
                {
                    "id": f"ocr-p{page}-l{index}",
                    "page": page,
                    "type": "text",
                    "bbox": [0.0, (index - 1) / total, 1.0, index / total],
                    "text": text,
                    "confidence": confidence,
                }
            )
        page_text.append("\n".join(text for text, _confidence in entries))
    return {
        "schema_version": "1",
        "document": {
            "page_count": max(lines_by_page),
            "detected_languages": [],
            "plain_text": "\n\n".join(page_text),
            # What both real adapters now report, for the reason they report it: this stand-in is
            # handed pages and transcribes all of them, so it never leaves one unlooked-at. A page
            # with zero lines below is a page that was read and came back empty.
            "partial": False,
        },
        "blocks": blocks,
        "tables": [],
        "marks": [],
    }


class _ScriptedOcrAdapter:
    """Returns scripted payloads and records what each call was actually shown.

    Model-free by construction: no provider, no network, no image model. `tones` is how the check
    proves the recovery pass really re-binarized the page rather than resubmitting it unchanged.
    """

    def __init__(self, scripts: list[Any]) -> None:
        self.scripts = scripts
        self.calls: list[dict[str, Any]] = []

    def extract(self, pages: list[PageImage], limits: ExtractionLimits) -> dict[str, Any]:
        del limits
        with Image.open(pages[0].path) as image:
            tones = len(image.convert("L").getcolors(maxcolors=65_536) or [])
        self.calls.append({"pages": [page.page for page in pages], "tones": tones})
        script = self.scripts[min(len(self.calls) - 1, len(self.scripts) - 1)]
        if isinstance(script, ProcessingError):
            raise script
        return script


class _RejectingOpener:
    """An opener that answers every request with one HTTP status, so retry and cost policy can be
    checked without a network. `urllib` reports a non-2xx through HTTPError, which is the path the
    adapters actually take."""

    def __init__(self, status: int) -> None:
        self.status = status
        self.calls = 0

    def open(self, request: Any, timeout: float | None = None) -> Any:
        del request, timeout
        self.calls += 1
        raise urllib.error.HTTPError(
            "https://provider.invalid", self.status, "rejected", {}, io.BytesIO(b"{}")
        )


def _mistral_envelope(
    blocks: list[dict[str, Any]] | None = None,
    markdown: str | None = None,
    dimensions: dict[str, Any] | None = None,
) -> dict[str, Any]:
    page: dict[str, Any] = {
        "index": 0,
        "dimensions": dimensions if dimensions is not None else {"width": 1000, "height": 2000},
    }
    if blocks is not None:
        page["blocks"] = blocks
    if markdown is not None:
        page["markdown"] = markdown
    return {
        "model": "mistral-ocr-2026-05-01",
        "usage_info": {"pages_processed": 1},
        "pages": [page],
    }


def _mistral_block(
    content: str,
    *,
    kind: str = "text",
    corners: tuple[int, int, int, int] | None = (100, 200, 900, 260),
    confidence: float | None = 0.93,
) -> dict[str, Any]:
    block: dict[str, Any] = {"type": kind, "content": content}
    if corners is not None:
        block.update(
            {
                "top_left_x": corners[0],
                "top_left_y": corners[1],
                "bottom_right_x": corners[2],
                "bottom_right_y": corners[3],
            }
        )
    if confidence is not None:
        block["confidence_scores"] = {"average_content_confidence_score": confidence}
    return block


def _mistral_adapter_check(fixtures: Path) -> dict[str, Any]:
    """The production reader, offline. Selected on ocr-ab/20260818; see triage-outcome.md.

    Covers the two things this adapter claims and the OpenAI one cannot: geometry it measured
    rather than synthesised, and a confidence the provider graded rather than the adapter inferred.
    Both must survive `validate_extraction`, and neither may appear when the provider omits it.
    """
    page = PageImage(1, fixtures / "pixel.png", 16, 16)
    envelope = _mistral_envelope(
        [
            _mistral_block('ספק בדיקה בע"מ', kind="title"),
            _mistral_block("מוצר 1   ₪31.90", corners=(100, 300, 900, 360), confidence=0.41),
            # No geometry and no grade: the adapter must synthesise the band and leave confidence
            # unknown rather than fill either one in with a plausible number.
            _mistral_block('סה"כ לתשלום 31.90', corners=None, confidence=None),
        ]
    )
    opener = _FakeOpener(envelope)
    adapter = MistralOcrAdapter("mistral-self-check-0000000000", opener=opener, sleep=lambda _s: None)
    payload = validate_extraction(adapter.extract([page], DEFAULT_LIMITS), DEFAULT_LIMITS)
    blocks = payload["blocks"]
    assert len(blocks) == 3, f"block_count:{len(blocks)}"
    assert blocks[0]["type"] == "heading", f"block_type:{blocks[0]['type']}"
    assert blocks[0]["bbox"] == [0.1, 0.1, 0.9, 0.13], f"measured_bbox:{blocks[0]['bbox']}"
    assert blocks[1]["confidence"] == 0.41, f"graded_confidence:{blocks[1]['confidence']}"
    # Synthesised band: full width, third of three.
    assert blocks[2]["bbox"] == [0.0, 2 / 3, 1.0, 1.0], f"synthesised_bbox:{blocks[2]['bbox']}"
    assert blocks[2]["confidence"] is None, f"invented_confidence:{blocks[2]['confidence']}"
    assert 'סה"כ לתשלום 31.90' in payload["document"]["plain_text"]
    assert payload["document"]["partial"] is False
    assert adapter.observed_models == ["mistral-ocr-2026-05-01"], adapter.observed_models
    assert len(opener.requests) == 1, f"billed_calls:{len(opener.requests)}"

    # A markdown-only page (no blocks) still yields content rather than an error.
    markdown_only = MistralOcrAdapter(
        "mistral-self-check-0000000000",
        opener=_FakeOpener(_mistral_envelope(markdown="| כמות | פריט |\n| --- | --- |\n| 2 | מלח |")),
        sleep=lambda _s: None,
    )
    from_markdown = validate_extraction(markdown_only.extract([page], DEFAULT_LIMITS), DEFAULT_LIMITS)
    assert from_markdown["tables"], "markdown_table_dropped"

    # A page with neither blocks nor markdown is a provider fault, not an empty document.
    empty = MistralOcrAdapter(
        "mistral-self-check-0000000000",
        opener=_FakeOpener({"model": "mistral-ocr-2026-05-01", "pages": []}),
        sleep=lambda _s: None,
    )
    try:
        empty.extract([page], DEFAULT_LIMITS)
    except ProcessingError as exc:
        assert exc.code == "ocr_invalid_output", exc.code
    else:  # pragma: no cover - the assertion above is the check
        raise AssertionError("empty_pages_accepted")

    # Same cost ceiling as the OpenAI adapter: the adapter retried, so the job runner must not.
    rate_limited = MistralOcrAdapter(
        "mistral-self-check-0000000000",
        opener=_RejectingOpener(429),
        sleep=lambda _s: None,
    )
    try:
        rate_limited.extract([page], DEFAULT_LIMITS)
    except ProcessingError as exc:
        assert exc.code == "ocr_provider_rate_limited", exc.code
        assert exc.retryable is False, "paid_retry_multiplied"
    else:  # pragma: no cover
        raise AssertionError("rate_limit_accepted")

    # A key too short to be real must fail at construction, not at the first paid call.
    try:
        MistralOcrAdapter("short")
    except ProcessingError as exc:
        assert exc.code == "worker_config_invalid", exc.code
    else:  # pragma: no cover
        raise AssertionError("short_key_accepted")

    return {
        "measured_geometry": "passed",
        "graded_confidence": "passed",
        "synthesised_band": "passed",
        "markdown_fallback": "passed",
        "provider_faults": "passed",
        "billed_calls_per_page": 1,
    }


def _mistral_page_progress_check(fixtures: Path) -> dict[str, Any]:
    """The live page counter. `begin_progress` declares the DOCUMENT total, not the batch's."""
    pages = [PageImage(page, fixtures / "pixel.png", 16, 16) for page in range(1, 5)]
    reports: list[tuple[int, int]] = []
    adapter = MistralOcrAdapter(
        "mistral-self-check-0000000000",
        opener=_FakeOpener(_mistral_envelope([_mistral_block("שורה")])),
        sleep=lambda _s: None,
        progress=lambda done, total: reports.append((done, total)),
    )
    adapter.begin_progress(4)
    for batch in ([pages[0], pages[1]], [pages[2], pages[3]]):
        validate_extraction(adapter.extract(batch, DEFAULT_LIMITS), DEFAULT_LIMITS)
    assert reports == [(1, 4), (2, 4), (3, 4), (4, 4)], f"batched_progress_wrong:{reports}"

    # A reporter that throws is a broken status line, not a broken document.
    exploding = MistralOcrAdapter(
        "mistral-self-check-0000000000",
        opener=_FakeOpener(_mistral_envelope([_mistral_block("שורה")])),
        sleep=lambda _s: None,
        progress=lambda _done, _total: (_ for _ in ()).throw(RuntimeError("progress sink down")),
    )
    survived = validate_extraction(exploding.extract(pages, DEFAULT_LIMITS), DEFAULT_LIMITS)
    assert len(survived["blocks"]) == 4, f"pages_lost:{len(survived['blocks'])}"

    return {"batched_document_total": "passed", "sink_failure": "ignored"}


def _mistral_worker_wiring_check() -> dict[str, Any]:
    """The factory, the identity written to `document_extractions`, and the key path.

    A worker configured for one vendor must not start on the other's key: the two are different
    secrets, and silently reading the wrong one is how a canary ends up measuring nothing.
    """
    adapter = create_ocr_adapter("mistral", "mistral-self-check-0000000000")
    assert type(adapter).__name__ == "MistralOcrAdapter", type(adapter).__name__
    assert _pipeline_identity("mistral") == (
        "supplyflow-native+mistral",
        "mistral-ocr-latest",
        "v1/ocr",
    ), _pipeline_identity("mistral")

    try:
        create_ocr_adapter("mistral", "")
    except ProcessingError as exc:
        assert exc.code == "worker_config_invalid", exc.code
    else:  # pragma: no cover
        raise AssertionError("keyless_mistral_adapter_accepted")

    previous = {name: os.environ.get(name) for name in ("OPENAI_API_KEY", "MISTRAL_API_KEY")}
    try:
        os.environ["OPENAI_API_KEY"] = "sk-openai-key-000000000000"
        os.environ.pop("MISTRAL_API_KEY", None)
        assert _provider_api_key("mistral") == "", "openai_key_leaked_into_mistral_worker"
        os.environ["MISTRAL_API_KEY"] = "mistral-key-0000000000000000"
        assert _provider_api_key("mistral") == "mistral-key-0000000000000000"
        assert _provider_api_key("openai") == "sk-openai-key-000000000000"
        assert _provider_api_key("tesseract") == ""
        _scrub_credential_env()
        assert os.environ.get("MISTRAL_API_KEY") is None, "mistral_key_left_in_environment"
        assert os.environ.get("OPENAI_API_KEY") is None, "openai_key_left_in_environment"
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    return {"factory": "passed", "pipeline_identity": "passed", "key_isolation": "passed"}


def _second_pass_check(fixtures: Path) -> dict[str, Any]:
    """One re-binarized retry, only on a measurably failed page, only when it is measurably better.

    Every scenario below runs against a real grayscale PNG through the real image lane, with a
    scripted adapter in place of the paid model.
    """
    from src import second_pass

    source = fixtures / "grayscale-page.png"
    _write_grayscale_page(source)

    def run(scripts: list[Any]) -> tuple[dict[str, Any], _ScriptedOcrAdapter, dict[str, Any]]:
        adapter = _ScriptedOcrAdapter(scripts)
        diagnostics: dict[str, Any] = {}
        payload = extract_file(
            source, "image/png", adapter=adapter, limits=DEFAULT_LIMITS, diagnostics=diagnostics
        )
        return payload, adapter, diagnostics

    healthy = _ocr_payload({1: [(f"שורה {index} 12.50", None) for index in range(1, 7)]})
    broken = _ocr_payload({1: []})
    flagged = _ocr_payload(
        {1: [("סה\"כ 1,392.00", 0.0)] * 5 + [("ספק בדיקה", None)]}
    )
    recovered = _ocr_payload({1: [(f"שורה {index} 12.50", None) for index in range(1, 9)]})

    # 1. A healthy page never pays for a second pass.
    payload, adapter, diagnostics = run([healthy])
    assert len(adapter.calls) == 1, f"healthy_page_paid_twice:{adapter.calls}"
    assert diagnostics == {}, f"healthy_page_reported_a_second_pass:{diagnostics}"
    assert adapter.calls[0]["tones"] > 2, "the first pass must see the grayscale scan"
    assert len(payload["blocks"]) == 6

    # The two signals are orthogonal, which is why this lane cannot be built on `document.partial`
    # in either direction: the page below WAS looked at -- coverage complete, flag false -- and it
    # is still exactly the page this module exists to retry.
    assert broken["document"]["partial"] is False, \
        "a page that was read and came back empty is not a coverage gap"

    # 2. A page that produced no text at all is an unambiguous failure.
    payload, adapter, diagnostics = run([broken, recovered])
    assert len(adapter.calls) == 2, f"empty_page_did_not_retry:{adapter.calls}"
    assert adapter.calls[1]["tones"] == 2, \
        f"the retry must be binarized, saw {adapter.calls[1]['tones']} tones"
    assert len(payload["blocks"]) == 8, "the recovered read was not kept"
    assert payload["document"]["plain_text"].startswith("שורה 1")
    assert payload["document"]["partial"] is False, "recovery must not invent a coverage gap"
    assert diagnostics["second_pass"] == {
        "attempted_pages": [1],
        "extra_extractions": 1,
        "improved_pages": [1],
    }, f"unexpected_audit:{diagnostics}"

    # 3. A page whose numbers no pass could reproduce is the other failure signal.
    payload, adapter, diagnostics = run([flagged, recovered])
    assert len(adapter.calls) == 2, f"consensus_failure_did_not_retry:{adapter.calls}"
    assert len(payload["blocks"]) == 8
    assert diagnostics["second_pass"]["improved_pages"] == [1]

    # 4. Conservative in both directions: a minority of flagged lines is not a failure, and a
    #    short page is not judged by a ratio at all.
    minority = _ocr_payload(
        {1: [("סה\"כ 1,392.00", 0.0)] * 4 + [("ספק", None), ("תאריך", None)]}
    )
    short = _ocr_payload({1: [("סה\"כ 1,392.00", 0.0)] * 3})
    unchecked = _ocr_payload({1: [(f"שורה {index}", None) for index in range(1, 9)]})
    for name, first in (("minority", minority), ("short", short), ("unchecked", unchecked)):
        _payload, adapter, diagnostics = run([first, recovered])
        assert len(adapter.calls) == 1, f"{name}_page_paid_for_a_retry:{adapter.calls}"
        assert diagnostics == {}, f"{name}_page_reported_a_second_pass"

    # 5. A second result that is not better is discarded. Never regress a read that exists.
    same_count = _ocr_payload({1: [(f"שורה {index}", None) for index in range(1, 7)]})
    more_but_worse = _ocr_payload({1: [(f"שורה {index} 9.90", 0.0) for index in range(1, 10)]})
    for name, second in (("no_gain", same_count), ("worse_consensus", more_but_worse)):
        payload, adapter, diagnostics = run([flagged, second])
        assert len(adapter.calls) == 2, f"{name}_did_not_attempt"
        assert [block["text"] for block in payload["blocks"]] == [
            block["text"] for block in flagged["blocks"]
        ], f"{name}_replaced_a_better_first_read"
        assert diagnostics["second_pass"] == {
            "attempted_pages": [1],
            "extra_extractions": 1,
        }, f"{name}_claimed_an_improvement:{diagnostics}"

    # 6. A failing recovery attempt must never fail a document that already has a read, and must
    #    never hand the job runner a retryable error to multiply into more paid calls.
    payload, adapter, diagnostics = run(
        [flagged, ProcessingError("ocr_provider_unavailable", "unavailable", retryable=True)]
    )
    assert [block["text"] for block in payload["blocks"]] == [
        block["text"] for block in flagged["blocks"]
    ], "a failed retry lost the first read"
    assert diagnostics["second_pass"]["error"] == "ocr_provider_unavailable"
    assert "improved_pages" not in diagnostics["second_pass"]

    # 7. Cost ceiling: one extra extraction per invocation, and a page budget spent PER DOCUMENT.
    #    `_parse_pdf` calls this once per memory-bounded batch, sharing one audit; a per-call cap
    #    would let a seven-batch document retry twenty-one pages.
    pages = []
    for number in range(1, 6):
        page_path = fixtures / f"grayscale-page-{number}.png"
        _write_grayscale_page(page_path)
        pages.append(PageImage(number, page_path, 320, 400))
    all_broken = _ocr_payload({number: [] for number in range(1, 6)})
    capped = _ScriptedOcrAdapter([_ocr_payload({number: [] for number in range(1, 6)})])
    audit: dict[str, Any] = {}
    second_pass.improve(all_broken, pages, capped, DEFAULT_LIMITS, audit)
    assert len(capped.calls) == 1, f"second_pass_called_more_than_once:{capped.calls}"
    assert capped.calls[0]["pages"] == [1, 2, 3], f"page_cap_not_applied:{capped.calls}"
    assert audit["extra_extractions"] == 1
    # A later batch of the same document finds the budget already spent and pays nothing.
    second_pass.improve(all_broken, pages, capped, DEFAULT_LIMITS, audit)
    assert len(capped.calls) == 1, f"page_budget_reset_between_batches:{capped.calls}"
    assert audit["extra_extractions"] == 1
    assert not list(fixtures.glob("*-binarized.png")), "binarized temporaries were not removed"

    return {
        "healthy_page": "no_retry",
        "empty_page": "retried",
        "consensus_failure": "retried",
        "minority_flagged": "no_retry",
        "worse_result": "discarded",
        "failed_retry": "first_read_kept",
        "page_cap": second_pass.SECOND_PASS_MAX_PAGES,
        "extra_extractions_per_call": 1,
    }


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
    # Word order is repaired by the SECOND corrector now -- see `_line_order_check`. This one is
    # deliberately unchanged: it is still the right answer for a generator that stored the words
    # backwards without moving them, and it still runs on documents that show no line-order tell.
    return {"detect": "passed", "repair": "passed", "word_order": "repaired_by_hebrew_line_order"}


def _line_order_check() -> dict[str, Any]:
    """#A: a product name's WORD ORDER is its meaning, and the repair only ever fixed letters.

    WHAT WAS MEASURED, AND WHERE. W0-G8 read production: 271 catalogue products, 105 names (39%)
    damaged, 166 clean. The damage is a bidirectional extraction failure -- the PDF text layer
    holds glyphs in visual order and the extractor read them as logical order -- and its signature
    is specific: names beginning with a closing bracket, names carrying a close with no open, and
    names with a digit fused to the Hebrew letter that belonged after it. `_reverse_hebrew_runs`
    cannot remove any of those three, because it never moves a word. `_hebrew_order_check` above
    has said so in its own return value for as long as it has existed.

    THE TWO HALVES THIS ASSERTS, because a repair that only proves one of them is not finished:

      1. A visual-order layer comes back EXACTLY logical. Every fixture below is round-tripped
         through the layout and back, and must return byte for byte what it started as.
      2. A logical-order layer DOES NOT MOVE. The detector must not fire on a single one of the
         readable names, including the bilingual ones W0-G8 reported as undamaged -- those are
         the 166 that must not move, and a corrector that "fixes" them is a worse defect than the
         one it replaces.

    THE FIXTURES ARE REAL. The three damaged strings are the ones measured in the live catalogue
    and kept verbatim in `src/lib/productDisplayName.spec.ts`; the readable ones are that file's
    own readable corpus plus catalogue rows from the demo seed. THE DAMAGED THREE ARE USED FOR
    DETECTION ONLY: they are catalogue rows, not raw text layers, so asserting a repaired value
    for them would be asserting something about a pipeline stage this repository does not hold.
    Repairing the rows that already exist is a data remediation and is not this change.
    """
    from src.parsers import _line_order_evidence, _restore_line_order

    damaged = [
        ')ב12- אר30*30מטליות מיקרופייבר',
        ')ק"ג 5( קמח לבן',
        'שקיות אשפה 60*80 )100 יח',
    ]
    readable = [
        'שמן קנולה 100 מ״ל',
        'קוטג׳ תנובה 250 גרם',
        'עגבניות שרי',
        'מטליות מיקרופייבר 30*30 (12 ביחידה)',
        'מפיות דמוי בד לבן PREMIUM NAPKINS',
        'תה עטוף 100/1ג',
        'סודה 1.5 ליטר (ארגז 6)',
        'סכו"ם חד"פ (מארז 300)',
        'גבינה 5% (מיכל 5 ק"ג)',
        'ביצים L (תבנית 30)',
        'קמח לבן (שק 25 ק"ג)',
        'P18B product',
        # An ordinary name with ONE dropped opening bracket. This used to score
        # `closer_before_opener = 1`, and because the decision is taken for the whole document that
        # one line was enough to reverse every line on every page -- turning this name into
        # `(ג"ק 5 ןבל חמק`. A closer that ENDS a line is where a closer belongs; the bracket that
        # went missing is the opener, and no repair can put it back by reversing the letters.
        'קמח לבן 5 ק"ג)',
        # A HEBREW LIST MARKER. `א)` puts a closer after one character with content after it --
        # exactly the shape the inversion scan looks for -- so every itemised price list read as
        # reversed. It is how a Hebrew document enumerates, not a mirrored bracket.
        'א) קמח לבן',
        '1) שמן זית',
    ]

    # A PARENTHETICAL THAT WRAPPED, which no single-line fixture can express. The opener is on one
    # line and its closer begins the next, and judging each line as a whole paragraph read that
    # leading closer as mirrored. Together with a list marker on a third line it scored
    # `strong=1, evidence=2` and inverted a document of ordinary logical text.
    wrapped_parenthetical = "(תנאים\n) המשך\nא) מוצר"

    # And the two shapes that survived the SECOND repair. A chain of continuation lines -- each
    # closing the previous line's bracket and opening its own -- read as balanced-and-inverted
    # because the ordered scan restarted at depth zero on every line, so carrying the depth into
    # the skip test alone had decided nothing. And a list marker whose trailing space OCR dropped
    # (`א)קמח`) missed a `\\s+` and scored as evidence, while the same line with the space did not.
    chained_continuations = (
        "(סעיף ראשון\n) המשך (סעיף שני\n) המשך (סעיף שלישי\n) סוף"
    )
    marker_without_space = "(סעיף ראשון\n) המשך (סעיף שני\n) סוף\nא)קמח"

    def fires(text: str) -> bool:
        _, leading, inverted, _, _, _ = _line_order_evidence(text)
        return leading + inverted > 0

    for name in damaged:
        assert fires(name), f"the detector missed a name measured as damaged: {name!r}"
    for name in readable:
        assert not fires(name), f"the detector fired on a readable name: {name!r}"
        # Belt and braces: even if the detector ever did fire, running the transform over an
        # undamaged pure-Latin or bilingual name must not reorder its words.
        assert _restore_line_order(_restore_line_order(name)) == name, name

    # The round trip. `_restore_line_order` is its own inverse, so laying a logical name out
    # backwards and inverting it must return the original -- which is exactly what re-running the
    # extraction over the retained submissions does.
    for name in readable:
        laid_out = _restore_line_order(name)
        assert _restore_line_order(laid_out) == name, f"round trip lost {name!r}"

    # And the residue the shipped repair leaves behind, stated as a fact rather than a worry: on a
    # line laid out backwards, the word-level repair returns something that is NOT the original.
    sample = 'מטליות מיקרופייבר 30*30 (12 ביחידה)'
    laid_out = _restore_line_order(sample)
    from src.parsers import _reverse_hebrew_runs as word_only

    assert word_only(laid_out) != sample, (
        "the word-level repair now recovers word order, so this check is measuring nothing"
    )
    assert _restore_line_order(laid_out) == sample

    # A pure-Latin line is not a right-to-left line and is returned untouched.
    assert _restore_line_order('P18B product') == 'P18B product'

    # AND THE DECISION IS TAKEN FOR A WHOLE DOCUMENT, so line-level evidence is not the whole
    # story. `_restore_line_order` does not merely reorder words -- it reverses letters -- so a
    # false positive here does not fail to repair a name, it destroys one. Three documents:
    from src.parsers import _normalize_pdf_text_layer

    def inverts(pages: dict[int, str]) -> bool:
        _text, records = _normalize_pdf_text_layer(dict(pages))
        return bool(records[0]["applied"])

    # 1. A clean catalogue that contains ONE line carrying the strongest possible tell is still a
    #    clean catalogue. One line may not speak for a hundred pages; that was the defect.
    one_tell = {1: "\n".join(readable), 2: 'ק"ג 5( קמח לבן)'}
    assert not inverts(one_tell), "a single line inverted an entire document"

    # 2. Corroboration must not have silenced the repair. A layer carrying the measured damage
    #    signature on more than one line is still inverted, and the record still pairs: the
    #    preserved original, put through the named transform, reproduces the stored text.
    damaged_pages = {
        1: ')ק"ג 5( קמח לבן\nשקיות אשפה 60*80 )100 יח',
        2: ')ביחידה 12( מטליות מיקרופייבר 30*30\nשמן קנולה 100 מ״ל',
    }
    assert inverts(damaged_pages), "corroboration silenced a document that really was backwards"
    repaired, damaged_records = _normalize_pdf_text_layer(dict(damaged_pages))
    assert repaired != damaged_pages, "the document was reported inverted but nothing moved"
    preserved = damaged_records[0]["original_text"]
    assert preserved == "\n".join(damaged_pages.values()), "original not preserved"
    assert _restore_line_order(preserved) == "\n".join(repaired.values()), (
        "the preserved original does not reproduce the stored text under the named transform"
    )

    # 3. And the document made of the readable corpus alone -- stray closing bracket included --
    #    is left exactly as it arrived, by both correctors.
    clean_pages = {1: "\n".join(readable[:6]), 2: "\n".join(readable[6:])}
    untouched, clean_records = _normalize_pdf_text_layer(dict(clean_pages))
    assert untouched == clean_pages, untouched
    assert all(entry["applied"] is False for entry in clean_records), clean_records

    # 4. A parenthetical that wrapped across two lines, with an enumerated item under it. Every
    #    line here is ordinary logical text and the document must arrive unchanged. This is the
    #    shape that survived the first repair: the leading closer on the second line belongs to
    #    the first line's opener, and `א)` is a list marker rather than a mirrored bracket.
    for label, text in (
        ("wrapped parenthetical", wrapped_parenthetical),
        ("chained continuations", chained_continuations),
        ("list marker with no space", marker_without_space),
    ):
        pages = {1: text}
        out, records = _normalize_pdf_text_layer(dict(pages))
        assert out == pages, (label, out)
        assert all(entry["applied"] is False for entry in records), (label, records)

    return {
        "damaged_detected": f"{len(damaged)}/{len(damaged)}",
        "readable_false_positives": f"0/{len(readable)}",
        "round_trip": f"{len(readable)}/{len(readable)}",
        "word_order": "repaired",
        "one_line_inverts_a_document": "no",
        "logical_documents_survive": "3/3",
    }


def _normalization_evidence_check(fixtures: Path, adapter: SyntheticOcrAdapter) -> dict[str, Any]:
    """#20: the correction above must be PROVABLE from a stored extraction, not merely correct.

    Before this, the repair overwrote the text in place. The pre-repair string existed nowhere
    afterwards and nothing recorded that the repair had run, so a stored extraction could not
    distinguish a document that printed Hebrew logically from one this worker turned around.

    Four properties, each of which used to be false or unrepresentable:

      1. THE RECORD SURVIVES THE CONTRACT. `validate_extraction` carries it key for key, and the
         gateway validator on the other side of the wire refuses a payload without it.
      2. WHEN IT FIRES, THE ORIGINAL IS PRESERVED -- verbatim, as the detector saw it.
      3. THE PAIRING IS EXACT. Re-applying the named transform to the preserved original must
         reproduce the stored text. The claim "this is the normalized form of that" is checked
         here rather than asserted in a comment.
      4. WHEN IT DOES NOT FIRE, THE DECISION IS STILL RECORDED, with `applied: false` and no
         second copy of the text. Silence and "we looked and left it alone" are different facts.
    """
    from src.contract import HEBREW_LINE_ORDER, HEBREW_VISUAL_ORDER
    from src.parsers import (
        _hebrew_is_reversed,
        _normalize_pdf_text_layer,
        _reverse_hebrew_runs,
    )

    visual_pages = {
        1: 'הלבק רוקמ ךמסמ בשחוממ סומאג םיעוריא מ"עב 516660602',
        2: 'ריחמ 1,392.00 ILS',
    }
    corrected, records = _normalize_pdf_text_layer(dict(visual_pages))
    # Two correctors are evaluated on every PDF text layer; at most one of them fires. The
    # word-level one is the second entry and it is the one this fixture triggers, because the
    # fixture stores words backwards without moving them.
    assert [entry["id"] for entry in records] == [HEBREW_LINE_ORDER, HEBREW_VISUAL_ORDER], records
    assert records[0]["applied"] is False, records[0]
    record = records[1]
    assert record["id"] == HEBREW_VISUAL_ORDER, record["id"]
    assert record["applied"] is True, "the visual-order fixture did not trigger the correction"
    assert record["original_text"] == "\n".join(visual_pages.values()), "original not preserved"
    assert _reverse_hebrew_runs(record["original_text"]) == "\n".join(corrected.values()), (
        "the preserved original does not reproduce the stored text under the named transform"
    )
    measured = {item["name"]: item["value"] for item in record["measurements"]}
    assert measured["final_letter_first"] > measured["final_letter_last"], measured
    assert measured["hebrew_words"] >= measured["final_letter_first"], measured

    logical_pages = {1: 'קבלה מקור מסמך ממוחשב', 2: 'סה"כ 10'}
    untouched, quiet_records = _normalize_pdf_text_layer(dict(logical_pages))
    assert all(entry["applied"] is False for entry in quiet_records), quiet_records
    quiet = quiet_records[1]
    assert untouched == logical_pages, "a document in logical order must not be rewritten"
    assert quiet["applied"] is False and quiet["original_text"] is None, quiet
    assert quiet["measurements"], "an unapplied decision must still say what it measured"

    # ONE RULE, NOT TWO. `_normalize_pdf_text_layer` compares the counts it records rather than
    # calling `_hebrew_is_reversed` a second time over the same regex, so this pins the two
    # against each other. Without it the recorded evidence could drift away from the decision it
    # claims to explain -- a record that says "13 versus 0" beside a correction that did not fire.
    for pages, decision in ((visual_pages, record), (logical_pages, quiet)):
        assert decision["applied"] == _hebrew_is_reversed("\n".join(pages.values())), (
            "the recorded decision disagrees with the detector it reports the evidence for"
        )

    # End to end, through the real parser and the real validator: every PDF carries the decision,
    # including one with no Hebrew at all. An empty array here would mean "no corrector ran",
    # which for a PDF text layer is never true.
    payload = extract_file(
        fixtures / "text.pdf", "application/pdf", adapter=adapter, limits=DEFAULT_LIMITS
    )
    entries = payload["normalizations"]
    assert [entry["id"] for entry in entries] == [HEBREW_LINE_ORDER, HEBREW_VISUAL_ORDER], entries
    assert all(entry["applied"] is False for entry in entries), entries
    assert all(entry["original_text"] is None for entry in entries), entries

    # ...and a parser with no text layer to lay out backwards says so by staying empty, rather
    # than claiming a decision it never made.
    spreadsheet = extract_file(
        fixtures / "prices.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        limits=DEFAULT_LIMITS,
    )
    assert spreadsheet["normalizations"] == [], spreadsheet["normalizations"]

    # The two halves of the pairing are unrepresentable apart. Both used to be accepted.
    _expect_processing_error(
        lambda: validate_extraction(
            {
                **_contract(1, "x"),
                "normalizations": [
                    {
                        "id": HEBREW_VISUAL_ORDER,
                        "applied": True,
                        "original_text": None,
                        "measurements": [],
                    }
                ],
            },
            DEFAULT_LIMITS,
        ),
        "invalid_extraction",
    )
    _expect_processing_error(
        lambda: validate_extraction(
            {
                **_contract(1, "x"),
                "normalizations": [
                    {
                        "id": HEBREW_VISUAL_ORDER,
                        "applied": False,
                        "original_text": "x",
                        "measurements": [],
                    }
                ],
            },
            DEFAULT_LIMITS,
        ),
        "invalid_extraction",
    )
    _expect_processing_error(
        lambda: validate_extraction(
            {**_contract(1, "x"), "normalizations": [
                {"id": "transliterate", "applied": False, "original_text": None,
                 "measurements": []}
            ]},
            DEFAULT_LIMITS,
        ),
        "invalid_extraction",
    )
    return {
        "applied": "original_preserved",
        "pairing": "transform_reproduces_stored_text",
        "unapplied": "decision_recorded",
        "pdf_always_records": True,
        "spreadsheet_records_nothing": True,
    }


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
        partial_flag = _partial_flag_check(fixtures)
        pdf_batching = _pdf_batching_check(fixtures)
        _macro_security_check(fixtures, scratch)
        _retry_and_cleanup_check(scratch)
        second_pass = _second_pass_check(fixtures)
        hebrew_order = _hebrew_order_check()
        line_order = _line_order_check()
        normalization_evidence = _normalization_evidence_check(fixtures, adapter)
        mistral_adapter = _mistral_adapter_check(fixtures)
        mistral_page_progress = _mistral_page_progress_check(fixtures)
        mistral_worker_wiring = _mistral_worker_wiring_check()
        openai_adapter = _openai_adapter_check(fixtures)
        openai_qa = _openai_qa_check(fixtures)
        openai_page_concurrency = _openai_page_concurrency_check(fixtures)
        openai_page_progress = _openai_page_progress_check(fixtures)
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
                    "partial_flag": partial_flag,
                    "pdf_batching": pdf_batching,
                    "macro_security": "passed",
                    "retry_cleanup": "passed",
                    "second_pass": second_pass,
                    "hebrew_order": hebrew_order,
                    "line_order": line_order,
                    "normalization_evidence": normalization_evidence,
                    "mistral_adapter": mistral_adapter,
                    "mistral_page_progress": mistral_page_progress,
                    "mistral_worker_wiring": mistral_worker_wiring,
                    "openai_adapter": openai_adapter,
                    "openai_qa": openai_qa,
                    "openai_page_concurrency": openai_page_concurrency,
                    "openai_page_progress": openai_page_progress,
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
