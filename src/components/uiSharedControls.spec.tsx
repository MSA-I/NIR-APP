import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Card, ICON, Stepper, SubPanel, Tabs, TabPanel, ToggleGroup, panelId, tabId } from './ui';

/*
 * The four controls added on 26.08.2026 to end the drift the UI audit measured: 15 hand-rolled
 * toggles across 13 class strings, 2 quantity steppers sharing no code, 65 card class strings, and
 * no tablist primitive at all. These tests pin the behaviour that made each one worth extracting —
 * not that it renders, but that it does the thing the copies kept getting wrong.
 */

describe('Tabs — ניווט מקלדת בכיוון הנכון', () => {
  function Harness() {
    const [tab, setTab] = useState('orders');
    const items = [
      { key: 'orders', label: 'הזמנות' },
      { key: 'invoices', label: 'חשבוניות' },
      { key: 'prices', label: 'מחירים' },
    ] as const;
    return (
      <>
        <Tabs items={items} value={tab} onChange={setTab} label="מידע עבור ספק" idPrefix="sup" />
        <TabPanel idPrefix="sup" tabKey={tab}>תוכן {tab}</TabPanel>
      </>
    );
  }

  it('מחזיק בדיוק לשונית אחת בסדר ה-Tab', async () => {
    render(<Harness />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  // RTL: the next tab is the one to the LEFT, so ArrowLeft must advance. A tablist that walks
  // the other way is the single most common RTL bug in a component lifted from an LTR library.
  it('ArrowLeft מתקדם ו-ArrowRight חוזר, כמתחייב ב-RTL', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'הזמנות' }));

    // No `waitFor` around the focus assertions, deliberately: `Tabs` moves focus synchronously in
    // the key handler. Waiting for it would pass either way and would hide the return of the
    // requestAnimationFrame this used to use — the delay that let a second key run the previous
    // tab's stale index.
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'חשבוניות' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'חשבוניות' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'הזמנות' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'הזמנות' })).toHaveAttribute('aria-selected', 'true');
  });

  it('End מגיע לאחרונה ו-Home חוזר לראשונה, והמעבר מעגלי', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'הזמנות' }));

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'מחירים' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'מחירים' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'הזמנות' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'הזמנות' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'הזמנות' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'הזמנות' })).toHaveAttribute('aria-selected', 'true');
  });

  /*
   * The race itself, pinned. Two keys with nothing awaited between them — the shape of a held-down
   * arrow, or a screen-reader user stepping fast.
   *
   * `Tabs` closes over the PRESSED tab's index and keys land on `document.activeElement`, so any
   * delay between the state change and the focus move lets the second key re-run the first key's
   * closure with its stale index. Under the requestAnimationFrame this replaced, `{End}{ArrowLeft}`
   * resolved against index 0 instead of index 2 and landed on 'חשבוניות'. It was reported as a
   * flaky test on a loaded runner; it was a real defect that a loaded runner made frequent.
   */
  it('שני מקשים ברצף אינם קוראים את המדד של הלשונית הקודמת', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('tab', { name: 'הזמנות' }));

    await user.keyboard('{End}{ArrowLeft}');

    expect(screen.getByRole('tab', { name: 'הזמנות' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'הזמנות' })).toHaveAttribute('aria-selected', 'true');
  });

  it('הלשונית והפאנל מצביעים זה על זה', () => {
    render(<Harness />);
    const tab = screen.getByRole('tab', { name: 'הזמנות' });
    const panel = screen.getByRole('tabpanel');
    expect(tab).toHaveAttribute('aria-controls', panelId('sup', 'orders'));
    expect(panel).toHaveAttribute('aria-labelledby', tabId('sup', 'orders'));
  });
});

