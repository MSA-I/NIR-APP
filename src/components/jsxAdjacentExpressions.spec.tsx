import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

/**
 * The reading `check:jsx-space` defends against, pinned so the guard cannot outlive it.
 *
 * JSX keeps a single space where whitespace containing a newline sits between two pieces of TEXT,
 * and DROPS it where the same whitespace sits between two EXPRESSIONS. Extraction turns the first
 * shape into the second, so a paragraph that read correctly before it reads with its words glued
 * after it — in both languages, on every screen the line-based extractor split.
 *
 * Seventeen of them shipped before anyone looked.
 */
const t = (value: string) => value;

describe('adjacent JSX expressions and the space between them', () => {
  it('drops the newline between two expressions, and keeps it between two text lines', () => {
    const glued = render(
      <p>
        {t('first sentence,')}
        {t('second sentence.')}
      </p>,
    );
    expect(glued.container.textContent).toBe('first sentence,second sentence.');
    glued.unmount();

    // The same paragraph as plain text — which is what the code looked like before extraction.
    const text = render(
      <p>
        first sentence,
        second sentence.
      </p>,
    );
    expect(text.container.textContent).toBe('first sentence, second sentence.');
    text.unmount();

    // And the fix the guard asks for.
    const spaced = render(
      <p>
        {t('first sentence,')}{' '}
        {t('second sentence.')}
      </p>,
    );
    expect(spaced.container.textContent).toBe('first sentence, second sentence.');
  });
});
