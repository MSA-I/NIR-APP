from __future__ import annotations

import csv
import os
import re
import shutil
import subprocess
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import openpyxl
import xlrd
from defusedxml import ElementTree as SafeET
from PIL import Image, ImageOps, ImageSequence, UnidentifiedImageError
from pillow_heif import register_heif_opener

try:
    from pillow_heif import register_avif_opener
except ImportError:  # pragma: no cover - guarded for older pinned wheels
    register_avif_opener = None

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from .contract import validate_extraction
from .errors import ProcessingError
from .limits import DEFAULT_LIMITS, ExtractionLimits
from .mime import mime_matches, sniff_mime, inspect_zip
from .ocr import DisabledOcrAdapter, OcrAdapter, PageImage
from .tempfiles import job_temp_dir


register_heif_opener()
if register_avif_opener is not None:
    register_avif_opener()

FULL_BBOX = [0.0, 0.0, 1.0, 1.0]
IMAGE_MIME = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "image/avif"}


# A Hebrew word, allowing the quote marks that appear inside abbreviations such as בע"מ but never
# swallowing a quote that belongs to adjacent Latin text.
HEBREW_RUN = re.compile("[֐-׿]+(?:[\"'׳״][֐-׿]+)*")
# ך ם ן ף ץ -- in correct Hebrew these appear only as the last letter of a word. A generator that
# laid the page out in visual order puts them first instead, which is a lexicon-free tell.
HEBREW_FINALS = "ךםןףץ"


def _hebrew_is_reversed(text: str) -> bool:
    """Detects a text layer stored in visual rather than logical order.

    Measured on a real Israeli supplier receipt: 13 Hebrew words began with a final letter and
    none ended with one. The same check over spreadsheet text and over image OCR returned 0 vs
    1701 and 0 vs 75, so the separation is unambiguous in both directions.
    """
    starts = ends = 0
    for word in HEBREW_RUN.findall(text):
        if len(word) < 2:
            continue
        if word[0] in HEBREW_FINALS:
            starts += 1
        if word[-1] in HEBREW_FINALS:
            ends += 1
    return starts > ends


def _reverse_hebrew_runs(text: str) -> str:
    """Restores logical order. Latin text, digits and layout are left untouched."""
    return HEBREW_RUN.sub(lambda match: match.group(0)[::-1], text)


def _languages(text: str) -> list[str]:
    result: list[str] = []
    if re.search(r"[\u0590-\u05ff]", text):
        result.append("he")
    if re.search(r"[A-Za-z]", text):
        result.append("en")
    return result


def _contract(
    page_count: int,
    plain_text: str,
    *,
    blocks: list[dict[str, Any]] | None = None,
    tables: list[dict[str, Any]] | None = None,
    marks: list[dict[str, Any]] | None = None,
    partial: bool = False,
) -> dict[str, Any]:
    return {
        "schema_version": "1",
        "document": {
            "page_count": page_count,
            "detected_languages": _languages(plain_text),
            "plain_text": plain_text,
            "partial": partial,
        },
        "blocks": blocks or [],
        "tables": tables or [],
        "marks": marks or [],
    }


def _text_blocks(parts: list[str], page: int = 1, prefix: str = "text") -> list[dict[str, Any]]:
    return [
        {
            "id": f"{prefix}-p{page}-{index}",
            "page": page,
            "type": "text",
            "bbox": FULL_BBOX.copy(),
            "text": text,
            "confidence": None,
        }
        for index, text in enumerate(parts, start=1)
        if text
    ]


def _cell(value: Any) -> dict[str, Any]:
    if value is None:
        text = ""
    elif isinstance(value, bool):
        text = "TRUE" if value else "FALSE"
    elif isinstance(value, float) and value.is_integer():
        text = str(int(value))
    else:
        text = str(value)
    return {"text": text, "bbox": None}


