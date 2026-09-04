import { describe, expect, it } from 'vitest';
import { bidiIsolate, ltrIsolate } from './format';

describe('bidiIsolate — the plain-text twin of <bdi> (DESIGN.md, חוק בידוד השמות)', () => {
  it('fences the string with FSI…PDI so neighbours cannot reorder across it', () => {
    const isolated = bidiIsolate('מטליות מיקרופייבר 30*30 אר-12ב');
    expect(isolated.codePointAt(0)).toBe(0x2068); // FIRST STRONG ISOLATE
    expect(isolated.codePointAt(isolated.length - 1)).toBe(0x2069); // POP DIRECTIONAL ISOLATE
    expect(isolated.slice(1, -1)).toBe('מטליות מיקרופייבר 30*30 אר-12ב');
  });

  it('adds exactly two characters — no trimming, no substitution', () => {
    expect(bidiIsolate('Coca-Cola 1.5L')).toHaveLength('Coca-Cola 1.5L'.length + 2);
    expect(bidiIsolate('')).toHaveLength(2);
  });
});

describe('ltrIsolate — the plain-text twin of <bdi dir="ltr">, for file names', () => {
  it('fences the string with LRI…PDI, not FSI', () => {
    const isolated = ltrIsolate('93_00002007 — חלק 3.pdf');
    expect(isolated.codePointAt(0)).toBe(0x2066); // LEFT-TO-RIGHT ISOLATE
    expect(isolated.codePointAt(isolated.length - 1)).toBe(0x2069); // POP DIRECTIONAL ISOLATE
    expect(isolated.slice(1, -1)).toBe('93_00002007 — חלק 3.pdf');
  });

  /**
   * The whole point of the pair. FSI resolves the run's direction from its first strong character,
   * so a name whose first strong character is Hebrew comes out RTL and reorders its own digits and
   * extension inside the fence. LRI states the direction instead of guessing it — the difference
   * is one code point and it is the entire finding.
   */
  it('differs from bidiIsolate in exactly the character that decides direction', () => {
    const name = 'חשבונית ספק לבדיקה.pdf';
    expect(ltrIsolate(name)).not.toBe(bidiIsolate(name));
    expect(ltrIsolate(name).slice(1)).toBe(bidiIsolate(name).slice(1));
  });

  it('adds exactly two characters — no trimming, no substitution', () => {
    expect(ltrIsolate('Coca-Cola 1.5L')).toHaveLength('Coca-Cola 1.5L'.length + 2);
    expect(ltrIsolate('')).toHaveLength(2);
  });
});
