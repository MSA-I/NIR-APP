import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  DataTable,
  type Column,
  type ServerColumn,
  type DataTableServer,
  type DataTableProps,
} from './ui';

interface Row {
  id: string;
  name: string;
  amount: number;
}

const makeRows = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `שורה ${i}`, amount: i }));

const clientColumns: Column<Row>[] = [
  { key: 'name', header: 'שם', render: (r) => r.name, sortValue: (r) => r.name },
  { key: 'amount', header: 'סכום', render: (r) => String(r.amount), sortValue: (r) => r.amount },
];

const serverColumns: ServerColumn<Row>[] = [
  { key: 'name', header: 'שם', render: (r) => r.name },
  { key: 'amount', header: 'סכום', render: (r) => String(r.amount) },
];

const makeServer = (over: Partial<DataTableServer> = {}): DataTableServer => ({
  total: 60,
  page: 1,
  pageSize: 15,
  onPageChange: vi.fn(),
  sort: null,
  onSortChange: vi.fn(),
  sortableColumns: new Set(['amount']),
  fetching: false,
  ...over,
});

const firstBodyRowText = (container: HTMLElement) =>
  container.querySelector('tbody tr')?.textContent ?? '';

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('DataTable — server-mode type exclusion (compile-time, enforced by tsc in build)', () => {
  // These consts exist to host @ts-expect-error directives: if the discriminated union ever
  // stops rejecting client-side processing props in server mode, `tsc --noEmit` fails the build.
  it('keeps the invalid shapes referenced so the compile-time cases stay in the program', () => {
    // @ts-expect-error -- searchFn cannot be passed in server mode: it would filter one page
    const badSearchFn: DataTableProps<Row> = {
      rows: [],
      columns: serverColumns,
      server: makeServer(),
      searchFn: (row: Row, q: string) => row.name.includes(q),
    };
    // @ts-expect-error -- pageSize comes only from server.pageSize in server mode
    const badPageSize: DataTableProps<Row> = {
      rows: [],
      columns: serverColumns,
      server: makeServer(),
      pageSize: 20,
    };
    const badColumns: ServerColumn<Row>[] = [
      // @ts-expect-error -- sortValue cannot exist on a server-mode column
      { key: 'name', header: 'שם', render: (r: Row) => r.name, sortValue: (r: Row) => r.amount },
    ];
    // A valid server shape must keep compiling without directives.
    const good: DataTableProps<Row> = { rows: [], columns: serverColumns, server: makeServer() };
    expect(badSearchFn).toBeDefined();
    expect(badPageSize).toBeDefined();
    expect(badColumns).toBeDefined();
    expect(good).toBeDefined();
  });
});

describe('DataTable — client mode', () => {
  it('resets to the first page when the sort changes (the ui.tsx:612 bug)', () => {
    const { container } = render(<DataTable rows={makeRows(25)} columns={clientColumns} />);
    fireEvent.click(screen.getByRole('button', { name: 'הבא' }));
    expect(screen.getByText('2 / 2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'סכום' }));
    // Back on page 1 of the sorted result — not page 2 of the old order.
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
    expect(firstBodyRowText(container)).toContain('שורה 0');
  });

  it('sorts ascending then descending with the caller comparator', () => {
    const rows: Row[] = [
      { id: '1', name: 'בבב', amount: 2 },
      { id: '2', name: 'אאא', amount: 1 },
      { id: '3', name: 'גגג', amount: 3 },
    ];
    const { container } = render(<DataTable rows={rows} columns={clientColumns} />);
    expect(firstBodyRowText(container)).toContain('בבב'); // given order until asked

    const sortByName = screen.getByRole('button', { name: /שם/ });
    fireEvent.click(sortByName);
    expect(firstBodyRowText(container)).toContain('אאא');
    expect(container.querySelector('th[aria-sort="ascending"]')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /שם/ }));
    expect(firstBodyRowText(container)).toContain('גגג');
    expect(container.querySelector('th[aria-sort="descending"]')).toBeTruthy();
  });

  it('renders the record counter unconditionally, as a polite live region', () => {
    render(<DataTable rows={makeRows(3)} columns={clientColumns} />);
    // A single page — the old component hid the counter here.
    const counter = screen.getByText('3 רשומות');
    expect(counter).toHaveAttribute('aria-live', 'polite');
  });

  it('counts the filtered total, not the page', () => {
    render(
      <DataTable rows={makeRows(25)} columns={clientColumns} searchable
        searchFn={(r, q) => r.name.includes(q)} />,
    );
    expect(screen.getByText('25 רשומות')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'חיפוש בטבלה' }), { target: { value: 'שורה 1' } });
    // 'שורה 1' plus 'שורה 10'..'שורה 19' — 11 matches across pages, counted in full.
    expect(screen.getByText('11 רשומות')).toBeInTheDocument();
  });

  it('separates filtered-empty from no-data, and "נקה סינון" recovers', () => {
    render(
      <DataTable rows={makeRows(3)} columns={clientColumns} searchable
        searchFn={(r, q) => r.name.includes(q)} emptyTitle="אין נתונים להצגה" />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'חיפוש בטבלה' }), { target: { value: 'xyz' } });
    expect(screen.getByText('אין תוצאות לסינון הנוכחי')).toBeInTheDocument();
    expect(screen.queryByText('אין נתונים להצגה')).not.toBeInTheDocument();
    expect(screen.getByText('0 רשומות')).toBeInTheDocument(); // a true, measured zero

    fireEvent.click(screen.getByRole('button', { name: 'נקה סינון' }));
    expect(screen.getByText('3 רשומות')).toBeInTheDocument();
  });

  it('shows plain no-data only when nothing is filtered', () => {
    render(<DataTable rows={[]} columns={clientColumns} emptyTitle="אין נתונים להצגה"
      emptyAction={<button type="button">הוספה</button>} />);
    expect(screen.getByText('אין נתונים להצגה')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'הוספה' })).toBeInTheDocument();
    expect(screen.queryByText('אין תוצאות לסינון הנוכחי')).not.toBeInTheDocument();
  });

  it('an error result never falls through to EmptyState (B30)', () => {
    render(
      <DataTable rows={[]} columns={clientColumns} error="אירעה שגיאה בטעינת הנתונים"
        emptyTitle="אין נתונים להצגה" />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('אירעה שגיאה בטעינת הנתונים');
    expect(screen.queryByText('אין נתונים להצגה')).not.toBeInTheDocument();
    // No invented count either: an errored list has no number to claim.
    expect(screen.queryByText(/רשומות/)).not.toBeInTheDocument();
  });

  it('keeps the first-cell open button aria-label template', () => {
    render(
      <DataTable rows={makeRows(2)} columns={clientColumns}
        onRowClick={() => {}} rowLabel={(r) => `חשבונית ${r.name}`} />,
    );
    expect(screen.getAllByRole('button', { name: 'פתיחת חשבונית שורה 0' }).length).toBeGreaterThan(0);
  });
});

