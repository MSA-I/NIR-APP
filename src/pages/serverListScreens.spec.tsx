import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { PAGE_NO_LONGER_EXISTS, SUPPLIER_SEARCH_ID_CAP, SUPPLIER_SEARCH_NARROWED } from '../lib/serverList';

/**
 * The screens under test import the app's supabase client, which throws at module load without
 * VITE_SUPABASE_URL. The mock hands them a real supabase-js client pointed at the MSW base URL
 * instead — the wire behaviour stays real, only the configuration source changes.
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

/** Owner sees every column and every filter; the real provider needs a live session. */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { role: 'owner', full_name: 'בודק' },
    org: { settings: {} },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Payments from './Payments';
import Bank from './Bank';
import { InvoicesList } from './Invoices';

beforeAll(() => {
  // matchMedia is deliberately NOT stubbed: ui.tsx's useMediaQuery defaults to desktop when it
  // is absent (jsdom), which keeps the toolbar inline instead of inside the closed mobile sheet.
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => {
  server.use(http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, ({ request }) => {
    const filter = new URL(request.url).searchParams.get('id');
    const ids = /^in\.\((.*)\)$/.exec(filter ?? '')?.[1]?.split(',').filter(Boolean) ?? [];
    return HttpResponse.json(ids.map((id) => ({
      id,
      name: `ספק ${id.replace(/^sup-/, '')}`,
      tax_id: null,
      payment_terms: null,
      status: 'active',
      bank_details: null,
    })));
  }));
});

interface Seen { url: URL; method: string }

/**
 * A PostgREST stand-in with the same 416/count semantics the serverList suite transcribed from
 * the real server, plus just enough filter awareness (`id=eq.`) for the pin tests.
 *
 * Cell texts are asserted with `findAllByText`: DataTable keeps both DOM branches (mobile cards
 * and desktop table) mounted and hides one with CSS, so every cell exists twice on purpose.
 */
