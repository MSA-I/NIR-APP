from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Sequence

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
from pillow_heif import register_heif_opener

try:
    from pillow_heif import register_avif_opener
except ImportError:  # pragma: no cover - older pillow-heif fallback
    register_avif_opener = None

from .errors import ProcessingError
from .limits import DEFAULT_LIMITS, ExtractionLimits


ScanMode = Literal["auto", "grayscale", "black_and_white"]
Point = tuple[float, float]

register_heif_opener()
if register_avif_opener:
    register_avif_opener()


@dataclass(frozen=True, slots=True)
class ScanResult:
    output_path: Path
    output_sha256: str
    output_bytes: int
    width: int
    height: int
    corners: tuple[Point, Point, Point, Point]
    rotation_degrees: float
    output_mode: Literal["grayscale", "black_and_white"]
    corners_source: Literal["automatic", "manual"]
    metrics: dict[str, float]

    def metadata(self) -> dict[str, Any]:
        return {
            "schema_version": "1",
            "output_sha256": self.output_sha256,
            "output_bytes": self.output_bytes,
            "width": self.width,
            "height": self.height,
            "corners": [[round(x, 6), round(y, 6)] for x, y in self.corners],
            "rotation_degrees": round(self.rotation_degrees, 4),
            "output_mode": self.output_mode,
            "corners_source": self.corners_source,
            "metrics": {key: round(value, 6) for key, value in self.metrics.items()},
        }


def _read_image(path: Path, limits: ExtractionLimits) -> np.ndarray:
    Image.MAX_IMAGE_PIXELS = limits.max_image_pixels
    try:
        with Image.open(path) as image:
            image.seek(0)
            normalized = ImageOps.exif_transpose(image).convert("RGB")
            width, height = normalized.size
            if width < 32 or height < 32:
                raise ProcessingError("scan_image_too_small", "Document image is too small to scan")
            if width * height > limits.max_image_pixels:
                raise ProcessingError(
                    "decompressed_size_limit", "Decoded image exceeds its safety limit"
                )
            rgb = np.asarray(normalized, dtype=np.uint8)
    except ProcessingError:
        raise
    except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
        raise ProcessingError("corrupt_document", "Image is corrupt or unsupported") from exc
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def _order_points(points: np.ndarray) -> np.ndarray:
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    ordered = np.zeros((4, 2), dtype=np.float32)
    total = points.sum(axis=1)
    difference = np.diff(points, axis=1).reshape(-1)
    ordered[0] = points[np.argmin(total)]
    ordered[2] = points[np.argmax(total)]
    ordered[1] = points[np.argmin(difference)]
    ordered[3] = points[np.argmax(difference)]
    return ordered


def _polygon_is_valid(points: np.ndarray, width: int, height: int) -> bool:
    ordered = _order_points(points)
    area = abs(cv2.contourArea(ordered))
    if area < width * height * 0.12:
        return False
    if not cv2.isContourConvex(ordered.astype(np.int32)):
        return False
    sides = [
        float(np.linalg.norm(ordered[(index + 1) % 4] - ordered[index]))
        for index in range(4)
    ]
    return min(sides) >= min(width, height) * 0.12


def _right_angle_score(points: np.ndarray) -> float:
    ordered = _order_points(points)
    errors: list[float] = []
    for index in range(4):
        previous = ordered[(index - 1) % 4] - ordered[index]
        following = ordered[(index + 1) % 4] - ordered[index]
        denominator = float(np.linalg.norm(previous) * np.linalg.norm(following))
        if denominator <= 1e-6:
            return 0.0
        cosine = abs(float(np.dot(previous, following)) / denominator)
        errors.append(min(1.0, cosine))
    return max(0.0, 1.0 - sum(errors) / len(errors))


