/**
 * PR 31 — the month that travels (`DASH-08`, `EXP-02`).
 *
 * A manager closes July on `/reports`, follows the one link that leaves that page — 'סיכום רכישות
 * מוצרים' — and lands on a screen showing September, then exports a September file from it. Two
 * halves, and neither is enough on its own: `Reports.tsx` linked to `/reports/products` with no
 * window at all, and `ProductPurchaseSummary.tsx` held its window in component state, so it could
 * not have accepted one even if the link had offered it — the sweep proved that half separately by
 * navigating straight to `?from=2020-01-01&to=2020-01-31` and still getting 2026-09.
 *
 * So this file pins three things, in the order a person meets them:
 *
 *   1. the link a July report hands you carries July;
 *   2. the screen you arrive at reads its window from the URL — asked for January 2020 it queries
 *      January 2020 and prints January 2020, which no clock can make accidentally true;
 *   3. the file that leaves that screen is that same window's file — its NAME, the window every
 *      sheet states in its own subtitle, and the rows inside it.
 *
 * The workbook is not asserted from the builder's inputs. It is written to bytes, reopened with
 * the reader an accountant's Excel stands in for, and read — including a sweep for `#REF!`,
 * `#DIV/0!`, `#VALUE!` and `#NAME?`, because a file that states the right window and computes an
 * error inside it has not been exported successfully.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

import Reports from './Reports';
import ProductPurchaseSummary from './ProductPurchaseSummary';

/** The window a July report is closing. Inclusive at both ends, the way a person reads a month. */
const JULY = { from: '2026-07-01', to: '2026-07-31' };
/**
 * A window no clock can make accidentally true. `JULY` alone would pass in July 2026 for the wrong
 * reason, so the arrival screen is also asked for a month six years behind the current one.
 */
const LONG_AGO = { from: '2020-01-01', to: '2020-01-31' };

/** Every window the products RPC was actually asked for, in order. */
const rpcWindows: { p_from: string; p_to: string }[] = [];
/** Every file handed to the browser: its name and the bytes behind it. */
const downloads: { fileName: string; bytes: Uint8Array }[] = [];
/** A blob in flight between `URL.createObjectURL` and the anchor click that names it. */
let pendingBlob: Blob | null = null;
const capture: Promise<void>[] = [];

const PRODUCTS = [
  {
    product_id: 'p-1', product_name: 'קמח לבן', unit: 'kg',
    ordered_qty: 10, received_qty: 10, invoiced_qty: 10, canonical_qty: 10,
    supplier_count: 1, order_count: 1, invoice_count: 1,
    gross_amount_by_currency: [{ currency: 'ILS', amount: 120.5 }],
    ordered_amount_by_currency: [{ currency: 'ILS', amount: 118 }],
    average_unit_price: 12.05, average_unit_price_currency: 'ILS',
    spans_currencies: false,
    includes_invoice_only_quantity: false, includes_unevidenced_quantity: false,
  },
  {
    // Bought in two currencies. The export must state both figures side by side and never add
    // them — the wave's currency rule, guarded here so this change cannot quietly break it.
    product_id: 'p-2', product_name: 'שמן זית', unit: 'l',
    ordered_qty: 4, received_qty: 4, invoiced_qty: 4, canonical_qty: 4,
    supplier_count: 2, order_count: 2, invoice_count: 2,
    gross_amount_by_currency: [
      { currency: 'ILS', amount: 200 },
      { currency: 'USD', amount: 50 },
    ],
    ordered_amount_by_currency: [{ currency: 'ILS', amount: 195 }],
    average_unit_price: null, average_unit_price_currency: null,
    spans_currencies: true,
    includes_invoice_only_quantity: false, includes_unevidenced_quantity: false,
  },
];

/** The products RPC, echoing back the window it was asked for — as the server does. */
const productsTraffic = () => [
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_product_purchase_summary`, async ({ request }) => {
    const body = await request.json() as { p_from: string; p_to: string };
    rpcWindows.push({ p_from: body.p_from, p_to: body.p_to });
    return HttpResponse.json({
      from: body.p_from, to: body.p_to, products: PRODUCTS,
      unmapped_invoice_lines: 0, unmapped_invoice_amount_by_currency: [],
      quantity_rule: 'receipt_over_invoice',
    });
  }),
  // No tenant template is configured, so the screen writes its own styled workbook.
  http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_export_report_template`, () =>
    HttpResponse.json({ found: false, export_key: 'product_purchase_summary' })),
];