describe('ToggleGroup — המודיפייר מוסיף, לעולם לא מחליף', () => {
  const items = [
    { key: 'open', label: 'פתוחות' },
    { key: 'closed', label: 'סגורות' },
  ] as const;

  // The defect this primitive exists to make impossible: seven sites applied `chip-filter-active`
  // INSTEAD of `chip-filter`, so the SELECTED chip was the one with no 44px floor, no radius and
  // no focus ring — the base rule is where all three live.
  it('הפריט הנבחר נושא גם את מחלקת הבסיס וגם את המודיפייר', () => {
    render(<ToggleGroup items={items} value="open" onChange={() => {}} label="סינון" />);
    const selected = screen.getByRole('button', { name: 'פתוחות' });
    expect(selected.className).toContain('chip-filter');
    expect(selected.className).toContain('chip-filter-active');
    expect(screen.getByRole('button', { name: 'סגורות' }).className).toContain('chip-filter');
  });

  it('מדווח מצב לחיצה במקום להסתמך על צבע בלבד', () => {
    render(<ToggleGroup items={items} value="open" onChange={() => {}} label="סינון" />);
    expect(screen.getByRole('button', { name: 'פתוחות' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'סגורות' })).toHaveAttribute('aria-pressed', 'false');
  });

  // Two of the fifteen hand-rolled controls were sets, not choices — a supplier's delivery days.
  it('מערך ערכים מסמן כמה פריטים בו-זמנית', () => {
    render(<ToggleGroup items={items} value={['open', 'closed']} onChange={() => {}} label="סינון" />);
    for (const name of ['פתוחות', 'סגורות']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    }
  });
});

describe('Stepper — נחסם בקצוות במקום לבלוע לחיצה', () => {
  function Harness({ min = 0, max }: { min?: number; max?: number }) {
    const [qty, setQty] = useState(min);
    return <Stepper value={qty} onChange={setQty} min={min} max={max} label="כמות" />;
  }

  // Both hand-rolled steppers clamped inside the handler, so the button accepted a press and did
  // nothing — which teaches the user the app is unreliable. Here the floor is `disabled`.
  it('כפתור ההפחתה מושבת ברצפה, לא רק מתעלם', () => {
    render(<Harness min={1} />);
    expect(screen.getByRole('button', { name: /הפחתה/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /הוספה/ })).toBeEnabled();
  });

  it('כפתור ההוספה מושבת בתקרה', async () => {
    const user = userEvent.setup();
    render(<Harness min={0} max={2} />);
    const plus = screen.getByRole('button', { name: /הוספה/ });
    await user.click(plus);
    await user.click(plus);
    expect(screen.getByRole('spinbutton', { name: 'כמות' })).toHaveValue(2);
    expect(plus).toBeDisabled();
  });

  it('הקלדה ידנית נחתכת לטווח', async () => {
    const user = userEvent.setup();
    render(<Harness min={0} max={5} />);
    const input = screen.getByRole('spinbutton', { name: 'כמות' });
    await user.clear(input);
    await user.type(input, '9');
    expect(input).toHaveValue(5);
  });

  // Receiving focuses this input when a barcode scan matches a line. A primitive with no handle
  // would have killed that silently — the control still looks right, the scanner just stops.
  it('חושף את שדה הקלט לקורא, כדי שסריקת ברקוד תוכל למקד אותו', () => {
    function WithRef() {
      const ref = useRef<HTMLInputElement>(null);
      return (
        <>
          <Stepper value={1} onChange={() => {}} label="כמות" inputRef={ref} />
          <button type="button" onClick={() => ref.current?.focus()}>מקד</button>
        </>
      );
    }
    render(<WithRef />);
    screen.getByRole('button', { name: 'מקד' }).click();
    expect(screen.getByRole('spinbutton', { name: 'כמות' })).toHaveFocus();
  });
});

/*
 * Press-and-hold, adopted from originui's number input — the behaviour react-aria's NumberField
 * measures at 400ms before the first repeat and 60ms per tick, without adopting react-aria itself.
 * Receiving counts crates and the cart counts units; before this the only way to reach 24 was
 * twenty-four presses or giving up on the buttons entirely.
 *
 * Real timers would make these tests slow and flaky, so they drive the clock directly and press
 * with fireEvent: the point under test is the timer loop, not the pointer plumbing.
 */