def _spreadsheet_contract(
    sheets: list[tuple[str, list[list[dict[str, Any]]]]], limits: ExtractionLimits
) -> dict[str, Any]:
    tables: list[dict[str, Any]] = []
    blocks: list[dict[str, Any]] = []
    texts: list[str] = []
    total_rows = 0
    for page, (name, rows) in enumerate(sheets, start=1):
        total_rows += len(rows)
        if total_rows > limits.max_spreadsheet_rows:
            raise ProcessingError("spreadsheet_row_limit", "Spreadsheet row limit exceeded")
        if any(len(row) > limits.max_spreadsheet_columns for row in rows):
            raise ProcessingError(
                "spreadsheet_column_limit", "Spreadsheet column limit exceeded"
            )
        row_text = ["\t".join(cell["text"] for cell in row) for row in rows]
        sheet_text = "\n".join(([name] if name else []) + row_text)
        texts.append(sheet_text)
        tables.append({"id": f"sheet-{page}", "page": page, "bbox": FULL_BBOX.copy(), "rows": rows})
        blocks.append(
            {
                "id": f"sheet-block-{page}",
                "page": page,
                "type": "table",
                "bbox": FULL_BBOX.copy(),
                "text": sheet_text,
                "confidence": None,
            }
        )
    plain_text = "\n\n".join(texts)
    if len(plain_text) > limits.max_text_chars:
        raise ProcessingError("text_length_limit", "Extracted text exceeds the text limit")
    return _contract(max(1, len(sheets)), plain_text, blocks=blocks, tables=tables)


def _parse_xlsx(path: Path, limits: ExtractionLimits) -> dict[str, Any]:
    inspect_zip(path, limits)
    try:
        workbook = openpyxl.load_workbook(path, read_only=True, data_only=True, keep_links=False)
    except Exception as exc:
        raise ProcessingError("corrupt_document", "Spreadsheet is corrupt") from exc
    sheets: list[tuple[str, list[list[dict[str, Any]]]]] = []
    total_rows = 0
    try:
        if len(workbook.worksheets) > limits.max_pdf_pages:
            raise ProcessingError("page_limit", "Spreadsheet contains too many sheets")
        for sheet in workbook.worksheets:
            if (sheet.max_column or 0) > limits.max_spreadsheet_columns:
                raise ProcessingError("spreadsheet_column_limit", "Spreadsheet contains too many columns")
            rows: list[list[dict[str, Any]]] = []
            for values in sheet.iter_rows(values_only=True):
                if len(values) > limits.max_spreadsheet_columns:
                    raise ProcessingError(
                        "spreadsheet_column_limit",
                        "Spreadsheet contains too many columns",
                    )
                if not any(value is not None for value in values):
                    continue
                total_rows += 1
                if total_rows > limits.max_spreadsheet_rows:
                    raise ProcessingError("spreadsheet_row_limit", "Spreadsheet row limit exceeded")
                rows.append([_cell(value) for value in values])
            sheets.append((sheet.title, rows))
    finally:
        workbook.close()
    return _spreadsheet_contract(sheets, limits)


def _parse_xls(path: Path, limits: ExtractionLimits) -> dict[str, Any]:
    try:
        workbook = xlrd.open_workbook(filename=str(path), on_demand=True)
    except (OSError, xlrd.XLRDError) as exc:
        raise ProcessingError("corrupt_document", "Legacy spreadsheet is corrupt") from exc
    sheets: list[tuple[str, list[list[dict[str, Any]]]]] = []
    total_rows = 0
    try:
        if workbook.nsheets > limits.max_pdf_pages:
            raise ProcessingError("page_limit", "Spreadsheet contains too many sheets")
        for sheet in workbook.sheets():
            if sheet.ncols > limits.max_spreadsheet_columns:
                raise ProcessingError("spreadsheet_column_limit", "Spreadsheet contains too many columns")
            rows: list[list[dict[str, Any]]] = []
            for row_index in range(sheet.nrows):
                values = [sheet.cell_value(row_index, column) for column in range(sheet.ncols)]
                if not any(value not in (None, "") for value in values):
                    continue
                total_rows += 1
                if total_rows > limits.max_spreadsheet_rows:
                    raise ProcessingError("spreadsheet_row_limit", "Spreadsheet row limit exceeded")
                rows.append([_cell(value) for value in values])
            sheets.append((sheet.name, rows))
    finally:
        workbook.release_resources()
    return _spreadsheet_contract(sheets, limits)