def detect_document_corners(image: np.ndarray) -> tuple[Point, Point, Point, Point]:
    height, width = image.shape[:2]
    scale = min(1.0, 1600.0 / max(width, height))
    resized = cv2.resize(
        image,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR,
    )
    gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
    gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    median = float(np.median(blurred))
    lower = int(max(20, 0.55 * median))
    upper = int(min(255, max(lower + 30, 1.35 * median)))
    edges = cv2.Canny(blurred, lower, upper)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

    frame_area = resized.shape[0] * resized.shape[1]
    candidates: list[tuple[float, np.ndarray]] = []
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:40]:
        perimeter = cv2.arcLength(contour, True)
        if perimeter <= 0:
            continue
        for epsilon_ratio in (0.015, 0.02, 0.025, 0.03, 0.04):
            polygon = cv2.approxPolyDP(contour, epsilon_ratio * perimeter, True)
            if len(polygon) != 4:
                continue
            points = polygon.reshape(4, 2).astype(np.float32)
            if not _polygon_is_valid(points, resized.shape[1], resized.shape[0]):
                continue
            area_ratio = abs(cv2.contourArea(_order_points(points))) / frame_area
            border_distance = min(
                points[:, 0].min(),
                points[:, 1].min(),
                resized.shape[1] - points[:, 0].max(),
                resized.shape[0] - points[:, 1].max(),
            )
            border_bonus = 0.03 if border_distance > 2 else 0.0
            score = area_ratio * 0.8 + _right_angle_score(points) * 0.2 + border_bonus
            candidates.append((score, points))
            break

    if not candidates:
        raise ProcessingError(
            "document_not_detected",
            "Document boundaries could not be detected; manual corner selection is required",
        )
    points = _order_points(max(candidates, key=lambda item: item[0])[1]) / scale
    normalized = points / np.array([width, height], dtype=np.float32)
    normalized = np.clip(normalized, 0.0, 1.0)
    return tuple((float(x), float(y)) for x, y in normalized)  # type: ignore[return-value]


def validate_corners(corners: Sequence[Sequence[float]]) -> tuple[Point, Point, Point, Point]:
    if len(corners) != 4 or any(len(point) != 2 for point in corners):
        raise ProcessingError("invalid_scan_corners", "Exactly four document corners are required")
    try:
        points = np.asarray(corners, dtype=np.float32).reshape(4, 2)
    except (TypeError, ValueError) as exc:
        raise ProcessingError("invalid_scan_corners", "Document corners are invalid") from exc
    if not np.isfinite(points).all() or (points < 0).any() or (points > 1).any():
        raise ProcessingError("invalid_scan_corners", "Document corners must be normalized")
    ordered = _order_points(points)
    if abs(cv2.contourArea(ordered)) < 0.08 or not cv2.isContourConvex(ordered):
        raise ProcessingError("invalid_scan_corners", "Document corners do not form a usable page")
    return tuple((float(x), float(y)) for x, y in ordered)  # type: ignore[return-value]


