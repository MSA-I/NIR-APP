from __future__ import annotations

import csv
import re
import zipfile
from pathlib import Path, PurePosixPath

import olefile

from .errors import ProcessingError
from .limits import DEFAULT_LIMITS, ExtractionLimits


ALLOWED_MIME = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
    "image/gif",
    "image/avif",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/rtf",
    "text/rtf",
    "text/plain",
    # text/html is kept here on purpose and is UNREACHABLE FROM AN UPLOAD from migration 0288
    # (OPEN-DECISIONS #346). The database and both client pickers refuse the type, so nothing the
    # gateway leases declares it; this set is the worker's own contract with its callers, and
    # narrowing it would only break the self-check that still parses HTML directly.
    "text/html",
    "application/vnd.oasis.opendocument.text",
}


def inspect_zip(path: str | Path, limits: ExtractionLimits = DEFAULT_LIMITS) -> set[str]:
    total = 0
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > limits.max_archive_entries:
                raise ProcessingError("archive_entry_limit", "Archive contains too many entries")
            names: set[str] = set()
            for entry in entries:
                normalized = PurePosixPath(entry.filename.replace("\\", "/"))
                if normalized.is_absolute() or ".." in normalized.parts:
                    raise ProcessingError("unsafe_archive_path", "Archive contains an unsafe path")
                if entry.flag_bits & 0x1:
                    raise ProcessingError("encrypted_document", "Encrypted documents are not supported")
                total += entry.file_size
                if total > limits.max_decompressed_bytes:
                    raise ProcessingError("decompressed_size_limit", "Decompressed size limit exceeded")
                if entry.compress_size and entry.file_size / entry.compress_size > 1_000:
                    raise ProcessingError("archive_ratio_limit", "Archive compression ratio is unsafe")
                names.add(entry.filename)
            return names
    except ProcessingError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise ProcessingError("corrupt_document", "Archive is corrupt") from exc


def _zip_mime(path: Path, limits: ExtractionLimits) -> str:
    names = inspect_zip(path, limits)
    if "xl/workbook.xml" in names and "[Content_Types].xml" in names:
        return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if "word/document.xml" in names and "[Content_Types].xml" in names:
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if "mimetype" in names and "content.xml" in names:
        try:
            with zipfile.ZipFile(path) as archive:
                with archive.open("mimetype") as handle:
                    mimetype = handle.read(256).decode("ascii", "strict")
        except (OSError, UnicodeError, KeyError, zipfile.BadZipFile) as exc:
            raise ProcessingError("corrupt_document", "OpenDocument container is corrupt") from exc
        if mimetype == "application/vnd.oasis.opendocument.text":
            return mimetype
    raise ProcessingError("unsupported_mime", "ZIP container type is not supported")


def _ole_mime(path: Path) -> str:
    try:
        with olefile.OleFileIO(path) as container:
            streams = {"/".join(parts) for parts in container.listdir(streams=True, storages=False)}
    except (OSError, IOError) as exc:
        raise ProcessingError("corrupt_document", "Legacy Office container is corrupt") from exc
    if "Workbook" in streams or "Book" in streams:
        return "application/vnd.ms-excel"
    if "WordDocument" in streams:
        return "application/msword"
    raise ProcessingError("unsupported_mime", "Legacy Office container type is not supported")


def _text_mime(text: str, path: Path, claimed_mime: str | None) -> str:
    sample = text[:16_384]
    if re.search(r"<!doctype\s+html|<html(?:\s|>)|<body(?:\s|>)|<table(?:\s|>)", sample, re.I):
        return "text/html"
    if claimed_mime == "text/csv" or path.suffix.lower() == ".csv":
        return "text/csv"
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
        rows = list(csv.reader(sample.splitlines()[:5], dialect))
        if rows and max(map(len, rows)) > 1:
            return "text/csv"
    except csv.Error:
        pass
    return "text/plain"


def sniff_mime(
    path: str | Path,
    claimed_mime: str | None = None,
    limits: ExtractionLimits = DEFAULT_LIMITS,
) -> str:
    source = Path(path)
    try:
        size = source.stat().st_size
        if size < 1:
            raise ProcessingError("empty_document", "Source document is empty")
        if size > limits.max_file_bytes:
            raise ProcessingError("file_size_limit", "Source document exceeds the file size limit")
        with source.open("rb") as handle:
            head = handle.read(16_384)
    except ProcessingError:
        raise
    except OSError as exc:
        raise ProcessingError("source_unavailable", "Source document is unavailable", retryable=True) from exc

    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if head.startswith(b"RIFF") and head[8:12] == b"WEBP":
        return "image/webp"
    if len(head) >= 12 and head[4:8] == b"ftyp":
        major_brand = head[8:12]
        compatible_brands = {
            head[index : index + 4] for index in range(16, min(len(head), 64), 4)
        }
        if major_brand in {b"avif", b"avis"}:
            return "image/avif"
        if major_brand in {b"heic", b"heix", b"hevc", b"hevx"}:
            return "image/heic"
        if major_brand in {b"mif1", b"msf1"}:
            return "image/heif"
        if compatible_brands & {b"avif", b"avis"}:
            return "image/avif"
        if compatible_brands & {b"heic", b"heix", b"hevc", b"hevx"}:
            return "image/heic"
    if head.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
        return _zip_mime(source, limits)
    if head.startswith(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"):
        return _ole_mime(source)
    if head.lstrip().startswith(b"{\\rtf"):
        return "application/rtf"
    if b"\x00" in head:
        raise ProcessingError("unsupported_mime", "Binary source type is not supported")
    try:
        text = source.read_text(encoding="utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ProcessingError("invalid_utf8", "Text source must be strict UTF-8") from exc
    except OSError as exc:
        raise ProcessingError("source_unavailable", "Source document is unavailable", retryable=True) from exc
    return _text_mime(text, source, claimed_mime)


def mime_matches(detected: str, claimed: str | None) -> bool:
    if claimed is None:
        return True
    if detected == claimed:
        return True
    return {detected, claimed} <= {"application/rtf", "text/rtf"} or {
        detected,
        claimed,
    } <= {"image/heic", "image/heif"}