def _read_utf8(path: Path, limits: ExtractionLimits) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ProcessingError("invalid_utf8", "Text source must be strict UTF-8") from exc
    except OSError as exc:
        raise ProcessingError("source_unavailable", "Source document is unavailable", retryable=True) from exc
    if len(text) > limits.max_text_chars:
        raise ProcessingError("text_length_limit", "Text source exceeds the text limit")
    return text


def _parse_csv(path: Path, limits: ExtractionLimits) -> dict[str, Any]:
    text = _read_utf8(path, limits)
    try:
        dialect = csv.Sniffer().sniff(text[:16_384], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows: list[list[dict[str, Any]]] = []
    try:
        for index, row in enumerate(csv.reader(text.splitlines(), dialect), start=1):
            if index > limits.max_spreadsheet_rows:
                raise ProcessingError("spreadsheet_row_limit", "CSV row limit exceeded")
            if len(row) > limits.max_spreadsheet_columns:
                raise ProcessingError("spreadsheet_column_limit", "CSV contains too many columns")
            rows.append([_cell(value) for value in row])
    except csv.Error as exc:
        raise ProcessingError("corrupt_document", "CSV is malformed") from exc
    return _spreadsheet_contract([("", rows)], limits)


class _DocumentHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ignored = 0
        self.text: list[str] = []
        self.tables: list[list[list[str]]] = []
        self.table: list[list[str]] | None = None
        self.row: list[str] | None = None
        self.cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag in {"script", "style", "noscript"}:
            self.ignored += 1
        elif not self.ignored and tag == "table":
            self.table = []
        elif not self.ignored and tag == "tr" and self.table is not None:
            self.row = []
        elif not self.ignored and tag in {"td", "th"} and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self.ignored:
            self.ignored -= 1
        elif tag in {"td", "th"} and self.cell is not None and self.row is not None:
            self.row.append(" ".join(self.cell).strip())
            self.cell = None
        elif tag == "tr" and self.row is not None and self.table is not None:
            self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            self.tables.append(self.table)
            self.table = None

    def handle_data(self, data: str) -> None:
        if self.ignored:
            return
        text = " ".join(data.split())
        if not text:
            return
        self.text.append(text)
        if self.cell is not None:
            self.cell.append(text)


def _parse_html(path: Path, limits: ExtractionLimits) -> dict[str, Any]:
    text = _read_utf8(path, limits)
    parser = _DocumentHtmlParser()
    try:
        parser.feed(text)
        parser.close()
    except Exception as exc:
        raise ProcessingError("corrupt_document", "HTML is malformed") from exc
    plain_text = "\n".join(parser.text)
    tables: list[dict[str, Any]] = []
    total_rows = 0
    for index, raw_rows in enumerate(parser.tables, start=1):
        total_rows += len(raw_rows)
        if total_rows > limits.max_spreadsheet_rows:
            raise ProcessingError("spreadsheet_row_limit", "HTML table row limit exceeded")
        if any(len(row) > limits.max_spreadsheet_columns for row in raw_rows):
            raise ProcessingError(
                "spreadsheet_column_limit", "HTML table contains too many columns"
            )
        tables.append(
            {
                "id": f"html-table-{index}",
                "page": 1,
                "bbox": FULL_BBOX.copy(),
                "rows": [[_cell(value) for value in row] for row in raw_rows],
            }
        )
    return _contract(1, plain_text, blocks=_text_blocks(parser.text, prefix="html"), tables=tables, partial=True)


def _parse_docx(path: Path, limits: ExtractionLimits) -> dict[str, Any]:
    inspect_zip(path, limits)
    try:
        with zipfile.ZipFile(path) as archive, archive.open("word/document.xml") as document_xml:
            root = SafeET.parse(document_xml).getroot()
    except (OSError, KeyError, zipfile.BadZipFile, SafeET.ParseError) as exc:
        raise ProcessingError("corrupt_document", "Word document is corrupt") from exc
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    body = root.find(f"{namespace}body")
    if body is None:
        raise ProcessingError("corrupt_document", "Word document body is missing")
    paragraphs: list[str] = []
    tables: list[dict[str, Any]] = []
    total_rows = 0
    for child in body:
        if child.tag == f"{namespace}p":
            text = "".join(node.text or "" for node in child.iter(f"{namespace}t")).strip()
            if text:
                paragraphs.append(text)
        elif child.tag == f"{namespace}tbl":
            rows: list[list[dict[str, Any]]] = []
            for row in child.findall(f"{namespace}tr"):
                total_rows += 1
                if total_rows > limits.max_spreadsheet_rows:
                    raise ProcessingError("spreadsheet_row_limit", "Word table row limit exceeded")
                raw_cells = row.findall(f"{namespace}tc")
                if len(raw_cells) > limits.max_spreadsheet_columns:
                    raise ProcessingError(
                        "spreadsheet_column_limit", "Word table contains too many columns"
                    )
                cells = []
                for cell in raw_cells:
                    cells.append(_cell("".join(node.text or "" for node in cell.iter(f"{namespace}t")).strip()))
                rows.append(cells)
            tables.append(
                {"id": f"docx-table-{len(tables) + 1}", "page": 1, "bbox": FULL_BBOX.copy(), "rows": rows}
            )
    table_text = ["\n".join("\t".join(cell["text"] for cell in row) for row in table["rows"]) for table in tables]
    plain_text = "\n\n".join(paragraphs + table_text)
    if len(plain_text) > limits.max_text_chars:
        raise ProcessingError("text_length_limit", "Extracted text exceeds the text limit")
    return _contract(1, plain_text, blocks=_text_blocks(paragraphs, prefix="docx"), tables=tables, partial=True)


def _convert_to_docx(path: Path, limits: ExtractionLimits, source_suffix: str) -> Path:
    with job_temp_dir(path.parent) as conversion:
        profile = conversion / "profile"
        profile_user = profile / "user"
        profile_user.mkdir(parents=True)
        (profile_user / "registrymodifications.xcu").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
            '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
            '</item></oor:items>',
            encoding="utf-8",
        )
        output = conversion / "output"
        output.mkdir()
        typed_source = conversion / f"source{source_suffix}"
        shutil.copyfile(path, typed_source)
        env = os.environ.copy()
        env.update(
            {
                "TMPDIR": str(conversion),
                "XDG_CACHE_HOME": str(conversion / "cache"),
                "XDG_CONFIG_HOME": str(conversion / "config"),
                "SAL_USE_VCLPLUGIN": "svp",
            }
        )
        command = [
            "libreoffice",
            "--headless",
            "--nologo",
            "--nodefault",
            "--nolockcheck",
            "--norestore",
            "--nofirststartwizard",
            f"-env:UserInstallation={profile.as_uri()}",
            "--convert-to",
            "docx",
            "--outdir",
            str(output),
            str(typed_source),
        ]
        try:
            result = subprocess.run(command, capture_output=True, check=False, timeout=limits.tool_timeout_seconds, env=env)
        except subprocess.TimeoutExpired as exc:
            raise ProcessingError("office_conversion_timeout", "Office conversion exceeded its time limit") from exc
        except OSError as exc:
            raise ProcessingError("office_runtime_unavailable", "Office conversion runtime is unavailable") from exc
        files = list(output.glob("*.docx"))
        if result.returncode != 0 or len(files) != 1:
            raise ProcessingError("office_conversion_failed", "Office conversion failed")
        if files[0].stat().st_size > limits.max_file_bytes:
            raise ProcessingError("file_size_limit", "Converted document exceeds the file size limit")
        converted = path.parent / "converted.docx"
        shutil.copyfile(files[0], converted)
        return converted


