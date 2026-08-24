from __future__ import annotations

import hashlib
import tempfile
import threading
import unittest
import zipfile
import zlib
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image

from src import parsers
from src.contract import validate_extraction
from src.errors import ProcessingError
from src.limits import DEFAULT_LIMITS, ExtractionLimits
from src.ocr import PageImage
from src.parsers import extract_file
from src.scanning import (
    HEIF_SOURCE_FORMATS,
    SEVERE_SHADOW_SCORE,
    SOURCE_FORMATS,
    UNKNOWN_SOURCE_FORMAT,
    _normalize_source_format,
    _select_mode,
    detect_document_corners,
    scan_document,
    validate_corners,
)
from src.worker import WorkerConfig, _run_scan


def _write_document(path: Path, *, shadow: bool = True) -> None:
    canvas = np.full((900, 1200, 3), (58, 69, 78), dtype=np.uint8)
    page = np.full((650, 850, 3), 245, dtype=np.uint8)
    if shadow:
        gradient = np.tile(np.linspace(0.68, 1.0, page.shape[1]), (page.shape[0], 1))
        page = np.clip(page.astype(np.float32) * gradient[:, :, None], 0, 255).astype(np.uint8)
    cv2.putText(page, "INVOICE 2026", (80, 110), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (15, 15, 15), 4)
    for index in range(8):
        y = 190 + index * 48
        cv2.line(page, (80, y), (760, y), (30, 30, 30), 3)
    source = np.float32([[0, 0], [849, 0], [849, 649], [0, 649]])
    target = np.float32([[170, 100], [1060, 155], [995, 790], [115, 735]])
    matrix = cv2.getPerspectiveTransform(source, target)
    warped = cv2.warpPerspective(page, matrix, (1200, 900), borderValue=(58, 69, 78))
    mask = cv2.warpPerspective(np.full((650, 850), 255, dtype=np.uint8), matrix, (1200, 900))
    canvas[mask > 0] = warped[mask > 0]
    cv2.imwrite(str(path), canvas)


def _write_full_frame_page(path: Path) -> None:
    """A page that fills the frame: no desk, no paper edge, nothing to trace a rectangle around."""
    canvas = np.full((1100, 850, 3), 244, dtype=np.uint8)
    cv2.putText(canvas, "SUPPLIER LTD", (60, 90), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (20, 20, 20), 3)
    for y in range(180, 1020, 45):
        cv2.line(canvas, (55, y), (795, y), (35, 35, 35), 3)
    cv2.imwrite(str(path), canvas)


def _write_heif_page(path: Path) -> None:
    canvas = np.full((1100, 850, 3), 244, dtype=np.uint8)
    cv2.putText(canvas, "IPHONE HEIC", (70, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (15, 15, 15), 3)
    for y in range(180, 1020, 48):
        cv2.line(canvas, (60, y), (790, y), (35, 35, 35), 3)
    Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)).save(path, format="HEIF", quality=90)


def _write_multi_picture_jpeg(path: Path) -> None:
    """A multi-picture JPEG -- what an iPhone/Android HDR or Live capture actually is.

    Two JPEG pictures in one container with an MPF index; the mime type is image/jpeg, which the
    upload gate already accepts, and Pillow labels the container MPO rather than JPEG.
    """
    canvas = np.full((1100, 850, 3), 244, dtype=np.uint8)
    cv2.putText(canvas, "IPHONE HDR", (70, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (15, 15, 15), 3)
    for y in range(180, 1020, 48):
        cv2.line(canvas, (60, y), (790, y), (35, 35, 35), 3)
    primary = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB))
    secondary = Image.fromarray(cv2.cvtColor((canvas * 0.5).astype(np.uint8), cv2.COLOR_BGR2RGB))
    primary.save(path, format="MPO", save_all=True, append_images=[secondary], quality=90)


def _write_small_off_centre_panel(path: Path) -> None:
    """A small document lying on a large dark surface: most of the frame is not the document."""
    canvas = np.full((1400, 1800, 3), 70, dtype=np.uint8)
    panel = np.full((300, 240, 3), 243, dtype=np.uint8)
    for y in range(40, 270, 26):
        cv2.line(panel, (20, y), (220, y), (30, 30, 30), 2)
    canvas[120:420, 180:420] = panel
    cv2.imwrite(str(path), canvas)


