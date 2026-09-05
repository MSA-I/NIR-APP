/**
 * The per-supplier sheet door — „העלאת מחירון" on /prices — and three findings of 04.09.2026.
 *
 *   PL-05  A canonical name is the name every screen SHOWS. `/products` and `/prices` render
 *          `display_name`; the importer indexed the catalogue by `nameKey(product.name)` alone, so
 *          a sheet row copied off the product screen previewed as „מוצר חדש" and, if the box were
 *          ticked, would have created a SECOND product for the item the approval queue exists to
 *          stop duplicating.
 *   PL-07  `parsePrice` computes `rounded` and its own docblock states the contract as "says so
 *          when rounding changed it". Neither consumer ever read the flag: 1.2345 previewed and
 *          stored as 1.23 with nothing on any screen recording that the number changed.
 *   PL-12  The two intake doors answer "which line is which product?" by different keys and only
 *          one of them says so. The document reviewer states its rule outright; this door stated
 *          nothing, so 6/16 here and 0/16 there looked like a contradiction rather than two rules.
 *
 * THE CONTROL IS THE POINT OF PL-05. A canonical name is a SECOND key, never a replacement: the
 * fixture holds a product whose raw name is „ריבה" and another whose canonical name normalises to
 * the same thing, and the sheet row must still resolve to the raw one. That is what makes the fix
 * additive — no row that resolved before can start resolving differently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { LocaleProvider, translateIn } from '../lib/i18n/LocaleProvider';

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

/** The name `/products` displays for the soap, letter for letter, em dash included. */
const CANONICAL_SOAP = 'סבון ידיים נוזלי — 4 ליטר';

const SHEET = [
  'מוצר,מחיר',
  `${CANONICAL_SOAP},18.90`,
  'בצל יבש,1.2345',
  'ריבה,7.00',
].join('\n');

const CATALOGUE = [
  // The sweep's own row: stored under a raw name, displayed under an approved canonical one.
  { id: 'prod-soap', name: 'סבון ידיים נוזלי 4 ליטר', display_name: CANONICAL_SOAP, active: true },
  { id: 'prod-onion', name: 'בצל יבש', display_name: null, active: true },
  // The control pair. „ריבה" is the RAW name of one product and the CANONICAL name of another.
  { id: 'prod-jam-raw', name: 'ריבה', display_name: null, active: true },
  { id: 'prod-jam-canonical', name: 'ריבת חלב', display_name: 'ריבה', active: true },
];

type ImportedRow = { supplier_id: string; product_id: string; price: number; currency: string };
let rpcBody: { p_rows: ImportedRow[] } | null = null;

function wire() {
  rpcBody = null;
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_price_submissions`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([
      { id: 'sup-1', name: 'ספק אלפא', status: 'active', default_currency: 'ILS' },
    ])),
    http.get(`${SUPABASE_URL}/rest/v1/currencies`, () => HttpResponse.json([{ code: 'ILS' }])),
    http.get(`${SUPABASE_URL}/rest/v1/products`, ({ request }) => {
      // The door reads the catalogue in pages; the fixture is small enough for one.
      const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0);
      return HttpResponse.json(offset ? [] : CATALOGUE);
    }),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/import_supplier_prices`, async ({ request }) => {
      rpcBody = await request.json() as typeof rpcBody;
      return HttpResponse.json({ updated: 3, created: 0, unchanged: 0 });
    }),
  );
}

beforeEach(() => { wire(); });

/** Opens „העלאת מחירון", picks the supplier, hands over the sheet and waits for the preview. */
async function previewSheet() {
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
  // By its anchor, not by its name: /prices carries a second „העלאת מחירון" control per row.
  const open = await waitFor(() => {
    const button = document.querySelector('[data-tour-anchor="prices-upload"]');
    if (!button) throw new Error('the price-list upload button has not rendered');
    return button as HTMLButtonElement;
  }, { timeout: 3_000 });
  fireEvent.click(open);
  const supplier = await screen.findByLabelText(translateIn('he', 'priceUpload.label'));
  await waitFor(() => expect(within(supplier as HTMLSelectElement).getByText('ספק אלפא')).toBeTruthy(),
    { timeout: 3_000 });
  fireEvent.change(supplier, { target: { value: 'sup-1' } });
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([SHEET], 'prices.csv', { type: 'text/csv' })] } });
  fireEvent.click(screen.getByRole('button', { name: translateIn('he', 'priceUpload.isSpreadsheet') }));
  await screen.findByRole('table');
}

/** The preview table's data rows, as [product, price, match] triples. */
const previewRows = () => Array.from(document.querySelectorAll('table tbody tr'))
  .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() ?? ''));

const rowFor = (name: string) => previewRows().find((cells) => cells[0] === name) ?? [];

describe('PL-05 · שם קנוני שאושר מתאים למוצר שהוא מתאר', () => {
  it('שורה שנושאת את השם שמסך המוצרים מציג אינה מוצעת כמוצר חדש', async () => {
    await previewSheet();

    const soap = rowFor(CANONICAL_SOAP);
    expect(soap.length).toBeGreaterThan(0);
    expect(soap.join(' ')).not.toContain(translateIn('he', 'priceUpload.text_14'));
    // And the preview says WHICH name matched, so nobody has to guess why this row resolved.
    expect(soap.join(' ')).toMatch(/קנוני/);
  });

  it('כותב את המחיר על המוצר הקיים, לא על מוצר שני', async () => {
    await previewSheet();
    fireEvent.click(screen.getByRole('button', { name: translateIn('he', 'priceUpload.runImport_2') }));
    await waitFor(() => expect(rpcBody).not.toBeNull(), { timeout: 3_000 });

    const byProduct = new Map((rpcBody?.p_rows ?? []).map((row) => [row.product_id, row.price]));
    expect(byProduct.get('prod-soap')).toBe(18.9);
  });

  it('בקרה — השם השמור מנצח תמיד; שם קנוני הוא מפתח שני, לא תחליף', async () => {
    await previewSheet();
    fireEvent.click(screen.getByRole('button', { name: translateIn('he', 'priceUpload.runImport_2') }));
    await waitFor(() => expect(rpcBody).not.toBeNull(), { timeout: 3_000 });

    const ids = (rpcBody?.p_rows ?? []).map((row) => row.product_id);
    expect(ids).toContain('prod-jam-raw');
    expect(ids).not.toContain('prod-jam-canonical');
  });
});

describe('PL-07 · עיגול למטבע אינו שקט', () => {
  it('מסמן את השורה שעוגלה, ואינו מסמן את השורות שלא', async () => {
    await previewSheet();

    // 1.2345 in a two-minor-unit currency: the catalogue will hold 1.23 and the supplier quoted
    // something else. `parsePrice` has always reported this; nothing has ever read it.
    expect(rowFor('בצל יבש').join(' ')).toMatch(/עוגל/);
    expect(rowFor('ריבה').join(' ')).not.toMatch(/עוגל/);
  });
});

describe('PL-12 · שני הפתחים אומרים לפי מה הם מתאימים', () => {
  it('מסך העלאת המחירון מצהיר על מפתח ההתאמה שלו, כמו מסך בדיקת המסמך', async () => {
    await previewSheet();

    // The other door already prints "…לפי מק״ט או ברקוד; שם מוצר לעולם אינו מפתח התאמה".
    // This one said nothing at all, so two counts for one file looked like a contradiction.
    const rule = await screen.findByTestId('sheet-match-rule');
    expect(rule).toHaveTextContent(/שם/);
    expect(rule).toHaveTextContent(/מק״ט|ברקוד/);
  });
});