def _normalize_image_pages(path: Path, limits: ExtractionLimits) -> list[PageImage]:
    Image.MAX_IMAGE_PIXELS = limits.max_image_pixels
    pages: list[PageImage] = []
    total_bytes = 0
    try:
        with Image.open(path) as image:
            for page_number, frame in enumerate(ImageSequence.Iterator(image), start=1):
                if page_number > limits.max_pdf_pages:
                    raise ProcessingError("page_limit", "Image contains too many frames")
                width, height = frame.size
                pixels = width * height
                total_bytes += pixels * 3
                if pixels > limits.max_image_pixels or total_bytes > limits.max_decompressed_bytes:
                    raise ProcessingError("decompressed_size_limit", "Decoded image exceeds its safety limit")
                normalized = ImageOps.exif_transpose(frame.copy()).convert("RGB")
                width, height = normalized.size
                output = path.parent / f"image-page-{page_number}.png"
                normalized.save(output, format="PNG", optimize=False)
                pages.append(PageImage(page_number, output, width, height))
    except ProcessingError:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ProcessingError("corrupt_document", "Image is corrupt or unsupported") from exc
    return pages


def _render_pdf_page(path: Path, page: int, limits: ExtractionLimits) -> PageImage:
    prefix = path.parent / f"pdf-page-{page}"
    try:
        subprocess.run(
            [
                "pdftoppm",
                "-f",
                str(page),
                "-l",
                str(page),
                "-singlefile",
                "-r",
                "200",
                "-scale-to",
                "4096",
                "-png",
                str(path),
                str(prefix),
            ],
            capture_output=True,
            check=True,
            timeout=limits.tool_timeout_seconds,
        )
    except subprocess.TimeoutExpired as exc:
        raise ProcessingError("pdf_render_timeout", "PDF rendering exceeded its time limit", retryable=True) from exc
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ProcessingError("pdf_render_failed", "PDF page rendering failed") from exc
    output = prefix.with_suffix(".png")
    try:
        with Image.open(output) as image:
            width, height = image.size
    except (OSError, UnidentifiedImageError) as exc:
        raise ProcessingError("pdf_render_failed", "Rendered PDF page is invalid") from exc
    if width * height > limits.max_image_pixels:
        raise ProcessingError("decompressed_size_limit", "Rendered PDF page exceeds its safety limit")
    return PageImage(page, output, width, height)