class ScanModeSelectionTests(unittest.TestCase):
    """`auto` hands OCR grayscale unless the page is still shadow-dominated after correction.

    Binarization is the only destructive step in the scan chain and nothing measures whether it
    helped, so the corpus evidence decides the default rather than the other way round.
    """

    @staticmethod
    def _metrics(**overrides: float) -> dict[str, float]:
        metrics = {"shadow": 0.17, "ink_ratio": 0.05, "contrast": 0.14, "sharpness": 1.0}
        metrics.update(overrides)
        return metrics

    def test_auto_prefers_grayscale_across_the_measured_corpus_range(self) -> None:
        # Every one of the 17 measured documents landed inside these bounds: shadow 0.049-0.266,
        # ink 0.026-0.125, contrast 0.061-0.190. Under the previous heuristic all of them
        # binarized unless the small-text guard intervened.
        for shadow in (0.0494, 0.1149, 0.1767, 0.2479, 0.2658):
            for ink_ratio in (0.0259, 0.0500, 0.1246):
                with self.subTest(shadow=shadow, ink_ratio=ink_ratio):
                    mode = _select_mode(
                        "auto",
                        self._metrics(shadow=shadow, ink_ratio=ink_ratio),
                        preserve_small_text=False,
                    )
                    self.assertEqual(mode, "grayscale")

    def test_auto_still_binarizes_a_page_beyond_every_measured_shadow(self) -> None:
        mode = _select_mode(
            "auto",
            self._metrics(shadow=SEVERE_SHADOW_SCORE + 0.01),
            preserve_small_text=False,
        )
        self.assertEqual(mode, "black_and_white")

    def test_severe_shadow_alone_is_not_enough_without_usable_ink(self) -> None:
        for ink_ratio in (0.001, 0.9):
            with self.subTest(ink_ratio=ink_ratio):
                mode = _select_mode(
                    "auto",
                    self._metrics(shadow=0.4, ink_ratio=ink_ratio),
                    preserve_small_text=False,
                )
                self.assertEqual(mode, "grayscale")

    def test_explicit_modes_are_never_overridden(self) -> None:
        severe = self._metrics(shadow=0.4)
        calm = self._metrics(shadow=0.01)
        self.assertEqual(
            _select_mode("black_and_white", calm, preserve_small_text=True), "black_and_white"
        )
        self.assertEqual(_select_mode("grayscale", severe, preserve_small_text=False), "grayscale")


