/**
 * PR 31a — `DASH-07`: the products report's billed columns are empty for every product, and the
 * screen does not say why.
 *
 * THE MEASUREMENT CAME FIRST, and it changed what this file asserts. The finding's headline said
 * the report "produces no cost at all". Measured against live production on 2026-09-05, that is
 * false: `עלות לפי ההזמנה` carries a figure on **115 of 115** products, ₪182,208.210 for the
 * window the sweep used, and not one of them is zero. What is empty is the BILLED half —
 * `חויב`, `הוצאה` and `מחיר יחידה ממוצע` — and the cause is not a join, a predicate, a window or
 * an org filter. It is that `public.invoice_lines` and `public.invoice_line_matches` hold
 * **zero rows across all five organisations in production**. The rows the money is computed from
 * do not exist.
 *
 * So this is a data disposition, and the defect is the DISPLAY: 115 em dashes with no sentence.
 *
 * AND THE SCREEN'S ONE IDIOM FOR SAYING WHY CANNOT FIRE HERE. `unmapped_invoice_lines > 0` guards
 * the only explanatory note this report has, and that count reads the same empty table the empty
 * columns read: no invoice lines means no unmapped invoice lines. The note can appear only when
 * SOME lines exist and are unmatched — never in the state that empties the column completely.
 * That is the hole, and it is what this file pins.
 *
 * BOTH SURFACES, from one predicate. The finding's evidence names the exported file as well as the
 * screen — 115 rows with `הוצאה ברוטו` blank in every one — so the sentence rides row 2 of the
 * sheet, which is where `EXP-06` established that a sheet states what it holds. The file is read
 * back from its own bytes, never from the builder's inputs, for the reason `EXP-04` existed.
 *
 * The controls are as load-bearing as the claim. Three of them pass on the unfixed tree and must
 * keep passing: the empty cells are `—` and never `0`; the committed cost is stated on every row;
 * and the new sentence stays away — on the screen AND in the file — both when a product HAS been
 * billed and when the existing unmapped note is the right one to show. A note that always renders
 * would satisfy the claim and fail the controls.
 *
 * Every assertion is PER ROW, and per sheet. "Three columns are empty on 115 rows" is not a count.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import * as XLSX from 'xlsx';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u-1', role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { id: 'org-1', name: 'ארגון הבדיקה', settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import ProductPurchaseSummary from './ProductPurchaseSummary';

/** The window the sweep used, and the window the production measurement was taken over. */
const WINDOW = { from: '2026-01-01', to: '2026-09-04' };

type Row = Record<string, unknown>;

/**
 * A product in exactly the shape production returns today: ordered and (sometimes) received, a
 * committed cost from the order snapshot, and NOTHING on the billed side — nulls, never zeros,
 * because the server's own `case when invoice_count > 0` guard refuses to fabricate a zero.
 */
function billedNothing(id: string, name: string, committed: number, received: number | null): Row {
  return {
    product_id: id, product_name: name, unit: 'kg',
    ordered_qty: 10, received_qty: received, invoiced_qty: null,
    canonical_qty: received ?? 0,
    supplier_count: 1, order_count: 1, invoice_count: 0,
    gross_amount_by_currency: null,
    ordered_amount_by_currency: [{ currency: 'ILS', amount: committed }],
    average_unit_price: null, average_unit_price_currency: null,
    spans_currencies: false,
    includes_invoice_only_quantity: false,
    includes_unevidenced_quantity: received === null,
  };
}

/** A product somebody HAS billed. Its presence is what must silence the new sentence. */
function billed(id: string, name: string): Row {
  return {
    product_id: id, product_name: name, unit: 'kg',
    ordered_qty: 10, received_qty: 10, invoiced_qty: 10, canonical_qty: 10,
    supplier_count: 1, order_count: 1, invoice_count: 1,
    gross_amount_by_currency: [{ currency: 'ILS', amount: 120.5 }],
    ordered_amount_by_currency: [{ currency: 'ILS', amount: 118 }],
    average_unit_price: 12.05, average_unit_price_currency: 'ILS',
    spans_currencies: false,
    includes_invoice_only_quantity: false, includes_unevidenced_quantity: false,
  };
}

/** Production's own shape for the state DASH-07 measured, scaled down to five readable rows. */
const NOTHING_BILLED: Row[] = [
  billedNothing('p-1', 'מזלג ורסאי', 2211, null),
  billedNothing('p-2', 'נייר טואלט', 108, null),
  billedNothing('p-3', 'מטאטא', 31.9, 3),
  billedNothing('p-4', 'תה עטוף', 154, 2.5),
  billedNothing('p-5', 'סבון לדיספנסר', 64000, null),
];