describe('Stepper — לחיצה ממושכת חוזרת על הצעד', () => {
  function Harness({ min = 0, max, step = 1 }: { min?: number; max?: number; step?: number }) {
    const [qty, setQty] = useState(min);
    return <Stepper value={qty} onChange={setQty} min={min} max={max} step={step} label="כמות" />;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const qty = () => screen.getByRole('spinbutton', { name: 'כמות' });

  it('לחיצה קצרה היא צעד אחד בדיוק — ההחזקה לא מכפילה אותה', () => {
    render(<Harness min={0} />);
    const plus = screen.getByRole('button', { name: /הוספה/ });
    fireEvent.pointerDown(plus);
    act(() => { vi.advanceTimersByTime(100); });   // released before the 400ms delay elapses
    fireEvent.pointerUp(window);
    fireEvent.click(plus);
    expect(qty()).toHaveValue(1);
  });

  it('החזקה מעבר להשהיה מוסיפה צעד לכל תקתוק', () => {
    render(<Harness min={0} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: /הוספה/ }));
    // 400ms delay, then one tick per 60ms: five ticks by 700ms and nothing before 400ms.
    act(() => { vi.advanceTimersByTime(399); });
    expect(qty()).toHaveValue(0);
    act(() => { vi.advanceTimersByTime(301); });
    expect(qty()).toHaveValue(5);
    fireEvent.pointerUp(window);
  });

  it('שחרור עוצר את הלולאה', () => {
    render(<Harness min={0} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: /הוספה/ }));
    act(() => { vi.advanceTimersByTime(520); });
    const atRelease = (qty() as HTMLInputElement).value;
    fireEvent.pointerUp(window);
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(qty()).toHaveValue(Number(atRelease));
  });

  /*
   * The bound is the case that would run away. The button disables itself the instant the value
   * reaches `max`, and a disabled button fires no pointerup — so a loop that waited for the
   * button's own release would keep ticking against the clamp forever.
   */
  it('נעצר בתקרה ולא ממשיך לתקתק על הגבול', () => {
    render(<Harness min={0} max={3} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: /הוספה/ }));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(qty()).toHaveValue(3);
    expect(screen.getByRole('button', { name: /הוספה/ })).toBeDisabled();
  });

  it('ההפחתה חוזרת כלפי מטה ונעצרת ברצפה', () => {
    render(<Harness min={2} max={40} />);
    const plus = screen.getByRole('button', { name: /הוספה/ });
    fireEvent.pointerDown(plus);
    act(() => { vi.advanceTimersByTime(1_000); });
    fireEvent.pointerUp(window);
    expect((qty() as HTMLInputElement).valueAsNumber).toBeGreaterThan(2);

    fireEvent.pointerDown(screen.getByRole('button', { name: /הפחתה/ }));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(qty()).toHaveValue(2);
  });

  it('הצעד שהוגדר הוא שחוזר, לא 1', () => {
    render(<Harness min={0} step={5} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: /הוספה/ }));
    act(() => { vi.advanceTimersByTime(400 + 60 * 3); });
    expect(qty()).toHaveValue(15);
    fireEvent.pointerUp(window);
  });
});

/*
 * `Number('')` is 0, not NaN, so the old handler let an empty field through as a real zero and the
 * clamp turned it into `min`. Correcting a quantity starts by clearing it — which made the one
 * gesture that precedes every manual correction the gesture that corrupted the value first.
 * Real timers here: these tests are about what the handler does with the string, not about a clock.
 */
