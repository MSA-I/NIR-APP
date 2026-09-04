import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DataTable, type Column } from './ui';

/**
 * RTL-A11Y-02 — the mobile card and the column checklist disagreed, and the checklist lost.
 *
 * `priority: 3` is the DEFAULT for a column nobody chose, not a ban. Before this, the mobile card
 * filtered `visibleColumns` on `(c.priority ?? 2) <= 2` UNCONDITIONALLY, while the same sheet
 * rendered a checklist whose ticks moved `columnVisibility` — state the priority filter then
 * overrode. On /payments that removed the invoice-allocation column, the notes and the executed-by
 * column from every card at 390px, reported them as shown in the checklist, and gave the viewer no
 * way to get them back. A payment covering three invoices read as one bare amount.
 *
 * What is asserted here is one predicate in two directions: an EXPLICIT tick beats the priority
 * default, and the absence of a tick still means the priority default. The desktop table is
 * asserted alongside every mobile claim, because the picker is one piece of state serving two
 * bodies and a fix that quietly emptied the table would satisfy the mobile half on its own.
 */

interface Row { id: string; name: string; amount: number; note: string }

const rows: Row[] = [
  { id: 'r0', name: 'שורה אפס', amount: 100, note: 'ריכוז שלוש חשבוניות' },
  { id: 'r1', name: 'שורה אחת', amount: 200, note: 'תשלום חלקי' },
];

/** `note` carries priority 3 — the shape /payments gives הערות, חשבוניות and בוצע על ידי. */
const columns: Column<Row>[] = [
  { key: 'name', header: 'שם', render: (r) => r.name },
  { key: 'amount', header: 'סכום', render: (r) => String(r.amount) },
  { key: 'note', header: 'הערות', priority: 3, render: (r) => r.note },
];

/** jsdom has no matchMedia and `useMediaQuery` then answers desktop, so a phone must be stated. */
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

/**
 * Both bodies are mounted at once and hidden with CSS (`lg:hidden` / `hidden lg:block`), so a bare
 * `screen.getByText` finds a value in the desktop table that no phone ever paints. Every mobile
 * claim below is scoped to a card, and every desktop claim to a `columnheader`.
 */
const cards = () => Array.from(document.querySelectorAll('li.mobile-data-card')) as HTMLElement[];
const firstCard = () => cards()[0];

const openSheet = () => {
  fireEvent.click(screen.getByRole('button', { name: /סינון ותצוגה/ }));
  return screen.getByRole('dialog', { name: 'סינון ותצוגה' });
};

describe('mobile cards — an explicit column choice beats the priority default (RTL-A11Y-02)', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(() => false); // 390px: every media query answers no.
  });
  afterEach(() => Reflect.deleteProperty(window, 'matchMedia'));

  it('keeps priority 3 off the card while the viewer has chosen nothing', () => {
    render(<DataTable rows={rows} columns={columns} columnPicker="spec-mobile-default" />);
    expect(within(firstCard()).getByText('100')).toBeInTheDocument();
    expect(within(firstCard()).queryByText('ריכוז שלוש חשבוניות')).not.toBeInTheDocument();
    // The default is a default, not a deletion: the column is still a column.
    expect(screen.getByRole('columnheader', { name: 'הערות' })).toBeInTheDocument();
  });

  it('reports the card, not the desktop table, in the checklist on a phone', () => {
    render(<DataTable rows={rows} columns={columns} columnPicker="spec-mobile-report" />);
    openSheet();
    // The measured defect: הערות read as shown while no card carried it. A checkbox that says a
    // column is on, over a card that does not have it, is the thing the viewer cannot act on.
    expect(screen.getByRole('checkbox', { name: 'הערות' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'סכום' })).toBeChecked();
  });

  it('puts a priority 3 column on the card when the viewer turns it on', () => {
    render(<DataTable rows={rows} columns={columns} columnPicker="spec-mobile-on" />);
    openSheet();
    const box = screen.getByRole('checkbox', { name: 'הערות' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);

    expect(box).toBeChecked();
    expect(within(firstCard()).getByText('ריכוז שלוש חשבוניות')).toBeInTheDocument();
    // Every card, not only the one that happened to be first.
    expect(within(cards()[1]).getByText('תשלום חלקי')).toBeInTheDocument();
  });

  it('returns it to the priority default on a second tick, without hiding it from the table', () => {
    render(<DataTable rows={rows} columns={columns} columnPicker="spec-mobile-off" />);
    openSheet();
    const box = screen.getByRole('checkbox', { name: 'הערות' });
    fireEvent.click(box);
    expect(within(firstCard()).getByText('ריכוז שלוש חשבוניות')).toBeInTheDocument();

    fireEvent.click(box);
    expect(within(firstCard()).queryByText('ריכוז שלוש חשבוניות')).not.toBeInTheDocument();
    // Turning a phone-only default back off must not reach the desktop table. It is one piece of
    // state serving two bodies, and `false` would have hidden the column on both.
    expect(screen.getByRole('columnheader', { name: 'הערות' })).toBeInTheDocument();
    expect(localStorage.getItem('sf.columns.spec-mobile-off') ?? '').not.toContain('note');
  });

  it('survives a remount, so the choice is a preference and not a gesture', () => {
    const first = render(<DataTable rows={rows} columns={columns} columnPicker="spec-mobile-keep" />);
    openSheet();
    fireEvent.click(screen.getByRole('checkbox', { name: 'הערות' }));
    expect(within(firstCard()).getByText('ריכוז שלוש חשבוניות')).toBeInTheDocument();
    first.unmount();

    render(<DataTable rows={rows} columns={columns} columnPicker="spec-mobile-keep" />);
    expect(within(firstCard()).getByText('ריכוז שלוש חשבוניות')).toBeInTheDocument();
  });

  it('still hides a priority 1-2 column on both bodies when it is unticked', () => {
    render(<DataTable rows={rows} columns={columns} columnPicker="spec-mobile-hide" />);
    openSheet();
    fireEvent.click(screen.getByRole('checkbox', { name: 'סכום' }));
    expect(within(firstCard()).queryByText('100')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'סכום' })).not.toBeInTheDocument();
    expect(localStorage.getItem('sf.columns.spec-mobile-hide')).toBe(JSON.stringify(['amount']));
  });
});

describe('desktop is unchanged by the mobile rule (RTL-A11Y-02 regression guard)', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewport(() => true);
  });
  afterEach(() => Reflect.deleteProperty(window, 'matchMedia'));

  it('shows every column in the table and reports them all as on', () => {
    render(<DataTable rows={rows} columns={columns} columnPicker="spec-desktop" />);
    for (const header of ['שם', 'סכום', 'הערות']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'עמודות' }));
    // On desktop `priority` says nothing at all — the table shows the column, so the box is ticked.
    expect(screen.getByRole('checkbox', { name: 'הערות' })).toBeChecked();
  });
});
