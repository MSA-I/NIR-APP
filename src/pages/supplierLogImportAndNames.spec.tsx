/**
 * `/supplier-log` — the half of `PL-03` that survived `OWN-04`, and `PL-06`.
 *
 * `PL-03` has three clauses. Two of them landed with `OWN-04`/`OWN-05`: an import row is no longer
 * announced as a deletion, and the operator's reason now reaches the price rows it explains. Two
 * remain, and they are what this file measures:
 *
 *   - the import command row does not name the SUPPLIER. `import_supplier_prices` writes its audit
 *     row with `entity_id = null`, so the price-line lookup resolves nothing and the subject can
 *     only count rows. The supplier is nonetheless recorded: every trigger row of the SAME request
 *     carries it, linked by the `correlation_id` the column default of `0062` puts on all of them.
 *   - the change cell reads „אין נתוני מחיר" on the one row that reports what the import did. Six
 *     prices moved; the ledger's own summary of them says there is no price data.
 *
 * `PL-06` is a promise: „כל אישור נרשם ביומן הביקורת" on `/products → שמות לאישור`, over an entry
 * this product has no screen for. `set_product_display_name` (`0149`) writes it under entity type
 * `products` with the raw name beside the approved one, and the ledger asked for two entity types
 * and never that one. It is asked for here — the two NAMED name actions, and not the generic
 * trigger row, because the screen is a supplier ledger and not a product-mutation firehose.
 *
 * THE FIXTURE'S SERVER HONOURS THE FILTER. A handler that returns every row whatever was asked for
 * would make this file green on the unfixed tree while the screen still never requests the rows.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

import SupplierLog from './SupplierLog';

const LOGS = `${SUPABASE_URL}/rest/v1/audit_log_read_model`;
const IMPORT_REASON = 'בדיקת QA — סריקת רגרסיה 04.09.2026';
const NAME_REASON = 'אישור השם הקנוני שהוצע למוצר';
const SUPPLIER = 'ספק הבדיקה';

interface LogFixture {
  id: string;
  org_id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  reason: string | null;
  created_at: string;
  correlation_id: string | null;
}

const at = (index: number) => new Date(Date.UTC(2026, 8, 4, 12, 0, 0) - index * 60_000).toISOString();

function row(index: number, over: Partial<LogFixture>): LogFixture {
  return {
    id: `log-${index}`, org_id: 'org-test', user_id: 'user-1',
    action: 'update', entity_type: 'suppliers', entity_id: 'sup-1',
    old_values: null, new_values: null, reason: null,
    created_at: at(index), correlation_id: `corr-${index}`,
    ...over,
  };
}

function ledger(): LogFixture[] {
  const rows: LogFixture[] = [
    row(0, {
      id: 'cmd-import', action: 'supplier_prices_imported', entity_type: 'supplier_products',
      entity_id: null, reason: IMPORT_REASON, correlation_id: 'corr-import',
      new_values: { row_count: 6, created: 0, updated: 6, unchanged: 0, effective_date: '2026-09-04' },
    }),
  ];
  for (let n = 1; n <= 6; n += 1) {
    rows.push(row(n, {
      id: `trg-import-${n}`, action: 'update', entity_type: 'supplier_products',
      entity_id: `sp-${n}`, correlation_id: 'corr-import',
      old_values: { current_price: 10 + n }, new_values: { current_price: 12 + n },
    }));
  }
  // PL-06: the reasoned row `set_product_display_name` writes, raw name and approved name together.
  rows.push(row(7, {
    id: 'cmd-name', action: 'product_display_name_set', entity_type: 'products',
    entity_id: 'prod-1', reason: NAME_REASON, correlation_id: 'corr-name',
    old_values: { display_name: null, name: 'מלח גס' },
    new_values: { display_name: 'מלח גס דק', name: 'מלח גס' },
  }));
  // The control for PL-06: the generic products trigger row. A supplier ledger that swallowed
  // every product mutation would answer a different question from the one it is named after.
  rows.push(row(8, {
    id: 'trg-product-active', action: 'update', entity_type: 'products', entity_id: 'prod-2',
    correlation_id: 'corr-active',
    old_values: { active: true }, new_values: { active: false },
  }));
  // A supplier row whose change carries no price at all — the cell that SHOULD say so.
  rows.push(row(9, {
    id: 'trg-rating', entity_id: 'sup-1', correlation_id: 'corr-rating',
    old_values: { rating: 3 }, new_values: { rating: 4 },
  }));
  return rows;
}

const PRICE_ROWS = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: `sp-${n}`, supplier_id: 'sup-1',
  supplier: { id: 'sup-1', name: SUPPLIER, default_currency: 'ILS' },
  product: { id: `p-${n}`, name: `מוצר ${n}` },
}));

/**
 * A row is served only when the request actually ASKED for its entity type — and, for `products`,
 * for its action too. `supplier_products` must not be read as a match for `products`, hence the
 * boundary on `_`.
 */