describe('Stepper — שדה שרוקן ממתין למספר ואינו קופץ לרצפה', () => {
  function Harness({ min = 1, max = 99 }: { min?: number; max?: number }) {
    const [qty, setQty] = useState(5);
    return (
      <>
        <Stepper value={qty} onChange={setQty} min={min} max={max} label="כמות" />
        <span data-testid="qty">{qty}</span>
      </>
    );
  }
  // Read the value the PARENT was told, not the field: the defect was a phantom onChange, and the
  // field would have looked innocent. Exact string — `toHaveTextContent('5')` also matches '15'.
  const reported = () => screen.getByTestId('qty').textContent;

  it('ריקון השדה אינו מדווח ערך — הכמות נשארת עד שיוקלד מספר', async () => {
    const user = userEvent.setup();
    render(<Harness min={1} />);
    await user.clear(screen.getByRole('spinbutton', { name: 'כמות' }));
    expect(reported()).toBe('5');
  });

  /*
   * The consequence, and the reason this needs a test rather than a comment: the field refilled
   * itself with `min` the instant it emptied, the caret sat after that digit, and what the person
   * typed next was appended to it. At min=1, typing "24" into a field they had just cleared
   * produced 124 — which the clamp then pinned to the ceiling. Two wrong numbers from one keystroke.
   */
  it('המספר שהוקלד אחרי ריקון נקלט כמו שהוא, בלי ספרה שנדבקה מלפנים', async () => {
    const user = userEvent.setup();
    render(<Harness min={1} max={99} />);
    const input = screen.getByRole('spinbutton', { name: 'כמות' });
    await user.clear(input);
    await user.type(input, '24');
    expect(reported()).toBe('24');
  });

  // The clamp was never the defect, and removing it would be the obvious wrong way to fix this.
  it('קלט מחוץ לטווח עדיין נחתך לתקרה', async () => {
    const user = userEvent.setup();
    render(<Harness min={1} max={99} />);
    const input = screen.getByRole('spinbutton', { name: 'כמות' });
    await user.clear(input);
    await user.type(input, '150');
    expect(reported()).toBe('99');
  });
});

describe('Card / SubPanel — מראה, לא תפקיד', () => {
  it('ברירת המחדל היא כרטיס מרופד', () => {
    const { container } = render(<Card>תוכן</Card>);
    const el = container.firstElementChild!;
    expect(el.tagName).toBe('DIV');
    expect(el.className).toContain('card');
    expect(el.className).toContain('card-pad');
  });

  // A card is often really a labelled landmark or a list item. Without `as` every one of those
  // had to opt out and keep composing the class string by hand — the drift this component ends.
  it('`as` שומר על הסמנטיקה, וה-aria עובר דרכו', () => {
    render(<Card as="section" aria-labelledby="h">
      <h2 id="h">חשיפה פיננסית</h2>
    </Card>);
    expect(screen.getByRole('region', { name: 'חשיפה פיננסית' })).toBeInTheDocument();
  });

  it('`pad={false}` לכרטיס שעוטף טבלה, `clip` לילד שנצבע עד הקצה', () => {
    const { container } = render(<Card pad={false} clip>טבלה</Card>);
    expect(container.firstElementChild!.className).not.toContain('card-pad');
    expect(container.firstElementChild!.className).toContain('overflow-hidden');
  });

  it('SubPanel הוא משטח שקוע, לא כרטיס שני', () => {
    const { container } = render(<SubPanel>פרטים</SubPanel>);
    const el = container.firstElementChild!;
    expect(el.className).toContain('bg-surface-sunken');
    expect(el.className).not.toContain('card');
  });
});

describe('ICON — סולם ולא מספרים חופשיים', () => {
  it('שש מדרגות עולות, והשלוש הנפוצות נשארות על ערכן הקיים', () => {
    // sm/md/xs are literally the three most-used values in the codebase today, so 258 existing
    // sites land on a rung without moving a pixel. Changing them is a visual change, not a rename.
    expect(ICON.xs).toBe(13);
    expect(ICON.sm).toBe(15);
    expect(ICON.md).toBe(17);
    const rungs = [ICON.xs, ICON.sm, ICON.md, ICON.lg, ICON.xl, ICON.hero];
    expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
    expect(new Set(rungs).size).toBe(rungs.length);
  });
});
