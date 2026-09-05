import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { LocaleProvider, translateIn } from '../lib/i18n/LocaleProvider';

/**
 * The SECOND price door — "ייבוא רב־ספקים מ־Excel" on /prices.
 *
 * `PL-01`, `PL-02` and `PL-10` of the 2026-09-04 sweep, all inside `PriceLists.tsx`'s `ImportModal`:
 *
 *   PL-01  `mapRows` returns `{valid, skipped}` and the modal bound only `valid`, so every row the
 *          parser refused vanished — no count, no reason, no panel. The sister door
 *          (`PriceListUpload.tsx`) binds `skipped` and renders it: one product, two answers.
 *   PL-02  the abort named `index + 2` over the ALREADY FILTERED preview, so it pointed at line 3
 *          for a problem on line 9 — and it discarded the rows that DID resolve along with the one
 *          that did not.
 *   PL-10  suppliers and products were read unpaged, so a catalogue past PostgREST's page ceiling
 *          silently stopped resolving. Proved here by capping the fake PostgREST at 1000 rows the
 *          way the real one caps, and putting the row the sheet needs past the cap.
 *
 * The fixture is the sweep's own: eight data rows, six carrying a price the `0298` parser refuses,
 * one row that resolves against the catalogue, one row naming a product the catalogue lacks.
 */
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
    profile: { id: 'user-1', role: 'office', org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {} },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import PriceLists from './PriceLists';

/** Eight data rows on file lines 2-9. The six prices the parser refuses sit on lines 3-8. */
const SHEET = [
  'ספק,מוצר,מחיר',
  'ספק אלפא,עגבניות,9.50',
  'ספק אלפא,תפוחי אדמה,"12,50"',
  'ספק אלפא,בצל,לא ידוע',
  'ספק אלפא,גזר,-3',
  'ספק אלפא,מלפפון,12.50 USD',
  'ספק אלפא,חסה,12.50 EUR',
  'ספק שאינו קיים,פטרוזיליה,7.00',
  'ספק אלפא,מוצר שלא קיים QA,11.00',
].join('\n');

const sheetFile = () => new File([SHEET], 'prices.csv', { type: 'text/csv' });

/**
 * PostgREST's own ceiling, reproduced.
 *
 * `postgrest-js` pages with `offset`/`limit` SEARCH PARAMS, not a `Range` header — an earlier
 * draft of this file asserted the header, saw none, and served the first page forever. A request
 * that asks for no window gets the first page and nothing says so, which is exactly how an unpaged
 * read loses the tail of a catalogue in production: HTTP 200, no error, no resolution.
 */
const PAGE_CAP = 1000;

/** The window a request asked for, or `null` when it asked for no window at all. */
const windowOf = (request: Request) => {
  const params = new URL(request.url).searchParams;
  const offset = params.get('offset');
  const limit = params.get('limit');
  return offset == null || limit == null ? null : `${offset}+${limit}`;
};

function page<T>(rows: T[], request: Request): T[] {
  const params = new URL(request.url).searchParams;
  const from = Number(params.get('offset') ?? 0);
  const size = Math.min(Number(params.get('limit') ?? PAGE_CAP), PAGE_CAP);
  return rows.slice(from, from + size);
}

type Catalogue = {
  suppliers: { id: string; name: string }[];
  products: { id: string; name: string }[];
};

let rpcBody: { p_rows: { supplier_id: string; product_id: string; price: number }[] } | null = null;
let supplierWindows: (string | null)[] = [];
let productWindows: (string | null)[] = [];