def _perspective_transform(image: np.ndarray, corners: tuple[Point, Point, Point, Point]) -> np.ndarray:
    height, width = image.shape[:2]
    source = np.asarray(corners, dtype=np.float32) * np.array([width, height], dtype=np.float32)
    top = np.linalg.norm(source[1] - source[0])
    bottom = np.linalg.norm(source[2] - source[3])
    left = np.linalg.norm(source[3] - source[0])
    right = np.linalg.norm(source[2] - source[1])
    target_width = int(round(max(top, bottom)))
    target_height = int(round(max(left, right)))
    if target_width < 64 or target_height < 64:
        raise ProcessingError("invalid_scan_corners", "Selected document area is too small")
    longest = max(target_width, target_height)
    if longest > 4096:
        factor = 4096.0 / longest
        target_width = max(64, round(target_width * factor))
        target_height = max(64, round(target_height * factor))
    destination = np.array(
        [
            [0, 0],
            [target_width - 1, 0],
            [target_width - 1, target_height - 1],
            [0, target_height - 1],
        ],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(source, destination)
    return cv2.warpPerspective(
        image,
        matrix,
        (target_width, target_height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _deskew_angle(gray: np.ndarray) -> float:
    inverse = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        15,
    )
    lines = cv2.HoughLinesP(
        inverse,
        1,
        np.pi / 180,
        threshold=max(40, min(gray.shape) // 6),
        minLineLength=max(40, min(gray.shape) // 5),
        maxLineGap=20,
    )
    if lines is None:
        return 0.0
    angles: list[float] = []
    for x1, y1, x2, y2 in lines[:, 0]:
        angle = math.degrees(math.atan2(float(y2 - y1), float(x2 - x1)))
        while angle <= -45:
            angle += 90
        while angle > 45:
            angle -= 90
        if abs(angle) <= 7:
            angles.append(angle)
    if len(angles) < 2:
        return 0.0
    angle = float(np.median(angles))
    return angle if abs(angle) >= 0.2 else 0.0


def _rotate(image: np.ndarray, degrees: float) -> np.ndarray:
    if degrees == 0:
        return image
    height, width = image.shape[:2]
    matrix = cv2.getRotationMatrix2D((width / 2, height / 2), degrees, 1.0)
    return cv2.warpAffine(
        image,
        matrix,
        (width, height),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_REPLICATE,
    )


def _remove_shadows(gray: np.ndarray) -> tuple[np.ndarray, float]:
    kernel_size = max(31, (min(gray.shape) // 16) | 1)
    background = cv2.GaussianBlur(gray, (kernel_size, kernel_size), 0)
    shadow_score = float(np.std(background)) / 255.0
    divided = cv2.divide(gray, np.maximum(background, 1), scale=255)
    return divided, shadow_score


def _enhance(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    shadow_free, shadow_score = _remove_shadows(gray)
    denoised = cv2.fastNlMeansDenoising(shadow_free, None, h=8, templateWindowSize=7, searchWindowSize=21)
    enhanced = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(denoised)
    block_size = max(31, min(81, ((min(enhanced.shape) // 20) | 1)))
    black_and_white = cv2.adaptiveThreshold(
        enhanced,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        block_size,
        13,
    )
    ink_ratio = float(np.mean(black_and_white < 128))
    local_contrast = float(np.std(enhanced)) / 255.0
    sharpness = min(1.0, float(cv2.Laplacian(enhanced, cv2.CV_64F).var()) / 1500.0)
    return enhanced, black_and_white, {
        "shadow": shadow_score,
        "ink_ratio": ink_ratio,
        "contrast": local_contrast,
        "sharpness": sharpness,
    }


def _select_mode(mode: ScanMode, metrics: dict[str, float]) -> Literal["grayscale", "black_and_white"]:
    if mode == "grayscale":
        return "grayscale"
    if mode == "black_and_white":
        return "black_and_white"
    usable_ink = 0.015 <= metrics["ink_ratio"] <= 0.42
    crisp_enough = metrics["contrast"] >= 0.12 or metrics["sharpness"] >= 0.12
    strong_shadow = metrics["shadow"] >= 0.045
    return "black_and_white" if usable_ink and (crisp_enough or strong_shadow) else "grayscale"


def scan_document(
    source_path: str | Path,
    output_path: str | Path,
    *,
    corners: Sequence[Sequence[float]] | None = None,
    mode: ScanMode = "auto",
    limits: ExtractionLimits = DEFAULT_LIMITS,
) -> ScanResult:
    if mode not in {"auto", "grayscale", "black_and_white"}:
        raise ProcessingError("invalid_scan_mode", "Document scan mode is invalid")
    source = Path(source_path).resolve()
    destination = Path(output_path).resolve()
    if source == destination:
        raise ProcessingError("scan_output_invalid", "Scanned output must not replace the source")
    image = _read_image(source, limits)
    if corners is None:
        selected_corners = detect_document_corners(image)
        corners_source: Literal["automatic", "manual"] = "automatic"
    else:
        selected_corners = validate_corners(corners)
        corners_source = "manual"
    transformed = _perspective_transform(image, selected_corners)
    gray = cv2.cvtColor(transformed, cv2.COLOR_BGR2GRAY)
    rotation = _deskew_angle(gray)
    deskewed = _rotate(gray, rotation)
    enhanced, black_and_white, metrics = _enhance(deskewed)
    output_mode = _select_mode(mode, metrics)
    output = black_and_white if output_mode == "black_and_white" else enhanced
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".tmp")
    try:
        encoded, payload = cv2.imencode(".png", output, [cv2.IMWRITE_PNG_COMPRESSION, 6])
        if not encoded:
            raise ProcessingError("scan_output_failed", "Scanned document could not be encoded")
        data = payload.tobytes()
        if len(data) > limits.max_file_bytes:
            raise ProcessingError("file_size_limit", "Scanned document exceeds the file size limit")
        temporary.write_bytes(data)
        temporary.replace(destination)
    except ProcessingError:
        temporary.unlink(missing_ok=True)
        raise
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise ProcessingError("scan_output_failed", "Scanned document could not be saved") from exc
    return ScanResult(
        output_path=destination,
        output_sha256=hashlib.sha256(data).hexdigest(),
        output_bytes=len(data),
        width=int(output.shape[1]),
        height=int(output.shape[0]),
        corners=selected_corners,
        rotation_degrees=rotation,
        output_mode=output_mode,
        corners_source=corners_source,
        metrics=metrics,
    )