describe('DataTable — server mode', () => {
  it('never slices, filters or sorts: it renders exactly the rows it was handed', () => {
    const server = makeServer({ total: 60, pageSize: 15 });
    const { container } = render(
      // 20 rows against pageSize 15: a client table would slice to 15. Server mode must not.
      <DataTable rows={makeRows(20)} columns={serverColumns} server={server} />,
    );
    expect(container.querySelectorAll('tbody tr').length).toBe(20);
    expect(firstBodyRowText(container)).toContain('שורה 0'); // given order, untouched
  });

  it('shows the server total in the counter — never the page length', () => {
    render(<DataTable rows={makeRows(15)} columns={serverColumns} server={makeServer({ total: 60 })} />);
    expect(screen.getByText('60 רשומות')).toBeInTheDocument();
    expect(screen.queryByText('15 רשומות')).not.toBeInTheDocument();
  });

  it('pages via onPageChange with server arithmetic', () => {
    const server = makeServer({ total: 60, page: 1, pageSize: 15 });
    render(<DataTable rows={makeRows(15)} columns={serverColumns} server={server} />);
    expect(screen.getByText('2 / 4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'הבא' }));
    expect(server.onPageChange).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'הקודם' }));
    expect(server.onPageChange).toHaveBeenCalledWith(0);
  });

  it('only sortableColumns get sort buttons; a click reports, it does not reorder', () => {
    const server = makeServer({ sortableColumns: new Set(['amount']) });
    const { container } = render(<DataTable rows={makeRows(3)} columns={serverColumns} server={server} />);
    expect(screen.queryByRole('button', { name: 'שם' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'סכום' }));
    expect(server.onSortChange).toHaveBeenCalledWith([{ column: 'amount', ascending: true }]);
    // The page the server sent stays exactly as sent.
    expect(firstBodyRowText(container)).toContain('שורה 0');
  });

  it('flips direction on the active column and exposes aria-sort', () => {
    const server = makeServer({ sort: [{ column: 'amount', ascending: true }] });
    const { container } = render(<DataTable rows={makeRows(3)} columns={serverColumns} server={server} />);
    expect(container.querySelector('th[aria-sort="ascending"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /סכום/ }));
    expect(server.onSortChange).toHaveBeenCalledWith([{ column: 'amount', ascending: false }]);
  });

  it('debounces the search box and emits only the settled value', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(
      <DataTable rows={makeRows(3)} columns={serverColumns}
        server={makeServer({ search: { value: '', onChange } })} />,
    );
    const input = screen.getByRole('textbox', { name: 'חיפוש בטבלה' });
    fireEvent.change(input, { target: { value: 'א' } });
    fireEvent.change(input, { target: { value: 'אב' } });
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled(); // every keystroke would pay a filtered COUNT
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('אב');
  });

  it('fetching shows a subtle busy indication without blanking the rows', () => {
    const { container } = render(
      <DataTable rows={makeRows(5)} columns={serverColumns} server={makeServer({ fetching: true })} />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelectorAll('tbody tr').length).toBe(5);
  });

  it('filtered-empty in server mode clears both the search it owns and the screen filters', () => {
    const onChange = vi.fn();
    const onClearFilters = vi.fn();
    render(
      <DataTable rows={[]} columns={serverColumns}
        server={makeServer({ total: 0, search: { value: 'חיפוש ישן', onChange } })}
        activeFilters={2} onClearFilters={onClearFilters} />,
    );
    expect(screen.getByText('אין תוצאות לסינון הנוכחי')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'נקה סינון' })[0]);
    expect(onChange).toHaveBeenCalledWith('');
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});

