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

cv2.setNumThreads(1)


ScanMode = Literal["auto", "grayscale", "black_and_white"]
Point = tuple[float, float]
MIN_AUTOMATIC_PAGE_COVERAGE = 0.45
MAX_AUTOMATIC_CROP_MARGIN = 0.20
SMALL_TEXT_PRESERVE_PIXELS = 1_000_000
MAX_METRIC_SAMPLE_PIXELS = 1_000_000
MAX_SCAN_OUTPUT_PIXELS = 9_000_000
MAX_NLM_DENOISE_PIXELS = 4_000_000

FULL_FRAME: tuple[Point, Point, Point, Point] = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))

# Fraction of the frame that the detected edges must span before the whole frame may be accepted
# as the page. Separates "the page fills the frame, so it has no outer edge to trace" from the two
# other ways a frame can contain no page-sized rectangle: a blank capture, and a small document
# lying on a large desk. Measured over the same 17-document corpus plus synthetic controls
# (scripted run in the session scratchpad): every real document spans 0.595-1.000 of its frame,
# and the six that need this fallback span 0.694-1.000; a synthetic small off-centre panel spans
# 0.029 and a blank canvas 0.000. The 0.5 line sits in a gap of more than an order of magnitude,
# so it is not a tuned value.
MIN_FULL_FRAME_EDGE_SPAN = 0.50

# Adaptive threshold parameters. Named once because the OCR lane's secondary pass
# (src/second_pass.py) must binarize a page exactly the way the scan lane would have; two copies
# of these numbers would drift.
ADAPTIVE_BLOCK_MIN = 31
ADAPTIVE_BLOCK_MAX = 81
ADAPTIVE_THRESHOLD_CONSTANT = 13

# `auto` binarizes only when the page is still shadow-dominated AFTER the grayscale branch has
# already divided out the illumination background and equalised it with CLAHE. Measured on the
# owner's 17-document corpus (17 originals plus 20 degraded variants, scripted run recorded in
# the session scratchpad): every single document scored `shadow` >= 0.049, so the previous 0.045
# gate was satisfied by 100% of the corpus and decided nothing -- it read as a discriminator and
# behaved as a rubber stamp. The measured maximum was 0.266, on a flat digital export whose dark
# banner inflates the background deviation rather than any real shadow; the worst genuine phone
# capture reached 0.177. Nothing measured needs binarization, so the gate is set above everything
# measured: it survives for a capture worse than any observed, and stays a named constant so it
# can be lowered against evidence rather than taste.
SEVERE_SHADOW_SCORE = 0.30
# Below the floor there is no ink to threshold; above the ceiling the page is mostly ink and
# binarizing floods it. Unchanged from the previous heuristic.
BINARIZE_INK_RATIO_RANGE = (0.015, 0.42)

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


