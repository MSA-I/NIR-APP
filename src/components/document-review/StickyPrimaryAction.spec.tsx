// The primary action of a review screen, pinned to the thumb on a phone.
//
// What is asserted here is what a class-only `lg:hidden` pair cannot give: that the CTA exists
// exactly ONCE in the document at every width, that desktop keeps the button in its original
// position in the flow, and that the bar buys its own scroll room instead of parking itself on top
// of the last row of whatever list it is floating over.

import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { StickyPrimaryAction } from './StickyPrimaryAction';

/** jsdom has no matchMedia, and the hook then answers desktop — so a phone has to be stated. */
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
      <StickyPrimaryAction className="mt-3" label="אישור המסמך שהתקבל" hint={hint}>
        <button type="button" className="btn-primary">אישור המסמך</button>
      </StickyPrimaryAction>
    </div>,
  );
}

const bar = () => screen.queryByTestId('sticky-primary-action');
const clearance = () => screen.queryByTestId('sticky-primary-action-clearance');

describe('StickyPrimaryAction', () => {
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  it('מציג את הפעולה בסרגל מוצמד בטלפון — פעם אחת בלבד', () => {
    phone();
    renderAction();

    // One node, not two: a CSS pair would leave the same accessible name twice in the document.
    expect(screen.getAllByRole('button', { name: 'אישור המסמך' })).toHaveLength(1);
    const sticky = bar();
    expect(sticky).not.toBeNull();
    expect(sticky).toContainElement(screen.getByRole('button', { name: 'אישור המסמך' }));
    // The one existing per-screen sticky idiom in the product. index.css positions it above the
    // global mobile action bar and lifts the toast stack over it; a second idiom would not.
    expect(sticky).toHaveClass('phone-taskbar');
    expect(sticky).toHaveAttribute('aria-label', 'אישור המסמך שהתקבל');
  });

  it('משאיר את הכפתור במקומו בזרימה בדסקטופ — פעם אחת, בלי סרגל ובלי מרווח', () => {
    desktop();
    renderAction();

    expect(screen.getAllByRole('button', { name: 'אישור המסמך' })).toHaveLength(1);
    expect(bar()).toBeNull();
    expect(clearance()).toBeNull();
    // Still inside the page flow, after the content it belongs to — the order the assessment
    // screen's placement tests depend on.
    expect(screen.getByRole('button', { name: 'אישור המסמך' }).closest('[data-testid="page"]'))
      .not.toBeNull();
  });

  it('מוסיף מרווח גלילה בסוף המסמך כדי שהסרגל לא יכסה את השורה האחרונה', () => {
    phone();
    renderAction();

    const spacer = clearance();
    expect(spacer).not.toBeNull();
    // At the END of the document, not beside the button: the approve button sits ABOVE the folded
    // evidence, so a spacer rendered in place would open a hole mid-screen and still leave the
    // last row under the bar.
    expect(spacer!.parentElement).toBe(document.body);
    expect(document.body.lastElementChild).toBe(spacer);
    expect(spacer).toHaveAttribute('aria-hidden', 'true');
  });

  it('מעביר את משפט ההסבר יחד עם הכפתור, ולא משאיר עותק שני מאחור', () => {
    phone();
    renderAction('יש ממצאים חוסמים.');

    expect(screen.getAllByText('יש ממצאים חוסמים.')).toHaveLength(1);
    expect(bar()).toContainElement(screen.getByText('יש ממצאים חוסמים.'));
  });

  it('בדסקטופ משפט ההסבר נשאר מתחת לכפתור, במקום שבו הוא נכתב', () => {
    desktop();
    renderAction('יש ממצאים חוסמים.');

    const hint = screen.getByText('יש ממצאים חוסמים.');
    expect(screen.getAllByText('יש ממצאים חוסמים.')).toHaveLength(1);
    const cta = screen.getByRole('button', { name: 'אישור המסמך' });
    expect(cta.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
