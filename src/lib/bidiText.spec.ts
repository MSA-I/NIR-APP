import { describe, expect, it } from 'vitest';
import { bidiIsolate } from './format';

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
