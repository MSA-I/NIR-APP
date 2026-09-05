/**
 * PR 33 — what a file says about itself when it leaves the building
 * (`EXP-04`, `EXP-07`, `EXP-10`; QA sweep 04.09.2026).
 *
 * Three defects, one shape: the screen knows something the file does not.
 *
 *   `EXP-04`  Every quantity on `/reports/products` carries a provenance caveat under the product's
 *             name — "part of this rests on the supplier's word", "some of these lines have not
 *             been visually confirmed". The caveat is attached in the screen component, so the
 *             twelve-column export dropped it entirely, and 74 of 115 rows went out asserting
 *             `נרכש בפועל 0` beside a blank `התקבל` and a blank `חויב`. A canonical quantity that
 *             no receipt and no approved invoice contributed to is not zero. It is unmeasured, and
 *             the constitution's rule about a fabricated zero is exactly this rule.
 *   `EXP-07`  The expenses workbook was named for the day it was produced; the PDF button beside
 *             it is named for the window. Two exports of different periods on the same day land on
 *             one filename and the second replaces the first.
 *   `EXP-10`  A product name beginning with `-` reached the file with an apostrophe in front of it.
 *             The neutralizer that puts it there is load-bearing for CSV, where a leading `=`/`-`
 *             really is a formula. An .xlsx shared string is not evaluated, so on this path the
 *             apostrophe was never protection — it was tenant data being edited on the way out.
 *
 * Nothing here is asserted from a builder's inputs. The screen is rendered, the button is clicked,
 * the bytes handed to the browser are captured and reopened with a second library — the harness
 * `reportsProductWindow.spec.tsx` established for `EXP-02` — and every sheet is swept for
 * `#REF!`, `#DIV/0!`, `#VALUE!` and `#NAME?` before any of it is called an export.
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

/** The PDF half of `EXP-07`: its name is the claim under test, never its rendering. */
const pdfDownloads: string[] = [];
vi.mock('../lib/pdf', () => ({
  downloadDocumentPdf: vi.fn(async (input: { fileName: string }) => {
    pdfDownloads.push(input.fileName);
  }),
}));

import ProductPurchaseSummary from './ProductPurchaseSummary';
import Expenses from './Expenses';

/** The window on screen for both exports. Neither end is today, on any day this suite runs. */
const WINDOW = { from: '2025-01-01', to: '2026-12-31' };

/** Every file handed to the browser: its name and the bytes behind it. */
const downloads: { fileName: string; bytes: Uint8Array }[] = [];
let pendingBlob: Blob | null = null;
const capture: Promise<void>[] = [];

/**
 * The three provenance states the server distinguishes, from `0221`'s `canonical_source`:
 * `completed_receipt`, `approved_invoice`, `not_yet_evidenced`. `received_qty` is null exactly
 * when no receipt row contributed and `invoiced_qty` exactly when no approved invoice line did —
 * so a row with both null is one whose every order item is `not_yet_evidenced`, and its
 * `canonical_qty` is a sum of zeros rather than a count of anything.
 */
const PRODUCTS = [
  {
    // Counted, in full, from completed receipts. The one row here that may state a number flatly.
    product_id: 'p-receipt', product_name: 'קמח לבן', unit: 'kg',
    ordered_qty: 10, received_qty: 10, invoiced_qty: 10, canonical_qty: 10,
    supplier_count: 1, order_count: 1, invoice_count: 1,
    gross_amount_by_currency: [{ currency: 'ILS', amount: 120.5 }],
    ordered_amount_by_currency: [{ currency: 'ILS', amount: 118 }],
    average_unit_price: 12.05, average_unit_price_currency: 'ILS',
    spans_currencies: false,
    includes_invoice_only_quantity: false, includes_unevidenced_quantity: false,
  },
  {
    // The supplier's word, with no receipt of our own behind it.
    product_id: 'p-invoice', product_name: 'שמן זית', unit: 'l',
    ordered_qty: 8, received_qty: null, invoiced_qty: 8, canonical_qty: 8,
    supplier_count: 1, order_count: 1, invoice_count: 1,
    gross_amount_by_currency: [
      { currency: 'ILS', amount: 200 },
      { currency: 'USD', amount: 50 },
    ],
    ordered_amount_by_currency: [{ currency: 'ILS', amount: 195 }],
    average_unit_price: null, average_unit_price_currency: null,
    spans_currencies: true,
    includes_invoice_only_quantity: true, includes_unevidenced_quantity: false,
  },
  {
    // THE 74 ROWS. Ordered, nothing received, nothing billed — and the file said "we purchased 0".
    product_id: 'p-unevidenced', product_name: 'סוכר חום', unit: 'kg',
    ordered_qty: 25, received_qty: null, invoiced_qty: null, canonical_qty: 0,
    supplier_count: 1, order_count: 1, invoice_count: 0,
    gross_amount_by_currency: null,
    ordered_amount_by_currency: [{ currency: 'ILS', amount: 300 }],
    average_unit_price: null, average_unit_price_currency: null,
    spans_currencies: false,
    includes_invoice_only_quantity: false, includes_unevidenced_quantity: true,
  },
  {
    // `EXP-10`, verbatim from the tenant's catalogue: a name whose first character is a hyphen.
    product_id: 'p-dash', product_name: '- ס 10מזלג ורסאי ניצוצות כסף -אר', unit: 'unit',
    ordered_qty: 4, received_qty: 4, invoiced_qty: 4, canonical_qty: 4,
    supplier_count: 1, order_count: 1, invoice_count: 1,
    gross_amount_by_currency: [{ currency: 'ILS', amount: 40 }],
    ordered_amount_by_currency: [{ currency: 'ILS', amount: 40 }],
    average_unit_price: 10, average_unit_price_currency: 'ILS',
    spans_currencies: false,
    includes_invoice_only_quantity: false, includes_unevidenced_quantity: false,
  },
];

