/**
 * `/supplier-log` — the four defects of the audit ledger, read from the screen.
 *
 * `OWN-11`, `OWN-04`, `OWN-05` and `PERM-06` are four separate defects on one screen, and all four
 * are asserted here against the real page rather than against a helper, because three of them are
 * about what a sentence on that screen CLAIMS.
 *
 * THE FIXTURE IS BIGGER THAN THE CAP ON PURPOSE. `OWN-11` is a hard `.limit(400)`; a fixture of
 * fewer than 401 rows would pass on the unfixed tree and prove nothing at all. This one carries
 * 405, so the 401st row exists, is inside the organisation's own RLS scope, and is unreachable
 * from the product until the fix lands.
 *
 * The ten newest rows are the shapes the sweep actually met, in the order a real import writes
 * them: one `supplier_prices_imported` command row with `entity_id = null` and the operator's
 * reason on it, the six row-level trigger rows the same statement produced with `reason = null`,
 * one `supplier_product_price_set` command with its single trigger twin, and one row that really
 * does describe a price line that is gone. Every one of them carries the `correlation_id` the
 * column DEFAULT of migration `0062` puts on every audit write of one request — which is the link
 * the screen has never used and the whole reason `OWN-05`/`PERM-06` can be answered by a reader
 * without touching the ledger.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
const SUPPLIER_PRODUCTS = `${SUPABASE_URL}/rest/v1/supplier_products`;
const SUPPLIERS = `${SUPABASE_URL}/rest/v1/suppliers`;
const PROFILES = `${SUPABASE_URL}/rest/v1/profiles`;

const IMPORT_REASON = 'בדיקת QA — סריקת רגרסיה 04.09.2026';
const SET_REASON = 'בדיקת QA — החזרת מחיר מקורי';
const OLDEST_SUPPLIER = 'ספק היסטורי 401';

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

/**
 * 405 rows: ten that carry the four findings, 394 fillers, and one 401st-and-older row whose
 * supplier name exists nowhere else on the screen.
 */
function ledger(): LogFixture[] {
  const rows: LogFixture[] = [
    // The import command: `entity_id` is NULL (0032:375), so no price line resolves for it.
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
  rows.push(row(7, {
    id: 'cmd-set', action: 'supplier_product_price_set', entity_type: 'supplier_products',
    entity_id: 'sp-7', reason: SET_REASON, correlation_id: 'corr-set',
    old_values: { price: 30 }, new_values: { price: 31, price_changed: true },
  }));
  rows.push(row(8, {
    id: 'trg-set', action: 'update', entity_type: 'supplier_products',
    entity_id: 'sp-7', correlation_id: 'corr-set',
    old_values: { current_price: 30 }, new_values: { current_price: 31 },
  }));
  // A price line that really is gone: an entity_id that resolves to nothing.
  rows.push(row(9, {
    id: 'trg-deleted', action: 'delete', entity_type: 'supplier_products',
    entity_id: 'sp-gone', correlation_id: 'corr-deleted',
    old_values: { current_price: 9 }, new_values: null,
  }));
  for (let n = 10; n <= 403; n += 1) {
    rows.push(row(n, { old_values: { rating: 3 }, new_values: { rating: 4 } }));
  }
  rows.push(row(404, {
    id: 'log-oldest', entity_id: 'sup-old',
    old_values: { rating: 1 }, new_values: { rating: 2 },
  }));
  return rows;
}

const PRICE_ROWS = [1, 2, 3, 4, 5, 6, 7].map((n) => ({
  id: `sp-${n}`, supplier_id: 'sup-1',
  supplier: { id: 'sup-1', name: 'ספק הבדיקה', default_currency: 'ILS' },
  product: { id: `p-${n}`, name: `מוצר ${n}` },
}));

const SUPPLIER_ROWS = [
  { id: 'sup-1', name: 'ספק הבדיקה', default_currency: 'ILS' },
  { id: 'sup-old', name: OLDEST_SUPPLIER, default_currency: 'ILS' },
];

/** Every request the ledger page issues, served from the fixture. */
function serveLedger(all: LogFixture[]) {
  server.use(
    http.get(LOGS, ({ request }) => {
      const url = new URL(request.url);
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? String(all.length));
      const page = all.slice(offset, offset + limit);
      const last = offset + Math.max(page.length, 1) - 1;
      return HttpResponse.json(page, {
        headers: { 'content-range': `${offset}-${last}/${all.length}` },
      });
    }),
    http.get(SUPPLIER_PRODUCTS, () => HttpResponse.json(PRICE_ROWS)),
    http.get(SUPPLIERS, () => HttpResponse.json(SUPPLIER_ROWS)),
    http.get(PROFILES, () => HttpResponse.json([{ id: 'user-1', full_name: 'בעל העסק' }])),
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

/** The desktop table only: the mobile cards are mounted and CSS-hidden, so text matches twice. */
const bodyRows = () => Array.from(document.querySelectorAll('table tbody tr'))
  .map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent?.trim() ?? ''));