def _edge_span(edges: np.ndarray) -> float:
    """Fraction of the frame covered by the bounding box of the edge map -- where content is.

    Row/column reductions rather than `findNonZero`, which would materialise every edge pixel as
    a coordinate pair; the answer is identical and the allocation is not.
    """
    rows = np.flatnonzero(edges.any(axis=1))
    columns = np.flatnonzero(edges.any(axis=0))
    if not rows.size or not columns.size:
        return 0.0
    height = int(rows[-1] - rows[0]) + 1
    width = int(columns[-1] - columns[0]) + 1
    return (height * width) / float(edges.shape[0] * edges.shape[1])


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
    flat_frame_fallback = False
    page_sized_rejected = 0
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
            # A strong inner panel, table or coloured notice is often the cleanest rectangle in
            # a document photograph. Treating it as the page silently discards the surrounding
            # evidence. A candidate that does not cover most of the frame is safer to hand to the
            # human corner editor than to present as a successful scan.
            if area_ratio < MIN_AUTOMATIC_PAGE_COVERAGE:
                page_sized_rejected += 1
                continue
            margins = (
                float(points[:, 0].min()) / resized.shape[1],
                float(points[:, 1].min()) / resized.shape[0],
                1.0 - float(points[:, 0].max()) / resized.shape[1],
                1.0 - float(points[:, 1].max()) / resized.shape[0],
            )
            if max(margins) > MAX_AUTOMATIC_CROP_MARGIN:
                page_sized_rejected += 1
                # A flat supplier export has no outer paper edge, so the cleanest
                # quadrilateral is often its internal table. Preserve the whole light
                # canvas instead of deleting the supplier header and totals.
                if float(np.median(gray)) >= 180.0:
                    flat_frame_fallback = True
                continue
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
        if flat_frame_fallback:
            return FULL_FRAME
        if not page_sized_rejected and _edge_span(edges) >= MIN_FULL_FRAME_EDGE_SPAN:
            # No page-sized quadrilateral exists anywhere in this frame at any of the five
            # epsilon ratios -- not one that was found and then judged untrustworthy, but none
            # at all -- and the content fills the frame. That is the signature of a photograph
            # in which the page IS the frame and therefore has no visible outer edge to trace,
            # not of a detector that picked the wrong rectangle. Measured on the owner's
            # 17-document corpus: automatic detection raised `document_not_detected` on 8 of 17.
            # Six of those eight found 35-72 quadrilaterals and not one survived the 12% area
            # floor in `_polygon_is_valid` (largest candidate 0.002-0.116 of the frame); their
            # captures sit at median gray 123-198, so the existing `flat_frame_fallback` --
            # reachable only from the margin branch and only above median 180 -- did not catch
            # them. Sending a person to drag four corners around a photo that is entirely
            # document is pure friction; the full frame still receives deskew and the rest of
            # the pipeline. With this branch the corpus falls from 8 manual-corner demands to 2.
            #
            # Both guards keep `document_not_detected` reachable for the cases it was written
            # for. `page_sized_rejected` covers the remaining two of those eight (largest valid
            # candidate 0.191 and 0.387 of the frame): a real rectangle was found and lost to
            # the 0.45 coverage gate, and there a human genuinely adds information, because
            # accepting the frame keeps a supplier header the detector wanted to crop away while
            # accepting the candidate deletes one. The span guard covers the other two ways a
            # frame holds no page-sized rectangle: a blank capture, and a small document on a
            # large desk, neither of which should be scanned whole.
            return FULL_FRAME
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
    output_pixels = target_width * target_height
    if output_pixels > MAX_SCAN_OUTPUT_PIXELS:
        factor = math.sqrt(MAX_SCAN_OUTPUT_PIXELS / output_pixels)
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
    sample = _metric_sample(background)
    _, standard_deviation = cv2.meanStdDev(sample)
    shadow_score = float(standard_deviation[0, 0]) / 255.0
    divided = cv2.divide(gray, np.maximum(background, 1), scale=255)
    return divided, shadow_score


def _metric_sample(image: np.ndarray) -> np.ndarray:
    """Bound diagnostic metric memory without reducing the scan that OCR receives."""
    height, width = image.shape[:2]
    pixels = height * width
    if pixels <= MAX_METRIC_SAMPLE_PIXELS:
        return image
    scale = math.sqrt(MAX_METRIC_SAMPLE_PIXELS / pixels)
    return cv2.resize(
        image,
        (max(1, round(width * scale)), max(1, round(height * scale))),
        interpolation=cv2.INTER_AREA,
    )