const productsTraffic = () => [
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_product_purchase_summary`, async ({ request }) => {
    const body = await request.json() as { p_from: string; p_to: string };
    return HttpResponse.json({
      from: body.p_from, to: body.p_to, products: PRODUCTS,
      unmapped_invoice_lines: 0, unmapped_invoice_amount_by_currency: [],
      quantity_rule: 'completed_receipt_else_approved_invoice_never_both',
    });
  }),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_export_report_template`, () =>
    HttpResponse.json({ found: false, export_key: 'product_purchase_summary' })),
];

const INVOICES = [
  {
    id: 'i-1', invoice_number: 'A-1', invoice_date: '2026-03-04', total_amount: 1234.5,
    currency: 'ILS', payment_status: 'unpaid', supplier_id: 's-1',
  },
];

const expensesTraffic = () => [
  http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json(INVOICES)),
  http.get(`${SUPABASE_URL}/rest/v1/categories`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, () => HttpResponse.json([
    { id: 's-1', name: 'תבליני הגליל', tax_id: null, payment_terms: null, status: 'active', bank_details: null },
  ])),
  http.get(`${SUPABASE_URL}/rest/v1/invoice_order_links`, () => HttpResponse.json([])),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_purchase_metrics`, () => HttpResponse.json({
    committed_by_currency: [{ currency: 'ILS', amount: 1000 }],
    gross_expense_by_currency: [{ currency: 'ILS', amount: 1234.5 }],
    credits_recognised_by_currency: [{ currency: 'ILS', amount: 0 }],
    net_expense_by_currency: [{ currency: 'ILS', amount: 1234.5 }],
  })),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_export_report_template`, () =>
    HttpResponse.json({ found: false, export_key: 'owner_expense_summary' })),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/my_export_watermark`, () => HttpResponse.json(null)),
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
  downloads.length = 0;
  capture.length = 0;
  pdfDownloads.length = 0;
  pendingBlob = null;
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

/** The one file a screen produced, reopened from its own bytes. */
async function exportedWorkbook() {
  await waitFor(() => expect(capture.length + downloads.length).toBeGreaterThan(0), { timeout: 5_000 });
  await Promise.all(capture.splice(0));
  expect(downloads).toHaveLength(1);
  const file = downloads[0]!;
  return { fileName: file.fileName, book: XLSX.read(file.bytes, { type: 'array' }) };
}

/** Every cell of a sheet as rows of raw values — title rows included, so `A2` is `grid[1][0]`. */
const grid = (book: XLSX.WorkBook, name: string) =>
  XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[name]!, { header: 1 });

/** The one grid row whose first cell is this product's name, and the header row above it. */
function productRow(book: XLSX.WorkBook, productName: string) {
  const sheetName = book.SheetNames[0]!;
  const rows = grid(book, sheetName);
  const header = rows.find((row) => String(row[0] ?? '') === 'מוצר');
  const row = rows.find((candidate) => String(candidate[0] ?? '') === productName);
  expect(header, 'the header row').toBeDefined();
  expect(row, `the row for ${productName}`).toBeDefined();
  const at = (columnHeader: string) => {
    const index = header!.findIndex((cell) => String(cell ?? '') === columnHeader);
    expect(index, `column "${columnHeader}"`).toBeGreaterThanOrEqual(0);
    return row![index];
  };
  return { header: header!.map((cell) => String(cell ?? '')), at };
}

const FORMULA_ERRORS = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NULL!', '#NUM!'];

function everyCell(book: XLSX.WorkBook): string[] {
  return book.SheetNames.flatMap((name) => {
    const sheet = book.Sheets[name]!;
    return Object.entries(sheet)
      .filter(([address]) => !address.startsWith('!'))
      .map(([, cell]) => String((cell as XLSX.CellObject).w ?? (cell as XLSX.CellObject).v ?? ''));
  });
}

async function exportProductPurchases() {
  server.use(...productsTraffic());
  renderAt(<ProductPurchaseSummary />, `/reports/products?from=${WINDOW.from}&to=${WINDOW.to}`);
  expect(await screen.findByLabelText('מתאריך')).toHaveValue(WINDOW.from);
  await userEvent.click(await screen.findByRole('button', { name: 'ייצוא Excel' }));
  return exportedWorkbook();
}

describe('EXP-04 — the provenance the screen states rides the file', () => {
  it('gives the caveat a column of its own, naming the source of every quantity', async () => {
    const { book } = await exportProductPurchases();

    // The three states the server distinguishes, each said in the row it qualifies.
    expect(productRow(book, 'סוכר חום').at('מקור הכמות')).toContain('טרם אושרו בראיה');
    expect(productRow(book, 'שמן זית').at('מקור הכמות')).toContain('לפי החשבונית בלבד');
    expect(productRow(book, 'קמח לבן').at('מקור הכמות')).toBe('הכל לפי קבלות שהושלמו');
  });

  it('never states a purchased quantity of zero for a row nothing was measured on', async () => {
    const { book } = await exportProductPurchases();
    const unevidenced = productRow(book, 'סוכר חום');

    // The row the sweep counted 74 of: ordered 25, received blank, invoiced blank — and the
    // canonical column claiming a measurement of 0. All three now read the same absence.
    expect(unevidenced.at('נרכש בפועל')).toBe('—');
    expect(unevidenced.at('התקבל')).toBe('—');
    expect(unevidenced.at('חויב')).toBe('—');
    // What WAS measured stays a number. This is not a rule about zeros; it is a rule about claims.
    expect(unevidenced.at('הוזמן')).toBe(25);
    expect(productRow(book, 'קמח לבן').at('נרכש בפועל')).toBe(10);
  });

  it('says the same thing on the screen the file was exported from', async () => {
    server.use(...productsTraffic());
    renderAt(<ProductPurchaseSummary />, `/reports/products?from=${WINDOW.from}&to=${WINDOW.to}`);

    await screen.findAllByText('סוכר חום');
    // The desktop grid, not the mobile card twin of the same row — both are in the document.
    const row = screen.getAllByText('סוכר חום')
      .map((element) => element.closest('tr'))
      .find((candidate): candidate is HTMLTableRowElement => candidate !== null);
    expect(row, 'the desktop row for סוכר חום').toBeDefined();

    // The canonical figure is the one the column header calls נרכש בפועל, and the screen paints it
    // `font-semibold` because it is the answer this report exists to give. A screen that says 0
    // beside a file that says — would be the same defect wearing new clothes.
    const canonical = row!.querySelector('.num.font-semibold');
    expect(canonical?.textContent).toBe('—');
  });
});

describe('EXP-10 — the exported name is the name', () => {
  it('leaves a product name beginning with a hyphen exactly as the tenant typed it', async () => {
    const { book } = await exportProductPurchases();
    const name = '- ס 10מזלג ורסאי ניצוצות כסף -אר';

    const cell = book.Sheets[book.SheetNames[0]!]!;
    const written = Object.entries(cell)
      .filter(([address]) => !address.startsWith('!'))
      .map(([, value]) => String((value as XLSX.CellObject).v ?? ''))
      .filter((value) => value.includes('מזלג ורסאי'));

    expect(written).toEqual([name]);
    expect(written[0]!.startsWith("'")).toBe(false);
  });

  it('still writes no cell an opened workbook would evaluate', async () => {
    const { book } = await exportProductPurchases();
    for (const sheet of book.SheetNames) {
      for (const [address, cell] of Object.entries(book.Sheets[sheet]!)) {
        if (address.startsWith('!')) continue;
        expect((cell as XLSX.CellObject).f).toBeUndefined();
        expect((cell as XLSX.CellObject).t).not.toBe('e');
      }
    }
    for (const formulaError of FORMULA_ERRORS) {
      expect(everyCell(book).some((value) => value.includes(formulaError))).toBe(false);
    }
  });
});

describe('EXP-07 — the expenses workbook is named for its window', () => {
  it('names the period it covers, not the day it was produced', async () => {
    server.use(...expensesTraffic());
    renderAt(<Expenses />, `/expenses?from=${WINDOW.from}&to=${WINDOW.to}`);

    await userEvent.click(await screen.findByRole('button', { name: 'ייצוא Excel' }));
    const { fileName, book } = await exportedWorkbook();

    expect(fileName).toBe(`expenses-${WINDOW.from}-${WINDOW.to}.xlsx`);
    // Every sheet still states the window inside the file, which was never the broken half.
    for (const name of book.SheetNames) {
      expect(String(book.Sheets[name]!['A2']?.v ?? '')).toContain('01.01.2025 – 31.12.2026');
    }
    for (const formulaError of FORMULA_ERRORS) {
      expect(everyCell(book).some((value) => value.includes(formulaError))).toBe(false);
    }
  });

  it('agrees with the PDF button beside it, which was always right', async () => {
    server.use(...expensesTraffic());
    renderAt(<Expenses />, `/expenses?from=${WINDOW.from}&to=${WINDOW.to}`);

    await userEvent.click(await screen.findByRole('button', { name: 'ייצוא Excel' }));
    const { fileName } = await exportedWorkbook();
    await userEvent.click(await screen.findByRole('button', { name: 'הורדת PDF' }));
    await waitFor(() => expect(pdfDownloads).toHaveLength(1));

    const stem = (name: string) => name.replace(/\.(xlsx|pdf)$/, '');
    expect(stem(fileName)).toBe(stem(pdfDownloads[0]!));
  });
});