function useJsonTable(table: string, rows: Array<Record<string, unknown>>): Seen[] {
  const seen: Seen[] = [];
  const respond = ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    seen.push({ url, method: request.method });
    const idFilter = url.searchParams.get('id');
    const matched = idFilter?.startsWith('eq.')
      ? rows.filter((row) => row.id === idFilter.slice(3))
      : rows;
    const total = matched.length;
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? String(total));
    if (offset >= total && offset > 0) {
      return HttpResponse.json(
        { message: 'Requested range not satisfiable', code: 'PGRST103', details: null, hint: null },
        { status: 416, headers: { 'content-range': `*/${total}` } },
      );
    }
    if (request.method === 'HEAD') {
      return new HttpResponse(null, { status: 200, headers: { 'content-range': `*/${total}` } });
    }
    const page = matched.slice(offset, offset + limit);
    return HttpResponse.json(page, {
      status: page.length < total ? 206 : 200,
      headers: { 'content-range': `${offset}-${offset + Math.max(page.length - 1, 0)}/${total}` },
    });
  };
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/${table}`, respond),
    http.head(`${SUPABASE_URL}/rest/v1/${table}`, respond),
  );
  return seen;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="url">{location.pathname + location.search}</div>;
}

function renderAt(path: string, route: string, element: ReactNode) {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={route} element={<>{element}<LocationProbe /></>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

const payment = (i: number) => ({
  id: `pay-${i}`, number: i + 1, amount: 100, paid_date: '2026-05-10', method: null,
  reference: `ref-${i}`, notes: null, supplier_id: `sup-${i}`,
  supplier: { name: `ספק ${i}` }, allocations: [], executor: null,
});
const invoiceRow = (i: number) => ({
  id: `inv-${i}`, invoice_number: `N-${i}`, invoice_date: '2026-05-10', total_amount: 100,
  review_status: 'approved', payment_status: 'unpaid', export_status: 'not_sent',
  supplier_id: `sup-${i}`, supplier: { name: `ספק ${i}` }, order_links: [], deleted_at: null,
});
const bankTx = (i: number) => ({
  id: `tx-${i}`, tx_date: '2026-07-10', description: `העברה ${i}`, amount: 100,
  reference: null, status: 'unmatched', supplier_id: null, supplier: null,
});

describe('/payments — server mode', () => {
  it('shows the server total in the toolbar, never the page length', async () => {
    useJsonTable('payments', Array.from({ length: 42 }, (_, i) => payment(i)));

    renderAt('/payments', '/payments', <Payments />);

    // 15 rows were transferred; 42 match. The number on screen is the number that matches.
    await screen.findAllByText('#1');
    await screen.findAllByText(/42/);
  });

  it('reads page and sort back off the URL — a navigation round-trip lands on the same view', async () => {
    const seen = useJsonTable('payments', Array.from({ length: 42 }, (_, i) => payment(i)));

    renderAt('/payments?page=2&sort=date.asc', '/payments', <Payments />);

    // ?page=2 is the second page: offset 15, so the first visible payment is #16.
    await screen.findAllByText('#16');
    expect(seen[0].url.searchParams.get('offset')).toBe('15');
    expect(seen[0].url.searchParams.get('order')).toBe('paid_date.asc,id.asc');
  });

  it('recovers a page that no longer exists: Hebrew note, and the URL catches up', async () => {
    useJsonTable('payments', Array.from({ length: 12 }, (_, i) => payment(i)));

    renderAt('/payments?page=9', '/payments', <Payments />);

    // fetchServerList already served the last page that exists; the screen's half of the
    // contract is the visible sentence and moving its own URL state.
    await screen.findByText(PAGE_NO_LONGER_EXISTS);
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/payments'));
    await screen.findAllByText('#1');
  });

  it('lets ?id= bypass every other filter, and drops a pin that no longer answers', async () => {
    const seen = useJsonTable('payments', Array.from({ length: 3 }, (_, i) => payment(i)));

    renderAt('/payments?id=missing&month=2026-05', '/payments', <Payments />);

    // The pinned request carries only the id — the month must not narrow a direct link.
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0].url.searchParams.get('id')).toBe('eq.missing');
    expect(seen[0].url.searchParams.getAll('paid_date')).toEqual([]);

    // Nothing answers the pin, so it clears itself — and the month filter comes back into force.
    await waitFor(() => expect(screen.getByTestId('url').textContent).toBe('/payments?month=2026-05'));
    await screen.findAllByText('#1');
    const last = seen[seen.length - 1];
    expect(last.url.searchParams.get('id')).toBeNull();
    expect(last.url.searchParams.getAll('paid_date')).toEqual(['gte.2026-05-01', 'lt.2026-06-01']);
  });
});

describe('/invoices — server mode', () => {
  const useBalances = () => {
    const seen: Seen[] = [];
    server.use(http.get(`${SUPABASE_URL}/rest/v1/invoice_balances`, ({ request }) => {
      const url = new URL(request.url);
      seen.push({ url, method: request.method });
      const list = url.searchParams.get('invoice_id')?.replace(/^in\.\(|\)$/g, '').split(',') ?? [];
      return HttpResponse.json(list.map((id) => ({ invoice_id: id, balance: 0 })));
    }));
    return seen;
  };

  it('sends the attention filter as the 0053 computed field, with deleted_at always alongside', async () => {
    const seen = useJsonTable('invoices', [invoiceRow(0)]);
    useBalances();

    renderAt('/invoices?attention=duplicates', '/invoices', <InvoicesList />);

    await screen.findAllByText('N-0');
    // The whole-table question the old per-page computation could not answer (ADR-0007).
    expect(seen[0].url.searchParams.get('invoice_has_duplicate')).toBe('eq.true');
    // Always sent: the 0053 indexes are partial on `deleted_at is null`.
    expect(seen[0].url.searchParams.get('deleted_at')).toBe('is.null');
  });

  it('fetches balances for the visible page ids only, not the whole table', async () => {
    useJsonTable('invoices', Array.from({ length: 20 }, (_, i) => invoiceRow(i)));
    const balances = useBalances();

    renderAt('/invoices', '/invoices', <InvoicesList />);

    await screen.findAllByText('N-0');
    expect(balances).toHaveLength(1);
    const asked = balances[0].url.searchParams.get('invoice_id');
    // Exactly this page's ids — balance display no longer costs a whole-table pull.
    expect(asked).toBe(`in.(${Array.from({ length: 15 }, (_, i) => `inv-${i}`).join(',')})`);
  });

  it('states visibly when the supplier arm of a search was narrowed away', async () => {
    const seen = useJsonTable('invoices', [invoiceRow(0)]);
    useBalances();
    server.use(http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, ({ request }) => {
      const limit = Number(new URL(request.url).searchParams.get('limit') ?? '999');
      return HttpResponse.json(
        Array.from({ length: Math.min(limit, SUPPLIER_SEARCH_ID_CAP + 1) }, (_, i) => ({ id: `sup-${i}` })),
      );
    }));

    renderAt('/invoices?q=בע', '/invoices', <InvoicesList />);

    // The count on screen is the count of the filter that ran — so the narrowing must be said.
    await screen.findByText(SUPPLIER_SEARCH_NARROWED);
    await screen.findAllByText('N-0');
    const listRequest = seen[0];
    expect(listRequest.url.searchParams.get('or')).toBe('(invoice_number.ilike.%בע%)');
    expect(listRequest.url.toString()).not.toContain('supplier_id.in');
  });
});

describe('/bank — server mode', () => {
  it('maps the attention status to in(unmatched,suggested) and the month onto tx_date', async () => {
    const seen = useJsonTable('bank_transactions', [bankTx(0)]);
    server.use(http.get(`${SUPABASE_URL}/rest/v1/bank_imports`, () => HttpResponse.json([])));

    renderAt('/bank?status=attention&month=2026-07', '/bank', <Bank />);

    await screen.findAllByText('העברה 0');
    expect(seen[0].url.searchParams.get('status')).toBe('in.(unmatched,suggested)');
    expect(seen[0].url.searchParams.getAll('tx_date')).toEqual(['gte.2026-07-01', 'lt.2026-08-01']);
  });
});

describe('active-persona boundaries for the without-order signal', () => {
  // Filesystem paths from the vitest root: under the jsdom transform `import.meta.url` is an
  // http URL, not a file one.
  const srcDir = join(process.cwd(), 'src');
  const appSource = readFileSync(join(srcDir, 'App.tsx'), 'utf8');

  it('keeps /invoices behind the three-role READERS contract', () => {
    const readers = /const READERS: readonly ActiveRole\[\] = \[([^\]]*)\]/.exec(appSource);
    expect(readers).not.toBeNull();
    expect(readers![1]).toContain('owner');
    expect(readers![1]).toContain('office');
    expect(readers![1]).toContain('accountant');
    expect(readers![1]).not.toMatch(/kitchen|payer|supplier/);
    expect(appSource).toMatch(/path="\/invoices" element=\{<Guard roles=\{READERS\}>/);
  });

  /**
   * Every source file under a directory, recursively, as slash-joined relative paths.
   *
   * The scan is recursive so a future nested screen cannot acquire the signal unnoticed.
   */
  const sourceFilesUnder = (dir: string, extensions: string[]): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.isDirectory()) {
        return sourceFilesUnder(join(dir, entry.name), extensions)
          .map((child) => `${entry.name}/${child}`);
      }
      const isSource = extensions.some((extension) => entry.name.endsWith(extension));
      return isSource && !entry.name.includes('.spec.') && !entry.name.includes('.test.')
        ? [entry.name]
        : [];
    });

  const holdersOf = (dir: string, extensions: string[], needle: string): string[] =>
    sourceFilesUnder(dir, extensions)
      .filter((name) => readFileSync(join(dir, name), 'utf8').includes(needle))
      .sort();

  it('keeps invoice_without_order out of every other screen, at any depth', () => {
    expect(holdersOf(join(srcDir, 'pages'), ['.tsx'], 'invoice_without_order'))
      .toEqual(['Invoices.tsx']);
  });

  /**
   * The RPC stays behind the one active finance caller in the client. Migration 0133 independently
   * enforces the server-side persona boundary.
   */
  it('keeps the invoice_without_order RPC to one caller behind the active finance guard', () => {
    const libDir = join(srcDir, 'lib');
    expect(holdersOf(libDir, ['.ts', '.tsx'], 'p2_invoice_without_order_count'))
      .toEqual(['alerts.ts']);
    // serverList.ts names the PostgREST computed field in prose only; that is the guarded
    // screen path, not the RPC. Pinned so a future write there is a decision, not a drift.
    expect(holdersOf(libDir, ['.ts', '.tsx'], 'invoice_without_order'))
      .toEqual(['alerts.ts', 'serverList.ts']);

    // alerts.ts is reachable only through /alerts, and /alerts is FINANCE-only.
    const finance = /const FINANCE: readonly ActiveRole\[\] = \[([^\]]*)\]/.exec(appSource);
    expect(finance).not.toBeNull();
    expect(finance![1]).not.toMatch(/kitchen|payer|supplier/);
    expect(appSource).toMatch(/path="\/alerts" element=\{<Guard roles=\{FINANCE\}>/);
  });
});
