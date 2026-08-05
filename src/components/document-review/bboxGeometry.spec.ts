import { describe, expect, it } from 'vitest';
import type { ExtractionBoundingBox } from '../../lib/types';
import { bboxToPageRect, normalizePageRotation } from './bboxGeometry';

// Deliberately asymmetric (width 0.3, height 0.6): a symmetric box renders identically under
// several wrong formulas, which is exactly how the original mirror bug went unnoticed.
const box: ExtractionBoundingBox = [0.1, 0.2, 0.4, 0.8];

const closeTo = (
  rect: ReturnType<typeof bboxToPageRect>,
  expected: { left: number; top: number; width: number; height: number },
) => {
  expect(rect.left).toBeCloseTo(expected.left, 10);
  expect(rect.top).toBeCloseTo(expected.top, 10);
  expect(rect.width).toBeCloseTo(expected.width, 10);
  expect(rect.height).toBeCloseTo(expected.height, 10);
};

describe('bboxToPageRect — the four verified rotation formulas (§13)', () => {
  it('rotation 0 is the identity: (x0, y0, x1−x0, y1−y0)', () => {
    closeTo(bboxToPageRect(box, 0), { left: 0.1, top: 0.2, width: 0.3, height: 0.6 });
  });

  it('rotation 90 maps to (1−y1, x0, y1−y0, x1−x0)', () => {
    closeTo(bboxToPageRect(box, 90), { left: 0.2, top: 0.1, width: 0.6, height: 0.3 });
  });

  it('rotation 180 maps to (1−x1, 1−y1, x1−x0, y1−y0)', () => {
    closeTo(bboxToPageRect(box, 180), { left: 0.6, top: 0.2, width: 0.3, height: 0.6 });
  });

  it('rotation 270 maps to (y0, 1−x1, y1−y0, x1−x0)', () => {
    closeTo(bboxToPageRect(box, 270), { left: 0.2, top: 0.6, width: 0.6, height: 0.3 });
  });

  it('a full-page box stays the full page under every rotation', () => {
    for (const rotation of [0, 90, 180, 270] as const) {
      closeTo(bboxToPageRect([0, 0, 1, 1], rotation), { left: 0, top: 0, width: 1, height: 1 });
    }
  });
});

describe('normalizePageRotation', () => {
  it('keeps the four legal values', () => {
    expect(normalizePageRotation(0)).toBe(0);
    expect(normalizePageRotation(90)).toBe(90);
    expect(normalizePageRotation(180)).toBe(180);
    expect(normalizePageRotation(270)).toBe(270);
  });

  it('wraps full turns and negatives the way pdf.js counts them', () => {
    expect(normalizePageRotation(360)).toBe(0);
    expect(normalizePageRotation(450)).toBe(90);
    expect(normalizePageRotation(-90)).toBe(270);
  });

  it('snaps out-of-spec input to a legal rotation instead of producing NaN styles', () => {
    expect(normalizePageRotation(91)).toBe(90);
    expect(normalizePageRotation(44)).toBe(0);
    expect(normalizePageRotation(Number.NaN)).toBe(0);
    expect(normalizePageRotation(null)).toBe(0);
    expect(normalizePageRotation(undefined)).toBe(0);
  });
});
