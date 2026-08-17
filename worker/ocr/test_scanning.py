from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from src.errors import ProcessingError
from src.limits import DEFAULT_LIMITS
from src.scanning import (
    SEVERE_SHADOW_SCORE,
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

            self.assertEqual(result.corners_source, "automatic")
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

            self.assertEqual(result.corners_source, "automatic")
            self.assertEqual(
                result.corners, ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
            )
            self.assertTrue(output.is_file())

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


if __name__ == "__main__":
    unittest.main()
