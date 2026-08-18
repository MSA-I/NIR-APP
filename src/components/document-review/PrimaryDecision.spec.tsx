// The primary action of a review screen, in the screen's own flow.
//
// This replaces `StickyPrimaryAction.spec`. What was asserted there — one rendering at every width,
// and the qualifying sentence travelling with the button — is asserted here too. What is asserted
// INSTEAD of the bar is that nothing is fixed over the page and nothing is portalled to `<body>`:
// the bar sat `--mobile-action-bar-size + safe-area + 2rem` off the bottom edge, so page content
// kept scrolling in the gap beneath it and it read as a slab dropped into the middle of the list
// (owner report, 18.08.2026).

import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PrimaryDecision } from './PrimaryDecision';

/** jsdom has no matchMedia; state one anyway, so a phone width cannot bring a bar back by accident. */
function setViewport(matches: (query: string) => boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

const phone = () => setViewport((query) => query.includes('max-width'));
const desktop = () => setViewport(() => false);

function renderAction(hint?: string) {
  return render(
    <div data-testid="page">
      <p>שורה אחרונה ברשימה</p>
      <PrimaryDecision className="mt-3" label="אישור המסמך שהתקבל" hint={hint}>
        <button type="button" className="btn-primary">אישור המסמך</button>
      </PrimaryDecision>
    </div>,
  );
}

const decision = () => screen.queryByTestId('primary-decision');

describe('PrimaryDecision', () => {
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  for (const [name, viewport] of [['בטלפון', phone], ['בדסקטופ', desktop]] as const) {
    it(`${name} — כפתור אחד, בזרימת העמוד, בלי סרגל קבוע ובלי מרווח בסוף המסמך`, () => {
      viewport();
      renderAction();

      // One node, not two: a CSS `lg:hidden` pair would leave the same accessible name twice.
      expect(screen.getAllByRole('button', { name: 'אישור המסמך' })).toHaveLength(1);
      const group = decision();
      expect(group).not.toBeNull();
      expect(group).toContainElement(screen.getByRole('button', { name: 'אישור המסמך' }));
      // Still inside the page it was written in — not fixed over it, not moved to `<body>`.
      expect(group!.closest('[data-testid="page"]')).not.toBeNull();
      expect(group).not.toHaveClass('phone-taskbar');
      expect(group!.className).not.toContain('fixed');
      // Exactly one child of `<body>` — the render container. Nothing was portalled beside it to
      // buy scroll room, because nothing needs scroll room bought for it any more.
      expect(document.body.childElementCount).toBe(1);
      expect(screen.queryByTestId('sticky-primary-action-clearance')).toBeNull();
    });
  }

  it('נושא שם נגיש לזוג ההסבר־והכפתור', () => {
    phone();
    renderAction();
    expect(decision()).toHaveAttribute('aria-label', 'אישור המסמך שהתקבל');
    expect(decision()).toHaveAttribute('role', 'group');
  });

  it('מעביר את משפט ההסבר לפני הכפתור, בעותק אחד, בשני הרוחבים', () => {
    phone();
    const { unmount } = renderAction('יש ממצאים חוסמים.');
    const check = () => {
      const hint = screen.getByText('יש ממצאים חוסמים.');
      expect(screen.getAllByText('יש ממצאים חוסמים.')).toHaveLength(1);
      expect(decision()).toContainElement(hint);
      // Before the press, not after it.
      const cta = screen.getByRole('button', { name: 'אישור המסמך' });
      expect(hint.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    };
    check();
    unmount();

    desktop();
    renderAction('יש ממצאים חוסמים.');
    check();
  });
});