def _parse_pdf(path: Path, adapter: OcrAdapter, limits: ExtractionLimits) -> dict[str, Any]:
    try:
        reader = PdfReader(path, strict=True)
    except (OSError, PdfReadError, ValueError) as exc:
        raise ProcessingError("corrupt_document", "PDF is corrupt") from exc
    if reader.is_encrypted:
        raise ProcessingError("encrypted_document", "Encrypted documents are not supported")
    page_count = len(reader.pages)
    if not 1 <= page_count <= limits.max_pdf_pages:
        raise ProcessingError("page_limit", "PDF page count is outside the allowed range")
    native_text: dict[int, str] = {}
    missing: list[int] = []
    blocks: list[dict[str, Any]] = []
    total_chars = 0
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            text = ""
        total_chars += len(text)
        if total_chars > limits.max_text_chars:
            raise ProcessingError("text_length_limit", "Extracted text exceeds the text limit")
        native_text[page_number] = text
        if not text:
            missing.append(page_number)

    # Decided once for the whole document: a single page may not contain enough final letters to
    # judge, and a per-page decision could repair some pages and not others.
    if _hebrew_is_reversed("\n".join(native_text.values())):
        native_text = {page: _reverse_hebrew_runs(text) for page, text in native_text.items()}

    for page_number in sorted(native_text):
        if native_text[page_number]:
            blocks.extend(_text_blocks([native_text[page_number]], page_number, "pdf"))

    ocr_payloads: list[dict[str, Any]] = []
    if missing and not isinstance(adapter, DisabledOcrAdapter):
        # Cap the paid path before rendering, so an oversized scan costs neither renders nor calls.
        ocr_pages = missing[: limits.max_ai_pages]
        # The adapter sees one memory-bounded batch at a time, so only here is the document's OCR
        # page count known. Without this the progress counter reported the batch size and restarted
        # at every flush.
        begin_progress = getattr(adapter, "begin_progress", None)
        if callable(begin_progress):
            begin_progress(len(ocr_pages))
        rendered: list[PageImage] = []
        decoded_bytes = 0

        def flush_rendered() -> None:
            nonlocal decoded_bytes
            if not rendered:
                return
            try:
                ocr_payloads.append(validate_extraction(adapter.extract(rendered, limits), limits))
            finally:
                for rendered_page in rendered:
                    rendered_page.path.unlink(missing_ok=True)
                rendered.clear()
                decoded_bytes = 0

        try:
            for page in ocr_pages:
                rendered_page = _render_pdf_page(path, page, limits)
                page_bytes = rendered_page.width * rendered_page.height * 3
                if page_bytes > limits.max_decompressed_bytes:
                    rendered_page.path.unlink(missing_ok=True)
                    raise ProcessingError(
                        "decompressed_size_limit", "Rendered PDF page exceeds its safety limit"
                    )
                if rendered and decoded_bytes + page_bytes > limits.max_decompressed_bytes:
                    flush_rendered()
                rendered.append(rendered_page)
                decoded_bytes += page_bytes
            flush_rendered()
        finally:
            for rendered_page in rendered:
                rendered_page.path.unlink(missing_ok=True)

        for payload in ocr_payloads:
            blocks.extend(payload["blocks"])
    elif missing and len(missing) == page_count:
        raise ProcessingError("ocr_model_not_selected", "Scanned PDF requires a benchmark-approved OCR model")

    ocr_page_text: dict[int, list[str]] = {}
    if ocr_payloads:
        for payload in ocr_payloads:
            for block in payload["blocks"]:
                if block["text"]:
                    ocr_page_text.setdefault(block["page"], []).append(block["text"])
    page_text = [native_text[page] or "\n".join(ocr_page_text.get(page, [])) for page in range(1, page_count + 1)]
    plain_text = "\n\n".join(page_text)
    return _contract(
        page_count,
        plain_text,
        blocks=blocks,
        tables=[table for payload in ocr_payloads for table in payload["tables"]],
        marks=[mark for payload in ocr_payloads for mark in payload["marks"]],
        partial=True,
    )


