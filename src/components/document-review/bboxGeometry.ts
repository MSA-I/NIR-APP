import type { ExtractionBoundingBox } from '../../lib/types';

/**
 * Geometry for placing bbox overlays over a rendered document page.
 *
 * A bbox is a physical measurement of the source raster: `[xMin, yMin, xMax, yMax]`, each a
 * fraction of the page, with the origin at the page's TOP-LEFT corner. The database validates
 * exactly this shape (`smart_document_bbox_valid`, migration 0045:198). Because these are
 * measurement coordinates and not layout, they are direction-independent: the same box means the
 * same pixels whether the UI runs RTL or LTR. That is why the overlay is positioned with the
 * physical `left` property and never with `insetInlineStart` — see the comment at the style in
 * DocumentSourceViewer.
 */

/** pdf.js reports a page's intrinsic /Rotate normalised to one of these four values. */
export type PageRotation = 0 | 90 | 180 | 270;

/** Fractions (0..1) of the *rendered* page box: physical left / top / width / height. */
export interface PageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Snap whatever pdf.js hands back to the four legal rotations. The PDF spec only allows
 * multiples of 90 and pdf.js already normalises, so anything else is a defect upstream —
 * it snaps to the nearest legal value rather than producing NaN percentages in styles.
 */
export function normalizePageRotation(raw: number | null | undefined): PageRotation {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  const snapped = ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
  return snapped as PageRotation;
}

/**
 * Map a bbox measured on the un-rotated source raster onto the page as pdf.js renders it,
 * i.e. after applying the page's intrinsic /Rotate clockwise.
 *
 * The four cases are the verified formulas from 01-ADVERSARIAL-REVIEW-FINDINGS.md §13,
 * as (left, top, width, height):
 *
 *   0   → (x0,     y0,     x1−x0, y1−y0)
 *   90  → (1−y1,   x0,     y1−y0, x1−x0)
 *   180 → (1−x1,   1−y1,   x1−x0, y1−y0)
 *   270 → (y0,     1−x1,   y1−y0, x1−x0)
 *
 * Zoom needs no arithmetic at all: the rect is in fractions of the rendered page box, so an
 * overlay that is an absolutely-positioned child of that box scales with it for free.
 * Images always use rotation 0 — the raster on screen is the raster that was measured.
 */
export function bboxToPageRect(bbox: ExtractionBoundingBox, rotation: PageRotation): PageRect {
  const [x0, y0, x1, y1] = bbox;
  switch (rotation) {
    case 90:
      return { left: 1 - y1, top: x0, width: y1 - y0, height: x1 - x0 };
    case 180:
      return { left: 1 - x1, top: 1 - y1, width: x1 - x0, height: y1 - y0 };
    case 270:
      return { left: y0, top: 1 - x1, width: y1 - y0, height: x1 - x0 };
    default:
      return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
  }
}