/** An empty but healthy month, so `/reports` renders its page rather than its error note. */
const reportsTraffic = () => [
  http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([])),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/read_monthly_report_legal_entities`, () =>
    HttpResponse.json([])),
];

function renderAt(node: ReactNode, path: string) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <LocaleProvider initialLocale="he">
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-1">
          <ToastProvider>
            <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>
    </LocaleProvider>
  );
  render(<>{node}</>, { wrapper: Wrapper });
}

beforeEach(() => {
  rpcWindows.length = 0;
  downloads.length = 0;
  capture.length = 0;
  pendingBlob = null;
  // jsdom implements neither half of the hand-over, so both are stood up here — and the file is
  // then read back from the very bytes the product put in the blob, never from the builder input.
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

/** The one file this screen produced, reopened from its own bytes. */
async function exportedWorkbook() {
  await waitFor(() => expect(capture.length + downloads.length).toBeGreaterThan(0), { timeout: 3_000 });
  await Promise.all(capture.splice(0));
  expect(downloads).toHaveLength(1);
  const file = downloads[0]!;
  return { fileName: file.fileName, book: XLSX.read(file.bytes, { type: 'array' }) };
}

/** Every cell value in a workbook, as strings — the sweep surface for formula errors. */
function everyCell(book: XLSX.WorkBook): string[] {
  return book.SheetNames.flatMap((name) => {
    const sheet = book.Sheets[name]!;
    return Object.entries(sheet)
      .filter(([address]) => !address.startsWith('!'))
      .map(([, cell]) => String((cell as XLSX.CellObject).w ?? (cell as XLSX.CellObject).v ?? ''));
  });
}

const FORMULA_ERRORS = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NULL!', '#NUM!'];

describe('DASH-08 — the link a July report hands you', () => {
  it('carries July, the way every other tile on that page does', async () => {
    server.use(...reportsTraffic());
    renderAt(<Reports />, '/reports?month=2026-07');

    const link = await screen.findByRole('link', { name: /סיכום רכישות מוצרים/ });
    expect(link).toHaveAttribute('href', `/reports/products?from=${JULY.from}&to=${JULY.to}`);
  });
});

describe('DASH-08 — the screen you arrive at', () => {
  it('reads its window from the URL instead of resetting to the current month', async () => {
    server.use(...productsTraffic());
    renderAt(<ProductPurchaseSummary />, `/reports/products?from=${LONG_AGO.from}&to=${LONG_AGO.to}`);

    expect(await screen.findByLabelText('מתאריך')).toHaveValue(LONG_AGO.from);
    expect(screen.getByLabelText('עד תאריך')).toHaveValue(LONG_AGO.to);
    await waitFor(
      () => expect(rpcWindows).toContainEqual({ p_from: LONG_AGO.from, p_to: LONG_AGO.to }),
      { timeout: 3_000 },
    );
    // Not merely "January was asked for at some point" — no other window was.
    expect(rpcWindows.every((asked) => asked.p_from === LONG_AGO.from && asked.p_to === LONG_AGO.to)).toBe(true);
    expect(await screen.findByText(`2 מוצרים · ${LONG_AGO.from} עד ${LONG_AGO.to}`)).toBeInTheDocument();
  });
});

describe('EXP-02 — the file that leaves that screen', () => {
  it('is named for the window on screen, and every sheet states that window', async () => {
    server.use(...productsTraffic());
    renderAt(<ProductPurchaseSummary />, `/reports/products?from=${JULY.from}&to=${JULY.to}`);

    expect(await screen.findByLabelText('מתאריך')).toHaveValue(JULY.from);
    await userEvent.click(await screen.findByRole('button', { name: 'ייצוא Excel' }));
    const { fileName, book } = await exportedWorkbook();

    expect(fileName).toBe(`product-purchases-${JULY.from}-${JULY.to}.xlsx`);
    // Row 2 of every sheet is the subtitle the builder writes. A sheet that does not state its
    // own window is a sheet a reader has to take on trust.
    expect(book.SheetNames.length).toBeGreaterThan(0);
    for (const name of book.SheetNames) {
      const subtitle = String(book.Sheets[name]!['A2']?.v ?? '');
      expect(subtitle).toContain('01.07.2026');
      expect(subtitle).toContain('31.07.2026');
    }
  });

  it('carries the rows, adds no two currencies together, and computes no error', async () => {
    server.use(...productsTraffic());
    renderAt(<ProductPurchaseSummary />, `/reports/products?from=${JULY.from}&to=${JULY.to}`);

    expect(await screen.findByLabelText('מתאריך')).toHaveValue(JULY.from);
    await userEvent.click(await screen.findByRole('button', { name: 'ייצוא Excel' }));
    const { book } = await exportedWorkbook();

    const cells = everyCell(book);
    expect(cells).toContain('קמח לבן');
    expect(cells).toContain('שמן זית');
    // Two currencies, two figures, one cell that states both and sums neither.
    expect(cells.some((value) => value.includes('200') && value.includes('50'))).toBe(true);
    expect(cells.some((value) => value.trim() === '250' || value.trim() === '250.00')).toBe(false);

    for (const formulaError of FORMULA_ERRORS) {
      expect(cells.some((value) => value.includes(formulaError))).toBe(false);
    }
  });
});