class DocumentScanningTests(unittest.TestCase):
    def test_detects_rectifies_enhances_and_preserves_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jpg"
            output = root / "scan.png"
            _write_document(source)
            original = source.read_bytes()

            result = scan_document(source, output)

            self.assertEqual(source.read_bytes(), original)
            self.assertTrue(output.is_file())
            self.assertEqual(result.corners_source, "automatic")
            self.assertIn(result.output_mode, {"grayscale", "black_and_white"})
            self.assertGreater(result.width, 700)
            self.assertGreater(result.height, 500)
            self.assertEqual(len(result.output_sha256), 64)
            self.assertGreater(result.metrics["shadow"], 0.02)
            with Image.open(output) as scanned:
                self.assertEqual(scanned.mode, "L")
                self.assertEqual(scanned.size, (result.width, result.height))

    def test_manual_corners_are_normalized_and_used(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jpg"
            output = root / "scan.png"
            _write_document(source, shadow=False)
            corners = [[0.14, 0.11], [0.88, 0.17], [0.83, 0.88], [0.10, 0.82]]

            result = scan_document(source, output, corners=corners, mode="black_and_white")

            self.assertEqual(result.corners_source, "manual")
            self.assertEqual(result.output_mode, "black_and_white")
            pixels = cv2.imread(str(output), cv2.IMREAD_GRAYSCALE)
            self.assertTrue(set(np.unique(pixels)).issubset({0, 255}))

    def test_blank_image_requires_manual_corners(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "blank.png"
            Image.new("RGB", (800, 600), "white").save(source)
            with self.assertRaisesRegex(ProcessingError, "manual corner selection") as context:
                scan_document(source, root / "scan.png")
            self.assertEqual(context.exception.code, "document_not_detected")

    def test_rejects_a_prominent_inner_panel_as_the_page(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "inner-panel.png"
            canvas = np.full((1200, 900, 3), 246, dtype=np.uint8)
            cv2.rectangle(canvas, (80, 710), (820, 1080), (25, 25, 25), 8)
            for y in range(780, 1020, 55):
                cv2.line(canvas, (150, y), (750, y), (35, 35, 35), 5)
            cv2.imwrite(str(source), canvas)

            with self.assertRaises(ProcessingError) as context:
                scan_document(source, root / "scan.png")

            self.assertEqual(context.exception.code, "document_not_detected")

    def test_flat_low_resolution_invoice_preserves_header_and_full_frame(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "flat-invoice.jpg"
            output = root / "scan.png"
            canvas = np.full((817, 593, 3), 246, dtype=np.uint8)
            cv2.putText(
                canvas,
                "SUPPLIER VAT 514389568",
                (35, 70),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.65,
                (20, 20, 20),
                2,
            )
            cv2.putText(
                canvas,
                "INVOICE SI266001312",
                (35, 120),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.65,
                (20, 20, 20),
                2,
            )
            cv2.rectangle(canvas, (12, 275), (580, 760), (25, 25, 25), 5)
            for y in range(320, 730, 42):
                cv2.line(canvas, (20, y), (572, y), (35, 35, 35), 3)
            cv2.imwrite(str(source), canvas)

            result = scan_document(source, output)

            self.assertEqual(result.corners_source, "full_frame_fallback")
            self.assertEqual(
                result.corners,
                ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)),
            )
            self.assertEqual(result.output_mode, "grayscale")
            self.assertEqual((result.width, result.height), (593, 817))
            pixels = cv2.imread(str(output), cv2.IMREAD_GRAYSCALE)
            self.assertLess(int(pixels[:150].min()), 80)

    def test_shadowed_photograph_scans_to_grayscale_and_keeps_its_tones(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.jpg"
            output = root / "scan.png"
            _write_document(source)

            result = scan_document(source, output)

            self.assertEqual(result.output_mode, "grayscale")
            self.assertGreaterEqual(result.metrics["shadow"], 0.02)
            self.assertLess(result.metrics["shadow"], SEVERE_SHADOW_SCORE)
            pixels = cv2.imread(str(output), cv2.IMREAD_GRAYSCALE)
            # The whole point of the default: intermediate tones survive to the OCR provider.
            self.assertGreater(len(np.unique(pixels)), 2)

    def test_scan_metrics_record_unsaturated_capture_quality(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sharp_source = root / "sharp.png"
            blurred_source = root / "blurred.png"
            _write_full_frame_page(sharp_source)
            sharp_pixels = cv2.imread(str(sharp_source))
            cv2.imwrite(str(blurred_source), cv2.GaussianBlur(sharp_pixels, (21, 21), 0))
            corners = [[0, 0], [1, 0], [1, 1], [0, 1]]

            sharp = scan_document(sharp_source, root / "sharp-scan.png", corners=corners)
            blurred = scan_document(blurred_source, root / "blurred-scan.png", corners=corners)

            for result in (sharp, blurred):
                self.assertIn("raw_laplacian_variance", result.metrics)
                self.assertIn("raw_luma_mean", result.metrics)
            # `sharpness` cannot tell these two apart at the top of its range -- it is
            # min(1.0, variance / 1500) computed after CLAHE. The raw variance can.
            self.assertEqual(sharp.metrics["sharpness"], 1.0)
            self.assertGreater(sharp.metrics["raw_laplacian_variance"], 1500.0)
            self.assertLess(
                blurred.metrics["raw_laplacian_variance"],
                sharp.metrics["raw_laplacian_variance"] / 5,
            )
            self.assertGreater(sharp.metrics["raw_luma_mean"], 100.0)

    def test_full_frame_page_without_a_border_is_detected_automatically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "full-frame.png"
            output = root / "scan.png"
            _write_full_frame_page(source)

            result = scan_document(source, output)

            self.assertEqual(result.corners_source, "full_frame_fallback")
            self.assertEqual(
                result.corners, ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
            )
            self.assertTrue(output.is_file())

    def test_heif_derivative_preserves_original_and_records_decoder_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "iphone.heic"
            output = root / "scan.png"
            _write_heif_page(source)
            original = source.read_bytes()

            result = scan_document(
                source, output, corners=[[0, 0], [1, 0], [1, 1], [0, 1]]
            )

            self.assertEqual(source.read_bytes(), original)
            provenance = result.metadata()["provenance"]
            self.assertEqual(provenance["source_sha256"], hashlib.sha256(original).hexdigest())
            self.assertEqual(provenance["source_bytes"], len(original))
            self.assertEqual(provenance["source_format"], "HEIF")
            self.assertEqual(provenance["decoder"], "pillow-heif")
            self.assertRegex(provenance["decoder_version"], r"^\d+\.\d+")
            self.assertEqual(provenance["decoded_bytes"], 850 * 1100 * 3)

    def test_multi_picture_jpeg_reports_a_source_format_the_contract_accepts(self) -> None:
        """An iPhone HDR capture is image/jpeg to upload and MPO to Pillow.

        Before the allowlist carried MPO the derivative of this perfectly legal photograph was
        refused by the Edge with invalid_request and the scan job failed on an image that had
        decoded correctly. This pins the label the worker actually emits for it.
        """
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "IMG_0042.jpg"
            _write_multi_picture_jpeg(source)
            original = source.read_bytes()

            result = scan_document(
                source, root / "scan.png", corners=[[0, 0], [1, 0], [1, 1], [0, 1]]
            )

            self.assertEqual(source.read_bytes(), original)
            provenance = result.metadata()["provenance"]
            self.assertEqual(provenance["source_format"], "MPO")
            self.assertIn(provenance["source_format"], SOURCE_FORMATS)
            self.assertEqual(provenance["decoder"], "pillow")

    def test_every_source_format_the_worker_emits_is_one_the_contract_names(self) -> None:
        """The Edge and 0179 hold closed sets, so this mapping has to be total.

        Mirrored in `supabase/functions/document-preprocessing/contract.ts`
        (`SCAN_SOURCE_FORMATS`) and in migration 0179's `source_format` check.
        """
        allowed = SOURCE_FORMATS | {UNKNOWN_SOURCE_FORMAT}
        for detected in ["MPO", "JPEG2000", "PPM", "JPEG", "HEIF", "jpeg", " png "]:
            self.assertIn(_normalize_source_format(detected), allowed)
        for detected in [None, "", "PSD", "ICNS", "DDS", "SOMETHING NEW"]:
            self.assertEqual(_normalize_source_format(detected), UNKNOWN_SOURCE_FORMAT)
        self.assertEqual(_normalize_source_format("MPO"), "MPO")
        # The decoder pairing the Edge and 0179 enforce is derived from the same detected label,
        # so the three pillow-heif containers must survive normalization unchanged -- otherwise a
        # HEIC would arrive as UNKNOWN with decoder pillow-heif and be refused.
        self.assertTrue(HEIF_SOURCE_FORMATS <= SOURCE_FORMATS)
        for detected in HEIF_SOURCE_FORMATS:
            self.assertEqual(_normalize_source_format(detected), detected)

    def test_image_decode_obeys_the_decompressed_byte_limit_before_rgb_allocation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "large-decoded.png"
            Image.new("RGB", (200, 200), "white").save(source)

            with self.assertRaises(ProcessingError) as caught:
                scan_document(
                    source,
                    root / "scan.png",
                    corners=[[0, 0], [1, 0], [1, 1], [0, 1]],
                    limits=ExtractionLimits(max_decompressed_bytes=1000),
                )

            self.assertEqual(caught.exception.code, "decompressed_size_limit")

    def test_small_off_centre_panel_still_requires_manual_corners(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "small-panel.png"
            _write_small_off_centre_panel(source)

            with self.assertRaises(ProcessingError) as context:
                scan_document(source, root / "scan.png")

            self.assertEqual(context.exception.code, "document_not_detected")
            # And the reason is the guard, not an accident of this fixture: the detector really
            # does find no page-sized quadrilateral here either.
            with self.assertRaises(ProcessingError):
                detect_document_corners(cv2.imread(str(source)))

    def test_rejects_invalid_manual_corners(self) -> None:
        for corners in (
            [[0, 0], [1, 0], [1, 1]],
            [[0, 0], [2, 0], [1, 1], [0, 1]],
            [[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4]],
        ):
            with self.subTest(corners=corners):
                with self.assertRaises(ProcessingError):
                    validate_corners(corners)

    def test_corrects_small_residual_skew(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "skewed.png"
            output = root / "scan.png"
            page = np.full((700, 1000), 245, dtype=np.uint8)
            for y in range(140, 600, 60):
                cv2.line(page, (100, y), (900, y), 25, 4)
            matrix = cv2.getRotationMatrix2D((500, 350), 3.0, 1.0)
            rotated = cv2.warpAffine(page, matrix, (1000, 700), borderValue=245)
            cv2.imwrite(str(source), rotated)

            result = scan_document(
                source,
                output,
                corners=[[0, 0], [1, 0], [1, 1], [0, 1]],
                mode="grayscale",
            )

            self.assertGreater(abs(result.rotation_degrees), 2.0)
            self.assertLess(abs(result.rotation_degrees), 4.0)

    def test_near_full_phone_scan_stays_within_worker_memory_limit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            small = root / "small.jpg"
            source = root / "phone.jpg"
            output = root / "scan.png"
            _write_document(small)
            with Image.open(small) as image:
                exif = Image.Exif()
                exif[274] = 6
                image.resize((4032, 3024), Image.Resampling.LANCZOS).save(
                    source,
                    format="JPEG",
                    quality=90,
                    exif=exif,
                )
            config = WorkerConfig(
                supabase_url="https://example.test",
                token="x" * 32,
                worker_id="scan-test",
                adapter_name="disabled",
                lease_seconds=120,
                heartbeat_seconds=30,
                poll_seconds=2,
                max_backoff_seconds=30,
                request_timeout_seconds=15,
                job_timeout_seconds=120,
                max_memory_mb=2_048,
                max_job_attempts=3,
                temp_root=root,
            )

            metadata = _run_scan(
                source,
                output,
                [[0.01, 0.01], [0.99, 0.01], [0.99, 0.99], [0.01, 0.99]],
                "auto",
                config,
                root,
                threading.Event(),
                DEFAULT_LIMITS,
            )

            self.assertTrue(output.is_file())
            self.assertGreater(metadata["height"], 3000)
            self.assertLessEqual(metadata["width"] * metadata["height"], 9_010_000)
            self.assertEqual(metadata["corners_source"], "manual")


# =============================================================================================
# `document.partial` -- the coverage flag, and the only thing standing between a page nobody
# read and an automatic decision taken about it.
#
# These live in this file rather than a new one because the worker image runs exactly two
# unittest modules (see `Dockerfile` and the `-m unittest` line in quality-gate.yml). A third
# file would be a test nobody runs. Nothing below reaches a network or a model.
# =============================================================================================


def _build_pdf(objects: list[bytes], path: Path) -> None:
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
    body.extend(
        f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    path.write_bytes(body)


def _write_scanned_pdf(path: Path, page_count: int) -> None:
    """A PDF with no text layer at all: `extract_text()` returns nothing for every page."""
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
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 150 150] /Resources "
                f"<< /XObject << /Im0 {image_object} 0 R >> >> "
                f"/Contents {drawing_object} 0 R >>".encode(),
                f"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB "
                f"/BitsPerComponent 8 /Filter /FlateDecode /Length {len(image)} >>\nstream\n".encode()
                + image
                + b"\nendstream",
                f"<< /Length {len(drawing)} >>\nstream\n".encode() + drawing + b"\nendstream",
            ]
        )
    _build_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            f"<< /Type /Pages /Kids [{' '.join(page_refs)}] /Count {page_count} >>".encode(),
            *page_objects,
        ],
        path,
    )


def _write_text_pdf(path: Path) -> None:
    """A PDF that needs no OCR at all: its one page carries its own text layer."""
    stream = b"BT /F1 14 Tf 40 100 Td (Invoice 123) Tj ET"
    _build_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources "
            b"<< /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        ],
        path,
    )


def _write_mixed_pdf(path: Path) -> None:
    """Page 1 carries a text layer, page 2 is an image. Only page 2 needs OCR."""
    text_stream = b"BT /F1 14 Tf 40 100 Td (Invoice 123) Tj ET"
    image = zlib.compress(b"\xff\xff\xff")
    drawing = b"q 100 0 0 100 25 25 cm /Im0 Do Q"
    _build_pdf(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources "
            b"<< /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            f"<< /Length {len(text_stream)} >>\nstream\n".encode() + text_stream + b"\nendstream",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 150 150] /Resources "
            b"<< /XObject << /Im0 7 0 R >> >> /Contents 8 0 R >>",
            f"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB "
            f"/BitsPerComponent 8 /Filter /FlateDecode /Length {len(image)} >>\nstream\n".encode()
            + image
            + b"\nendstream",
            f"<< /Length {len(drawing)} >>\nstream\n".encode() + drawing + b"\nendstream",
        ],
        path,
    )