function wire(catalogue: Catalogue) {
  rpcBody = null;
  supplierWindows = [];
  productWindows = [];
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_price_submissions`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/suppliers`, ({ request }) => {
      supplierWindows.push(windowOf(request));
      // The preview asks for the currency, the writer asks for the id. One table, two shapes.
      const select = new URL(request.url).searchParams.get('select') ?? '';
      const rows: Record<string, string>[] = select.includes('default_currency')
        ? catalogue.suppliers.map((s) => ({ name: s.name, default_currency: 'ILS' }))
        : catalogue.suppliers.map((s) => ({ id: s.id, name: s.name }));
      return HttpResponse.json(page(rows, request));
    }),
    http.get(`${SUPABASE_URL}/rest/v1/products`, ({ request }) => {
      productWindows.push(windowOf(request));
      return HttpResponse.json(page(catalogue.products, request));
    }),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/import_supplier_prices`, async ({ request }) => {
      rpcBody = await request.json() as typeof rpcBody;
      return HttpResponse.json({ updated: 1, created: 0, unchanged: 0 });
    }),
  );
}

const smallCatalogue = (): Catalogue => ({
  suppliers: [{ id: 'sup-alpha', name: 'ספק אלפא' }],
  products: [{ id: 'prod-tomato', name: 'עגבניות' }],
});

function renderScreen() {
  render(
    <LocaleProvider initialLocale="he">
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter initialEntries={['/prices']}>
              <Routes><Route path="/prices" element={<PriceLists />} /></Routes>
            </MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

/** Opens the multi-supplier modal and hands it the fixture sheet. */
async function uploadSheet() {
  renderScreen();
  fireEvent.click(await screen.findByRole('button', { name: /ייבוא רב־ספקים/ }));
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [sheetFile()] } });
}

/** Every line number printed inside the "which rows were dropped" disclosure, ascending. */
async function skippedRowNumbers(): Promise<number[]> {
  const summary = await screen.findByText(translateIn('he', 'priceUpload.text_8'));
  const details = summary.closest('details');
  expect(details).not.toBeNull();
  return [...(details?.textContent ?? '').matchAll(/\d+/g)]
    .map((match) => Number(match[0]))
    .sort((a, b) => a - b);
}

beforeEach(() => { wire(smallCatalogue()); });

describe('PL-01 — the refused rows are reported, not dropped', () => {
  it('names all six refused rows by their SOURCE line in the uploaded file', async () => {
    await uploadSheet();

    // Two of eight rows survived the parser, and the modal already said so.
    expect(await screen.findByText(/2 שורות זוהו/)).toBeInTheDocument();
    // The other six are now named — by the line they occupy in the file, not by the position they
    // would have had in the filtered preview.
    expect(await screen.findByText(/6 שורות דולגו/)).toBeInTheDocument();
    expect(await skippedRowNumbers()).toEqual([3, 4, 5, 6, 7, 8]);
  });
});

describe('PL-02 — the source line, and the rows that do resolve', () => {
  it('imports the row that resolves and reports the unresolved one as file line 9', async () => {
    await uploadSheet();
    expect(await screen.findByText(/2 שורות זוהו/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: translateIn('he', 'priceLists.runImport_2') }));

    // The one row the catalogue can resolve is written. Nothing was, before: a single unresolved
    // row aborted the entire file.
    await waitFor(() => expect(rpcBody).not.toBeNull(), { timeout: 3_000 });
    expect(rpcBody?.p_rows).toEqual([
      { supplier_id: 'sup-alpha', product_id: 'prod-tomato', price: 9.5, available: true },
    ]);

    // And the completion report accounts for every row that did not become a price — the six the
    // parser refused plus FILE LINE 9, the one the catalogue could not match. The sweep measured
    // "line 3": a row the screen never displayed, whose problem was a comma decimal.
    await screen.findByRole('button', { name: translateIn('he', 'priceLists.text_22') });
    expect(await skippedRowNumbers()).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('PL-10 — the catalogue is read in pages', () => {
  it('resolves a product that sits past the PostgREST page ceiling', async () => {
    // 1001 products, and the one the sheet names is the LAST: an unpaged read cannot see it.
    const filler = Array.from({ length: PAGE_CAP }, (_, i) => ({ id: `prod-${i}`, name: `מוצר ${i}` }));
    wire({
      suppliers: [{ id: 'sup-alpha', name: 'ספק אלפא' }],
      products: [...filler, { id: 'prod-tomato', name: 'עגבניות' }],
    });

    await uploadSheet();
    expect(await screen.findByText(/2 שורות זוהו/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: translateIn('he', 'priceLists.runImport_2') }));

    await waitFor(() => expect(rpcBody).not.toBeNull(), { timeout: 3_000 });
    expect(rpcBody?.p_rows).toEqual([
      { supplier_id: 'sup-alpha', product_id: 'prod-tomato', price: 9.5, available: true },
    ]);
    // Not merely "it worked": the reads asked for bounded windows, and the product read needed a
    // SECOND one to reach the row past the cap. An unpaged read asks for no window at all.
    expect(productWindows.length).toBeGreaterThan(1);
    expect(productWindows.every((window) => window !== null)).toBe(true);
    expect(supplierWindows.every((window) => window !== null)).toBe(true);
  });
});