describe('DataTable — column picker (OPEN-DECISIONS #80)', () => {
  it('hides a column, persists the choice per screen, and reads it back', () => {
    const { unmount } = render(
      <DataTable rows={makeRows(3)} columns={clientColumns} columnPicker="spec-screen" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'עמודות' }));
    expect(screen.getByRole('dialog', { name: 'בחירת עמודות' })).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: 'סכום' });
    expect(screen.getByRole('checkbox', { name: 'שם' })).toHaveFocus();
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);

    expect(screen.queryByRole('columnheader', { name: 'סכום' })).not.toBeInTheDocument();
    expect(localStorage.getItem('sf.columns.spec-screen')).toBe(JSON.stringify(['amount']));
    unmount();

    // A fresh mount of the same screen reads the stored preference back.
    render(<DataTable rows={makeRows(3)} columns={clientColumns} columnPicker="spec-screen" />);
    expect(screen.queryByRole('columnheader', { name: 'סכום' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'שם' })).toBeInTheDocument();
  });

  it('refuses to hide the last visible column', () => {
    render(<DataTable rows={makeRows(3)} columns={clientColumns} columnPicker="spec-last" />);
    fireEvent.click(screen.getByRole('button', { name: 'עמודות' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'סכום' }));
    // Only 'שם' is left — its checkbox must be disabled so zero columns is unreachable.
    expect(screen.getByRole('checkbox', { name: 'שם' })).toBeDisabled();
  });
});

/**
 * The phone is where filtering was unreachable, and the two causes were independent.
 *
 * 1. The sheet was gated on `server || columnPicker`. Nine screens — orders, suppliers, credits,
 *    payment requests, exceptions, products, inventory, price lists, documents — pass only
 *    `toolbar` and `activeFilters`, so they took the legacy branch that renders the toolbar
 *    inline at every width and has no sheet at all.
 * 2. The sheet swapped at `md` while the body swapped at `lg`, so 768–1023px lost it too.
 *
 * jsdom has no matchMedia and `useMediaQuery` then answers desktop, so a phone must be stated.
 */
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

describe('DataTable — mobile filter sheet', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  const phone = () => setViewport(() => false);
  const tablet = () => setViewport((q) => !q.includes('64rem'));

  it('offers the sheet to a screen that passes only toolbar and activeFilters', () => {
    phone();
    render(
      <DataTable rows={makeRows(3)} columns={clientColumns} activeFilters={1}
        onClearFilters={() => {}}
        toolbar={<select aria-label="סינון לפי סטטוס"><option>הכל</option></select>} />,
    );
    const trigger = screen.getByRole('button', { name: /סינון ותצוגה/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    // The count travels with the trigger — that is the only place it shows on a phone.
    expect(trigger).toHaveTextContent('1');
    // The toolbar is mounted in exactly one place at a time, so its ids cannot duplicate.
    expect(screen.queryByLabelText('סינון לפי סטטוס')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'סינון ותצוגה' })).toBeInTheDocument();
    expect(screen.getByLabelText('סינון לפי סטטוס')).toBeInTheDocument();
  });

  it('still offers the sheet at tablet width, where the body is still cards', () => {
    tablet();
    render(
      <DataTable rows={makeRows(3)} columns={clientColumns}
        toolbar={<select aria-label="סינון לפי סטטוס"><option>הכל</option></select>} />,
    );
    expect(screen.getByRole('button', { name: /סינון ותצוגה/ })).toBeInTheDocument();
  });

  it('keeps the toolbar inline on desktop and shows no sheet trigger', () => {
    setViewport(() => true);
    render(
      <DataTable rows={makeRows(3)} columns={clientColumns}
        toolbar={<select aria-label="סינון לפי סטטוס"><option>הכל</option></select>} />,
    );
    expect(screen.getByLabelText('סינון לפי סטטוס')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /סינון ותצוגה/ })).not.toBeInTheDocument();
  });
});