WORD_NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def _write_minimal_docx(
    path: Path, body_xml: str, extra_parts: dict[str, str] | None = None
) -> None:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.'
            'relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.'
            'openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        )
        archive.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
            'relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        )
        archive.writestr(
            "word/document.xml",
            f'<?xml version="1.0" encoding="UTF-8"?><w:document {WORD_NAMESPACE}>'
            f"<w:body>{body_xml}</w:body></w:document>",
        )
        for name, inner in (extra_parts or {}).items():
            archive.writestr(name, f'<?xml version="1.0" encoding="UTF-8"?>{inner}')


class _RecordingAdapter:
    """Transcribes every page it is handed, and records which pages those were.

    Model-free by construction. What it proves is a boundary rather than a transcription: which
    pages the PDF path chose to pay for, and therefore which pages it never read at all.
    """

    def __init__(self, silent_pages: set[int] | None = None) -> None:
        self.silent_pages = silent_pages or set()
        self.seen: list[int] = []

    def extract(self, pages: list[PageImage], limits: ExtractionLimits) -> dict[str, Any]:
        del limits
        self.seen.extend(page.page for page in pages)
        blocks = [
            {
                "id": f"ocr-p{page.page}-l1",
                "page": page.page,
                "type": "text",
                "bbox": [0.0, 0.0, 1.0, 1.0],
                "text": f"page {page.page}",
                "confidence": None,
            }
            for page in pages
            if page.page not in self.silent_pages
        ]
        page_text = [
            "" if page.page in self.silent_pages else f"page {page.page}" for page in pages
        ]
        return {
            "schema_version": "1",
            "document": {
                "page_count": max(page.page for page in pages),
                "detected_languages": ["en"],
                "plain_text": "\n\n".join(page_text),
                "partial": any(not text for text in page_text),
            },
            "blocks": blocks,
            "tables": [],
            "marks": [],
        }