def _parse_image(path: Path, adapter: OcrAdapter, limits: ExtractionLimits) -> dict[str, Any]:
    pages = _normalize_image_pages(path, limits)
    payload = validate_extraction(adapter.extract(pages, limits), limits)
    if payload["document"]["page_count"] != len(pages):
        raise ProcessingError("invalid_extraction", "OCR page count does not match the source")
    return payload


def extract_file(
    path: str | Path,
    claimed_mime: str | None,
    *,
    adapter: OcrAdapter | None = None,
    limits: ExtractionLimits = DEFAULT_LIMITS,
) -> dict[str, Any]:
    source = Path(path).resolve()
    detected = sniff_mime(source, claimed_mime, limits)
    if detected not in IMAGE_MIME | {
        "application/pdf",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/rtf",
        "text/rtf",
        "text/plain",
        "text/html",
        "application/vnd.oasis.opendocument.text",
    }:
        raise ProcessingError("unsupported_mime", "Source type is not supported")
    if not mime_matches(detected, claimed_mime):
        raise ProcessingError("mime_mismatch", "Source bytes do not match the declared MIME type")
    ocr = adapter or DisabledOcrAdapter()

    if detected in IMAGE_MIME:
        payload = _parse_image(source, ocr, limits)
    elif detected == "application/pdf":
        payload = _parse_pdf(source, ocr, limits)
    elif detected == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        payload = _parse_xlsx(source, limits)
    elif detected == "application/vnd.ms-excel":
        payload = _parse_xls(source, limits)
    elif detected == "text/csv":
        payload = _parse_csv(source, limits)
    elif detected == "text/plain":
        text = _read_utf8(source, limits)
        payload = _contract(1, text, blocks=_text_blocks([text]))
    elif detected == "text/html":
        payload = _parse_html(source, limits)
    elif detected == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        payload = _parse_docx(source, limits)
    elif detected in {"application/msword", "application/rtf", "text/rtf", "application/vnd.oasis.opendocument.text"}:
        suffix = {
            "application/msword": ".doc",
            "application/rtf": ".rtf",
            "text/rtf": ".rtf",
            "application/vnd.oasis.opendocument.text": ".odt",
        }[detected]
        payload = _parse_docx(_convert_to_docx(source, limits, suffix), limits)
    else:
        raise ProcessingError("unsupported_mime", "Source type is not supported")
    return validate_extraction(payload, limits)