const rowsWhere = (predicate: (cells: string[]) => boolean) => bodyRows().filter(predicate);

const search = async (text: string) => {
  const box = screen.getByLabelText('חיפוש ביומן');
  await userEvent.clear(box);
  if (text) await userEvent.type(box, text);
};

describe('/supplier-log — OWN-11: the ledger reaches its own history', () => {
  it('a row older than the 400th is reachable, and the screen states the real total', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    // The 401st row is not in the first page — the control that makes the next step mean something.
    await search(OLDEST_SUPPLIER);
    expect(rowsWhere((cells) => cells.includes(OLDEST_SUPPLIER))).toHaveLength(0);
    await search('');

    // The defect: there is no control of any kind that reaches past the cap.
    await userEvent.click(screen.getByRole('button', { name: /ישנים יותר/ }));

    await search(OLDEST_SUPPLIER);
    await waitFor(
      () => expect(rowsWhere((cells) => cells.includes(OLDEST_SUPPLIER))).toHaveLength(1),
      { timeout: 3_000 },
    );

    // And the screen states the size of the ledger rather than the size of the cap.
    await search('');
    await waitFor(() => expect(screen.getByText(/מתוך 405/)).toBeTruthy(), { timeout: 3_000 });
  });
});

describe('/supplier-log — OWN-04: an import is described as an import', () => {
  it('names the imported rows, and leaves the deleted-row label to a row that really is one', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    const imported = rowsWhere((cells) => cells.includes('קליטת מחירון'));
    expect(imported).toHaveLength(1);
    // Read as a substring of the row rather than as the whole of one cell: `PL-03` adds the
    // supplier's name to that same subject, and OWN-04's claim is that the row NAMES THE IMPORT —
    // not that the subject cell says these three words and nothing else.
    expect(imported[0].join(' ')).toContain('6 שורות מחירון');
    expect(imported[0]).not.toContain('שורת מחירון שנמחקה');

    // The fallback still belongs to the row whose price line is genuinely gone — and to it alone.
    const deleted = rowsWhere((cells) => cells.includes('שורת מחירון שנמחקה'));
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toContain('מחיקה');
  });
});

describe('/supplier-log — OWN-05: one write, one readable entry', () => {
  it('folds the reason-less trigger twin into the reasoned price command it shadows', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    const sevens = rowsWhere((cells) => cells.includes('מוצר 7 · ספק הבדיקה'));
    expect(sevens).toHaveLength(1);
    // The surviving entry carries BOTH halves: the command's name and reason, and the trigger
    // row's before/after — which is the pair the screen used to split across two rows.
    expect(sevens[0]).toContain('עדכון מחיר');
    expect(sevens[0]).toContain(SET_REASON);
    expect(sevens[0].join(' ')).not.toContain('לא נרשמה סיבה');
  });
});

describe('/supplier-log — PERM-06: a price change is not shown as unattributed', () => {
  it('carries the import reason onto every price row that import wrote', async () => {
    renderLog();
    await screen.findAllByText('מוצר 1 · ספק הבדיקה');

    const imported = rowsWhere((cells) => cells.some((cell) => cell.startsWith('מוצר ')
      && cell.endsWith('· ספק הבדיקה')));
    expect(imported.length).toBeGreaterThanOrEqual(6);
    for (const cells of imported) {
      expect(cells.join(' ')).not.toContain('לא נרשמה סיבה');
    }
    // The reason itself, not merely the absence of the false claim. `includes` rather than
    // equality because an inherited reason shares its cell with the note that says it is one.
    expect(rowsWhere((cells) => cells.some((cell) => cell.includes(IMPORT_REASON))).length)
      .toBeGreaterThanOrEqual(6);
  });
});