function productsTraffic(products: Row[], unmappedLines: number) {
  return [
    http.post(`${SUPABASE_URL}/rest/v1/rpc/get_product_purchase_summary`, async ({ request }) => {
      const body = await request.json() as { p_from: string; p_to: string };
      return HttpResponse.json({
        from: body.p_from, to: body.p_to, products,
        unmapped_invoice_lines: unmappedLines,
        unmapped_invoice_amount_by_currency: unmappedLines > 0
          ? [{ currency: 'ILS', amount: 480 }] : [],
        quantity_rule: 'completed_receipt_else_approved_invoice_never_both',
      });
    }),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_export_report_template`, () =>
      HttpResponse.json({ found: false, export_key: 'product_purchase_summary' })),
  ];
}

function renderScreen() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <LocaleProvider initialLocale="he">
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-1">
          <ToastProvider>
            <MemoryRouter initialEntries={[`/reports/products?from=${WINDOW.from}&to=${WINDOW.to}`]}>
              {children}
            </MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>
    </LocaleProvider>
  );
  render(<ProductPurchaseSummary />, { wrapper: Wrapper });
}

/** Column index by its own header text, so a re-order cannot make an assertion read the wrong cell. */
function columnIndex(header: string): number {
  const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent?.trim() ?? '');
  const index = headers.findIndex((text) => text.includes(header));
  expect(index, `column "${header}" is on the screen`).toBeGreaterThanOrEqual(0);
  return index;
}

/** Every data row's cell under one column header — the surface every claim below is made over. */
function cellsUnder(header: string): { product: string; text: string }[] {
  const index = columnIndex(header);
  const table = screen.getByRole('table');
  const body = table.querySelector('tbody');
  const rows = body ? [...body.querySelectorAll('tr')] : [];
  return rows.map((row) => {
    const cells = [...row.querySelectorAll('td')];
    return {
      product: cells[0]?.textContent?.trim() ?? '',
      text: cells[index]?.textContent?.trim() ?? '',
    };
  });
}

const SENTENCE = /לא נמצאה אף שורת חשבונית/;

/** Every file handed to the browser, and the bytes behind it. */
const downloads: { fileName: string; bytes: Uint8Array }[] = [];
let pendingBlob: Blob | null = null;
const capture: Promise<void>[] = [];

/** The one file this screen produced, reopened from its own bytes rather than from the inputs. */
async function exportedWorkbook() {
  await waitFor(() => expect(capture.length + downloads.length).toBeGreaterThan(0), { timeout: 5_000 });
  await Promise.all(capture.splice(0));
  expect(downloads).toHaveLength(1);
  return XLSX.read(downloads[0]!.bytes, { type: 'array' });
}

beforeEach(() => {
  server.use(...productsTraffic(NOTHING_BILLED, 0));
  downloads.length = 0;
  capture.length = 0;
  pendingBlob = null;
  // jsdom implements neither half of the hand-over, so both are stood up here — and the file is
  // then read back from the very bytes the product put in the blob.
  URL.createObjectURL = vi.fn((blob: Blob) => {
    pendingBlob = blob;
    return 'blob:export';
  }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  const nativeClick = HTMLAnchorElement.prototype.click;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    if (this.download && pendingBlob) {
      const blob = pendingBlob;
      const fileName = this.download;
      capture.push(blob.arrayBuffer().then((buffer) => {
        downloads.push({ fileName, bytes: new Uint8Array(buffer) });
      }));
      pendingBlob = null;
      return;
    }
    nativeClick.call(this);
  });
});

describe('DASH-07 — every billed column is empty and the screen says why', () => {
  it('states, once, that no approved invoice line reached any product in this window', async () => {
    renderScreen();
    await screen.findByRole('table');
    await waitFor(() => expect(cellsUnder('מוצר')).toHaveLength(NOTHING_BILLED.length));

    // THE CLAIM. Before the fix there is no such sentence anywhere on the screen: the only note
    // the report can produce is guarded by `unmapped_invoice_lines > 0`, which is 0 here for the
    // same reason the columns are empty.
    const notes = await screen.findAllByRole('status');
    const explaining = notes.filter((note) => SENTENCE.test(note.textContent ?? ''));
    expect(explaining, 'exactly one note explains the empty billed columns').toHaveLength(1);

    // It names the three columns it is explaining, so a reader knows which em dashes it covers,
    // and it names the column that DOES carry a figure, so the screen is not read as costless.
    const text = explaining[0]!.textContent ?? '';
    for (const column of ['חויב', 'הוצאה', 'מחיר יחידה ממוצע', 'עלות לפי ההזמנה']) {
      expect(text, `the sentence names "${column}"`).toContain(column);
    }
    // "Not zero — not yet known." The distinction this whole report is built on.
    expect(text).toMatch(/אינו אפס|אינה אפס|לא אפס/);
  });

  it('CONTROL — the empty cells are em dashes, per row, and never a zero', async () => {
    renderScreen();
    await screen.findByRole('table');
    await waitFor(() => expect(cellsUnder('מוצר')).toHaveLength(NOTHING_BILLED.length));

    for (const header of ['חויב', 'הוצאה', 'מחיר יחידה ממוצע']) {
      for (const cell of cellsUnder(header)) {
        expect(cell.text, `${cell.product} · ${header}`).toBe('—');
      }
    }
  });

  it('CONTROL — the committed cost is stated on every one of those same rows', async () => {
    renderScreen();
    await screen.findByRole('table');
    await waitFor(() => expect(cellsUnder('מוצר')).toHaveLength(NOTHING_BILLED.length));

    const committed = cellsUnder('עלות לפי ההזמנה');
    expect(committed).toHaveLength(NOTHING_BILLED.length);
    for (const cell of committed) {
      expect(cell.text, `${cell.product} · committed cost`).not.toBe('—');
      expect(cell.text, `${cell.product} · committed cost`).toMatch(/\d/);
    }
  });
});

describe('DASH-07 — the sentence stays away when it would be false', () => {
  it('CONTROL — a window in which one product HAS been billed shows no such note', async () => {
    server.use(...productsTraffic([...NOTHING_BILLED, billed('p-9', 'קמח לבן')], 0));
    renderScreen();
    await screen.findByRole('table');
    await waitFor(() => expect(cellsUnder('מוצר')).toHaveLength(NOTHING_BILLED.length + 1));

    // Per row, not by count: the billed product carries a figure and the others still carry `—`.
    const spend = cellsUnder('הוצאה');
    const forBilled = spend.find((cell) => cell.product.includes('קמח לבן'));
    expect(forBilled?.text).toMatch(/\d/);
    for (const cell of spend.filter((entry) => !entry.product.includes('קמח לבן'))) {
      expect(cell.text, `${cell.product} · הוצאה`).toBe('—');
    }
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it('CONTROL — unmatched lines exist, so the report\'s own unmapped note is the right one', async () => {
    server.use(...productsTraffic(NOTHING_BILLED, 3));
    renderScreen();
    await screen.findByRole('table');
    await waitFor(() => expect(cellsUnder('מוצר')).toHaveLength(NOTHING_BILLED.length));

    const notes = await screen.findAllByRole('status');
    expect(notes.some((note) => /לא שויכו/.test(note.textContent ?? ''))).toBe(true);
    // Two notes answering the same question at once is how a screen stops being read at all.
    expect(notes.some((note) => SENTENCE.test(note.textContent ?? ''))).toBe(false);
  });

  it('CONTROL — an empty window says it is empty and claims nothing about billing', async () => {
    server.use(...productsTraffic([], 0));
    renderScreen();

    expect(await screen.findByText('אין רכישות בטווח שנבחר')).toBeInTheDocument();
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });
});

describe('DASH-07 — the file says it too', () => {
  it('states the absence on row 2, beside the window, and keeps the window', async () => {
    renderScreen();
    await screen.findByRole('table');
    await waitFor(() => expect(cellsUnder('מוצר')).toHaveLength(NOTHING_BILLED.length));
    await userEvent.click(await screen.findByRole('button', { name: 'ייצוא Excel' }));
    const book = await exportedWorkbook();

    expect(book.SheetNames.length).toBeGreaterThan(0);
    for (const name of book.SheetNames) {
      const banner = String(book.Sheets[name]!['A2']?.v ?? '');
      // The window assertion is why row 2 exists (`EXP-06`) and must survive the addition.
      expect(banner, `${name} · window`).toContain('01.01.2026');
      expect(banner, `${name} · window`).toContain('04.09.2026');
      expect(banner, `${name} · the absence`).toMatch(SENTENCE);
    }
  });

  it('CONTROL — a file with a billed product carries no such banner', async () => {
    server.use(...productsTraffic([...NOTHING_BILLED, billed('p-9', 'קמח לבן')], 0));
    renderScreen();
    await screen.findByRole('table');
    await waitFor(() => expect(cellsUnder('מוצר')).toHaveLength(NOTHING_BILLED.length + 1));
    await userEvent.click(await screen.findByRole('button', { name: 'ייצוא Excel' }));
    const book = await exportedWorkbook();

    for (const name of book.SheetNames) {
      const banner = String(book.Sheets[name]!['A2']?.v ?? '');
      expect(banner, `${name} · window`).toContain('01.01.2026');
      expect(banner, `${name} · the absence`).not.toMatch(SENTENCE);
    }
  });
});

describe('DASH-07 — the note is reachable by a screen reader', () => {
  it('is announced, not merely painted', async () => {
    renderScreen();
    await screen.findByRole('table');
    await waitFor(() => expect(cellsUnder('מוצר')).toHaveLength(NOTHING_BILLED.length));

    const notes = await screen.findAllByRole('status');
    const explaining = notes.find((note) => SENTENCE.test(note.textContent ?? ''));
    expect(explaining).toBeDefined();
    expect(within(explaining!).getByText(SENTENCE)).toBeInTheDocument();
  });
});