const asks = (query: string, token: string) =>
  new RegExp(`(?<![A-Za-z_])${token}(?![A-Za-z_])`).test(query);

function serveLedger(all: LogFixture[]) {
  server.use(
    http.get(LOGS, ({ request }) => {
      const url = new URL(request.url);
      // DECODED, and that is not cosmetic: `%2C` ends in a letter, so an encoded separator hides
      // the token that follows it from a word-boundary match.
      const query = decodeURIComponent(url.search);
      const visible = all.filter((entry) => asks(query, entry.entity_type)
        && (entry.entity_type !== 'products' || asks(query, entry.action)));
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? String(visible.length));
      const page = visible.slice(offset, offset + limit);
      const last = offset + Math.max(page.length, 1) - 1;
      return HttpResponse.json(page, {
        headers: { 'content-range': `${offset}-${last}/${visible.length}` },
      });
    }),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json(PRICE_ROWS)),
    http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([
      { id: 'sup-1', name: SUPPLIER, default_currency: 'ILS' },
    ])),
    http.get(`${SUPABASE_URL}/rest/v1/profiles`, () => HttpResponse.json([
      { id: 'user-1', full_name: 'בעל העסק' },
    ])),
  );
}

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => {
  localStorage.clear();
  serveLedger(ledger());
});

function renderLog() {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/supplier-log']}><SupplierLog /></MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

const bodyRows = () => Array.from(document.querySelectorAll('table tbody tr'))
  .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() ?? ''));

const rowsWhere = (predicate: (cells: string[]) => boolean) => bodyRows().filter(predicate);

describe('PL-03 · שורת הקליטה אומרת של מי המחירון ומה קרה בו', () => {
  it('נושאת את שם הספק לצד מספר השורות', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    const imported = rowsWhere((cells) => cells.includes('קליטת מחירון'));
    expect(imported).toHaveLength(1);
    expect(imported[0][1]).toContain(SUPPLIER);
    expect(imported[0][1]).toContain('6');
  });

  it('לא אומרת „אין נתוני מחיר" על השורה שמסכמת שישה מחירים שהשתנו', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    const imported = rowsWhere((cells) => cells.includes('קליטת מחירון'))[0];
    expect(imported.join(' ')).not.toContain('אין נתוני מחיר');
    // What the import actually did, from the row's own `new_values`.
    expect(imported.join(' ')).toMatch(/עודכנו/);
  });

  it('בקרה — שורה שבאמת אין בה נתוני מחיר עדיין אומרת זאת', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    const rating = rowsWhere((cells) => cells[1] === SUPPLIER && cells.includes('עדכון'));
    expect(rating.length).toBeGreaterThan(0);
    expect(rating.some((cells) => cells.join(' ').includes('אין נתוני מחיר'))).toBe(true);
  });
});

describe('PL-06 · אישור שם קנוני נקרא ביומן', () => {
  it('היומן מציג את רישום האישור עם השם הגולמי והסיבה', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    const approvals = rowsWhere((cells) => cells.join(' ').includes(NAME_REASON));
    expect(approvals).toHaveLength(1);
    // The record says what the record said: the raw name is the subject, not a name we composed.
    expect(approvals[0][1]).toContain('מלח גס');
    expect(approvals[0].join(' ')).toContain('מלח גס דק');
  });

  it('אפשר לסנן אליו', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    expect(screen.getByRole('option', { name: 'שמות מוצרים' })).toBeInTheDocument();
  });

  it('בקרה — עדכון מוצר רגיל אינו נכנס ליומן הספקים', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    expect(rowsWhere((cells) => cells.join(' ').includes('prod-2'))).toHaveLength(0);
    expect(bodyRows().length).toBeLessThanOrEqual(9);
  });
});
