from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from src.errors import ProcessingError
from src.scanning import scan_document, validate_corners


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


if __name__ == "__main__":
    unittest.main()