def binarize(gray: np.ndarray) -> np.ndarray:
    """Adaptive threshold, block size scaled to the page. The scan lane's only destructive step.

    Exposed because the OCR lane re-applies exactly this transform when a first extraction of a
    grayscale scan came back broken (src/second_pass.py). The parameters live in one place so the
    recovery pass cannot silently diverge from what the scan lane would have produced.
    """
    block_size = max(
        ADAPTIVE_BLOCK_MIN, min(ADAPTIVE_BLOCK_MAX, ((min(gray.shape[:2]) // 20) | 1))
    )
    return cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY,
        block_size,
        ADAPTIVE_THRESHOLD_CONSTANT,
    )


def _capture_quality(gray: np.ndarray) -> dict[str, float]:
    """Blur and exposure measured on the deskewed page BEFORE denoise, shadow division and CLAHE.

    These are the only two metrics in this dict that can judge the PHOTOGRAPH. `sharpness` below
    cannot: it is `min(1.0, variance / 1500)` computed after CLAHE, and it saturated at exactly
    1.0 for every real capture in the owner's corpus, so it cannot discriminate a sharp page from
    a blurred one. The unsaturated variance separates cleanly on the same corpus -- real documents
    measured 345 to 8717, while Gaussian-blurred variants of those same captures fell to 6.0-75.6
    -- and mean luma separated 137.4 to 244.8 against 58.5-65.0 for darkened variants. Recorded
    raw so a later change can act on them; nothing in the worker reads them yet.
    """
    sample = _metric_sample(gray)
    laplacian = cv2.Laplacian(sample, cv2.CV_32F)
    _, laplacian_deviation = cv2.meanStdDev(laplacian)
    luma_mean, _ = cv2.meanStdDev(sample)
    return {
        "raw_laplacian_variance": float(laplacian_deviation[0, 0]) ** 2,
        "raw_luma_mean": float(luma_mean[0, 0]),
    }


def _enhance(gray: np.ndarray) -> tuple[np.ndarray, np.ndarray, dict[str, float]]:
    capture_quality = _capture_quality(gray)
    shadow_free, shadow_score = _remove_shadows(gray)
    # NLM retains a large search workspace. A near-full 12 MP phone capture can then leave
    # OpenCV unable to allocate the final threshold image under the worker's 2 GiB limit.
    # Median filtering is bounded and preserves document edges well at large resolutions.
    denoised = (
        cv2.fastNlMeansDenoising(shadow_free, None, h=8, templateWindowSize=7, searchWindowSize=21)
        if shadow_free.size <= MAX_NLM_DENOISE_PIXELS
        else cv2.medianBlur(shadow_free, 3)
    )
    del shadow_free
    enhanced = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(denoised)
    del denoised
    black_and_white = binarize(enhanced)
    metric_enhanced = _metric_sample(enhanced)
    metric_black_and_white = _metric_sample(black_and_white)
    ink_pixels = metric_black_and_white.size - cv2.countNonZero(metric_black_and_white)
    ink_ratio = float(ink_pixels) / float(metric_black_and_white.size)
    _, contrast_deviation = cv2.meanStdDev(metric_enhanced)
    local_contrast = float(contrast_deviation[0, 0]) / 255.0
    laplacian = cv2.Laplacian(metric_enhanced, cv2.CV_32F)
    _, sharpness_deviation = cv2.meanStdDev(laplacian)
    sharpness_variance = float(sharpness_deviation[0, 0]) ** 2
    sharpness = min(1.0, sharpness_variance / 1500.0)
    return enhanced, black_and_white, {
        "shadow": shadow_score,
        "ink_ratio": ink_ratio,
        "contrast": local_contrast,
        "sharpness": sharpness,
        **capture_quality,
    }


def _select_mode(
    mode: ScanMode,
    metrics: dict[str, float],
    *,
    preserve_small_text: bool,
) -> Literal["grayscale", "black_and_white"]:
    if mode == "grayscale":
        return "grayscale"
    if mode == "black_and_white":
        return "black_and_white"
    if preserve_small_text:
        return "grayscale"
    # Grayscale is the default output. Binarization throws away every intermediate tone the
    # vision model could have used, and nothing anywhere measures whether it helped: the OCR
    # provider never sees the original capture, only this derivative. The previous gate accepted
    # any page whose `contrast` or `sharpness` cleared 0.12 OR whose `shadow` cleared 0.045, and
    # on the owner's corpus that condition was true for all 17 documents -- the only thing
    # keeping any page in grayscale was the small-text guard above. Grayscale already ships the
    # shadow-divided, CLAHE-equalised page (`_enhance`), so uneven lighting is corrected without
    # destroying anything; a page has to be shadow-dominated even after that correction before
    # throwing tones away is the better trade.
    #
    # `requested_mode='black_and_white'` is unaffected and remains the manual override and the
    # lever a recovery pass pulls.
    low_ink, high_ink = BINARIZE_INK_RATIO_RANGE
    usable_ink = low_ink <= metrics["ink_ratio"] <= high_ink
    severe_shadow = metrics["shadow"] >= SEVERE_SHADOW_SCORE
    return "black_and_white" if severe_shadow and usable_ink else "grayscale"


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
    del image
    gray = cv2.cvtColor(transformed, cv2.COLOR_BGR2GRAY)
    del transformed
    rotation = _deskew_angle(gray)
    deskewed = _rotate(gray, rotation)
    if deskewed is not gray:
        del gray
    enhanced, black_and_white, metrics = _enhance(deskewed)
    preserve_small_text = deskewed.shape[0] * deskewed.shape[1] <= SMALL_TEXT_PRESERVE_PIXELS
    output_mode = _select_mode(
        mode,
        metrics,
        preserve_small_text=preserve_small_text,
    )
    if output_mode == "black_and_white":
        output = black_and_white
    elif preserve_small_text:
        # Contrast enhancement erased small Hebrew headers and VAT figures in the
        # first-client corpus. Raw grayscale retains the source evidence.
        output = deskewed
    else:
        output = enhanced
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