class ExtractionPartialFlagTests(unittest.TestCase):
    """`partial` must mean "this extraction did not capture the whole document", and nothing else.

    Every arm is a page or an archive part the worker provably did not read, asserted against the
    line that decides it.
    """

    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    @staticmethod
    def _fake_render(path: Path, page: int, limits: ExtractionLimits) -> PageImage:
        del limits
        output = path.parent / f"fake-render-{page}.png"
        output.write_bytes(b"rendered")
        return PageImage(page, output, 10, 10)

    def _extract_pdf(
        self, source: Path, adapter: Any, limits: ExtractionLimits
    ) -> dict[str, Any]:
        original = parsers._render_pdf_page
        parsers._render_pdf_page = self._fake_render
        try:
            return extract_file(source, "application/pdf", adapter=adapter, limits=limits)
        finally:
            parsers._render_pdf_page = original

    # --- the paid-OCR page cap: `missing[: limits.max_ai_pages]` in parsers._parse_pdf ---

    def test_pages_dropped_by_the_ai_page_cap_make_the_extraction_partial(self) -> None:
        source = self.root / "scan-over-cap.pdf"
        _write_scanned_pdf(source, page_count=4)
        adapter = _RecordingAdapter()

        payload = self._extract_pdf(
            source, adapter, ExtractionLimits(max_ai_pages=2, max_decompressed_bytes=10_000)
        )

        # The cap is the whole point: pages 3 and 4 were never rendered and never paid for, so
        # nothing in this system knows what is on them.
        self.assertEqual(adapter.seen, [1, 2])
        self.assertTrue(payload["document"]["partial"])
        self.assertEqual(payload["document"]["page_count"], 4)
        self.assertEqual([block["page"] for block in payload["blocks"]], [1, 2])

    def test_the_same_scan_within_the_cap_is_not_partial(self) -> None:
        """The paired proof: nothing about the document changed, only whether the cap bit."""
        source = self.root / "scan-within-cap.pdf"
        _write_scanned_pdf(source, page_count=4)
        adapter = _RecordingAdapter()

        payload = self._extract_pdf(
            source, adapter, ExtractionLimits(max_ai_pages=4, max_decompressed_bytes=10_000)
        )

        self.assertEqual(adapter.seen, [1, 2, 3, 4])
        self.assertFalse(payload["document"]["partial"])

    def test_an_attempted_page_that_came_back_empty_is_not_partial(self) -> None:
        """The deliberate non-arm. `partial` answers "did we fail to LOOK at part of this".

        Page 2 was rendered, sent and read; it simply yielded nothing. A blank verso and a failed
        read are indistinguishable here without pixel analysis, so calling it a coverage gap would
        mark most scanned packets partial for having a blank back side -- the always-true flag
        this work removed, with a smaller blast radius. The failed-read half of that ambiguity has
        its own path: `second_pass.improve` retries a page that produced zero lines.
        """
        source = self.root / "scan-silent-page.pdf"
        _write_scanned_pdf(source, page_count=3)
        adapter = _RecordingAdapter(silent_pages={2})

        payload = self._extract_pdf(
            source, adapter, ExtractionLimits(max_ai_pages=20, max_decompressed_bytes=10_000)
        )

        self.assertEqual(adapter.seen, [1, 2, 3])
        self.assertFalse(payload["document"]["partial"])

    def test_a_scan_with_no_adapter_configured_still_fails_loudly(self) -> None:
        """Unchanged by this work, and asserted so the honest flag is not mistaken for the guard."""
        source = self.root / "no-adapter.pdf"
        _write_scanned_pdf(source, page_count=2)

        with self.assertRaises(ProcessingError) as caught:
            extract_file(source, "application/pdf", limits=DEFAULT_LIMITS)

        self.assertEqual(caught.exception.code, "ocr_model_not_selected")

    def test_a_partly_scanned_pdf_with_no_adapter_is_partial_rather_than_fatal(self) -> None:
        """The quiet case: `_parse_pdf` only raises when EVERY page is missing.

        With OCR disabled and one page of two carrying a text layer, extraction succeeds and page
        2 is simply never read by anything. Before the flag was derived, that document claimed the
        same `partial` as a perfect read -- which is to say it claimed nothing.
        """
        source = self.root / "mixed-no-adapter.pdf"
        _write_mixed_pdf(source)

        payload = extract_file(source, "application/pdf", limits=DEFAULT_LIMITS)

        self.assertEqual(payload["document"]["page_count"], 2)
        self.assertIn("Invoice 123", payload["document"]["plain_text"])
        self.assertTrue(payload["document"]["partial"])

    def test_a_full_text_layer_pdf_is_complete(self) -> None:
        """The production complaint: a clean PDF must stop claiming it was only half read."""
        source = self.root / "text.pdf"
        _write_text_pdf(source)

        payload = extract_file(
            source, "application/pdf", adapter=_RecordingAdapter(), limits=DEFAULT_LIMITS
        )

        self.assertFalse(payload["document"]["partial"])
        self.assertIn("Invoice 123", payload["document"]["plain_text"])

    # --- html: what `_parse_html` can and cannot see ---

    def test_html_text_is_read_in_full_and_reports_complete(self) -> None:
        source = self.root / "page.html"
        source.write_text(
            "<!doctype html><p>Supplier 123</p><script>ignore me</script>", encoding="utf-8"
        )

        payload = extract_file(source, "text/html", limits=DEFAULT_LIMITS)

        self.assertFalse(payload["document"]["partial"])
        self.assertNotIn("ignore me", payload["document"]["plain_text"])

    def test_html_wrapping_an_image_is_partial(self) -> None:
        source = self.root / "wrapper.html"
        source.write_text(
            '<!doctype html><p>Invoice attached</p><img src="scan.png">', encoding="utf-8"
        )

        payload = extract_file(source, "text/html", limits=DEFAULT_LIMITS)

        self.assertTrue(payload["document"]["partial"])

    # --- docx: one archive part opened by name, two body child types handled ---

    def test_a_paragraph_and_table_docx_reports_complete(self) -> None:
        source = self.root / "plain.docx"
        _write_minimal_docx(
            source, "<w:p><w:r><w:t>Supplier document 123</w:t></w:r></w:p><w:sectPr/>"
        )

        payload = extract_file(
            source,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            limits=DEFAULT_LIMITS,
        )

        # `w:sectPr` is a skipped body child that carries no text, so it must not count as a gap.
        self.assertFalse(payload["document"]["partial"])
        self.assertIn("Supplier document 123", payload["document"]["plain_text"])

    def test_a_docx_header_is_extracted_rather_than_flagged(self) -> None:
        """A letterhead is document content, so it is read -- and then there is no gap to report."""
        source = self.root / "headed.docx"
        _write_minimal_docx(
            source,
            "<w:p><w:r><w:t>Body line</w:t></w:r></w:p>",
            extra_parts={
                "word/header1.xml": f"<w:hdr {WORD_NAMESPACE}>"
                "<w:p><w:r><w:t>512345678</w:t></w:r></w:p></w:hdr>"
            },
        )

        payload = extract_file(
            source,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            limits=DEFAULT_LIMITS,
        )

        self.assertIn("512345678", payload["document"]["plain_text"])
        self.assertIn("512345678", [block["text"] for block in payload["blocks"]])
        self.assertFalse(payload["document"]["partial"])

    def test_a_footer_page_number_does_not_make_a_word_document_partial(self) -> None:
        """The ubiquity case. Nearly every Word file has one, so flagging it flags everything."""
        source = self.root / "footered.docx"
        _write_minimal_docx(
            source,
            "<w:p><w:r><w:t>Supplier invoice body</w:t></w:r></w:p>",
            extra_parts={
                "word/footer1.xml": f"<w:ftr {WORD_NAMESPACE}>"
                "<w:p><w:r><w:t>Page 1 of 3</w:t></w:r></w:p></w:ftr>"
            },
        )

        payload = extract_file(
            source,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            limits=DEFAULT_LIMITS,
        )

        self.assertFalse(payload["document"]["partial"])
        self.assertIn("Page 1 of 3", payload["document"]["plain_text"])
        # Body first, ancillary parts after: the parser already appends table text this way and
        # does not model which page a footer prints on.
        text = payload["document"]["plain_text"]
        self.assertLess(text.index("Supplier invoice body"), text.index("Page 1 of 3"))

    def test_a_printed_part_that_will_not_open_is_still_a_coverage_gap(self) -> None:
        source = self.root / "broken-header.docx"
        _write_minimal_docx(
            source,
            "<w:p><w:r><w:t>Body line</w:t></w:r></w:p>",
            extra_parts={"word/header1.xml": "<w:hdr><not closed"},
        )

        payload = extract_file(
            source,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            limits=DEFAULT_LIMITS,
        )

        # The body read perfectly, so the document is not lost -- but something printed on it was
        # genuinely never extracted, and that is exactly what the flag is for.
        self.assertTrue(payload["document"]["partial"])
        self.assertIn("Body line", payload["document"]["plain_text"])

    def test_a_separator_only_footnotes_part_contributes_nothing(self) -> None:
        """LibreOffice writes one into most converted files; a separator is not lost content."""
        source = self.root / "footnoted.docx"
        _write_minimal_docx(
            source,
            "<w:p><w:r><w:t>Body line</w:t></w:r></w:p>",
            extra_parts={
                "word/footnotes.xml": f"<w:footnotes {WORD_NAMESPACE}>"
                '<w:footnote w:type="separator" w:id="-1">'
                "<w:p><w:r><w:separator/></w:r></w:p></w:footnote></w:footnotes>"
            },
        )

        payload = extract_file(
            source,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            limits=DEFAULT_LIMITS,
        )

        self.assertFalse(payload["document"]["partial"])

    def test_a_body_content_control_carrying_text_is_reported(self) -> None:
        source = self.root / "content-control.docx"
        _write_minimal_docx(
            source,
            "<w:p><w:r><w:t>Body line</w:t></w:r></w:p>"
            "<w:sdt><w:sdtContent><w:p><w:r><w:t>Total 1392.00</w:t></w:r></w:p>"
            "</w:sdtContent></w:sdt>",
        )

        payload = extract_file(
            source,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            limits=DEFAULT_LIMITS,
        )

        self.assertTrue(payload["document"]["partial"])
        self.assertNotIn("1392.00", payload["document"]["plain_text"])

    # --- the field's shape is unchanged, so this is not a cross-surface contract change ---

    def test_the_contract_still_accepts_both_values_unchanged(self) -> None:
        for expected in (True, False):
            with self.subTest(partial=expected):
                payload = validate_extraction(
                    {
                        "schema_version": "1",
                        "document": {
                            "page_count": 1,
                            "detected_languages": ["he"],
                            "plain_text": "x",
                            "partial": expected,
                        },
                        "blocks": [],
                        "tables": [],
                        "marks": [],
                    },
                    DEFAULT_LIMITS,
                )
                self.assertIs(payload["document"]["partial"], expected)


if __name__ == "__main__":
    unittest.main()
