import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

/**
 * RTL-A11Y-03 (/prices) and RTL-A11Y-04 (/suppliers).
 *
 * The `ui.tsx` override alone closes neither. Measured on this tree, exactly three screens pass
 * `columnPicker` — /payments, /invoices and /bank — so on /prices and /suppliers the mobile sheet
 * held the screen's filters and nothing else: there was no control a viewer could use to bring a
 * `priority: 3` column back, and every one of them was dropped from the card unconditionally.
 *
 * /prices lost יחידה and מחיר קודם — a price with no unit is not comparable with the price beside
 * it, and a −74.4% change is shown with the number it changed from removed, on the screen whose
 * whole job is comparison. /suppliers lost דירוג, קטגוריות, איש קשר and מינ׳ הזמנה — and the
 * minimum order decides whether an order can be placed at all.
 *
 * These render the real screens at 390px. The claim is the viewer's: open the sheet, tick the
 * column, and the card carries it.
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
    profile: { id: 'user-1', role: 'owner', org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {}, base_currency: 'ILS' },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import PriceLists from './PriceLists';
import { SuppliersList } from './Suppliers';

/** jsdom has no matchMedia and `useMediaQuery` then answers desktop, so a phone must be stated. */
function phone() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
    }),
  });
}

/** Both bodies are mounted and hidden with CSS, so every mobile claim is scoped to a card. */
const cards = () => Array.from(document.querySelectorAll('li.mobile-data-card')) as HTMLElement[];

const openSheet = () => {
  fireEvent.click(screen.getByRole('button', { name: /סינון ותצוגה/ }));
  return screen.getByRole('dialog', { name: 'סינון ותצוגה' });
};

/** Tick a column in the sheet's checklist, asserting first that it reads as off. */
const turnOn = (header: string) => {
  const box = screen.getByRole('checkbox', { name: header });
  expect(box).not.toBeChecked();
  fireEvent.click(box);
};

function wrap(path: string, route: string, element: React.ReactNode) {
  render(
    <LocaleProvider initialLocale="he">
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes><Route path={route} element={element} /></Routes>
            </MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => { localStorage.clear(); phone(); });
afterEach(() => Reflect.deleteProperty(window, 'matchMedia'));

describe('/prices at 390px — the unit and the previous price are reachable (RTL-A11Y-03)', () => {
  beforeEach(() => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([{
        id: 'sp-1', org_id: 'org-test', supplier_id: 'sup-1', product_id: 'p1',
        current_price: 3.2, previous_price: 12.5, price_effective_date: '2026-08-01',
        available: true, supplier_sku: null, min_qty: null, package_size: null,
        updated_at: '2026-08-01', currency: 'ILS',
        supplier: { id: 'sup-1', name: 'משק ירוק', status: 'active' },
        product: { id: 'p1', name: 'חסה ערבית', unit: 'kg' },
      }])),
      http.get(`${SUPABASE_URL}/rest/v1/supplier_price_submissions`, () => HttpResponse.json([])),
    );
  });

  it('offers a column checklist in the mobile sheet at all', async () => {
    wrap('/prices', '/prices', <PriceLists />);
    expect((await screen.findAllByText('משק ירוק')).length).toBeGreaterThan(0);
    openSheet();
    expect(screen.getByRole('group', { name: 'בחירת עמודות' })).toBeInTheDocument();
  });

  it('puts יחידה and מחיר קודם on the card when the viewer turns them on', async () => {
    wrap('/prices', '/prices', <PriceLists />);
    expect((await screen.findAllByText('משק ירוק')).length).toBeGreaterThan(0);

    // The measured state: a price with no unit beside it, and a change with no base.
    expect(within(cards()[0]).queryByText('יחידה:')).not.toBeInTheDocument();
    expect(within(cards()[0]).queryByText('מחיר קודם:')).not.toBeInTheDocument();

    openSheet();
    turnOn('יחידה');
    turnOn('מחיר קודם');

    expect(within(cards()[0]).getByText('יחידה:')).toBeInTheDocument();
    expect(within(cards()[0]).getByText('מחיר קודם:')).toBeInTheDocument();
    // The base the −74.4% was computed from is now on the card with it.
    expect(within(cards()[0]).getByText(/12\.50/)).toBeInTheDocument();
  });
});

describe('/suppliers at 390px — rating, categories, contact and minimum order (RTL-A11Y-04)', () => {
  beforeEach(() => {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([{
        id: 'sup-1', org_id: 'org-test', name: 'אחים כהן', tax_id: null,
        contact_name: 'סיגל אברהם', phone: '02-5891000', whatsapp: null, email: null,
        address: null, min_order_amount: 1250, payment_terms: null, notes: null,
        status: 'active', delivery_days: [], cutoff_time: null, default_currency: 'ILS',
        country_code: 'IL', deleted_at: null, created_at: '2026-07-01', updated_at: '2026-07-27',
        rating: 4, rating_updated_at: null, rating_note: null,
        supplier_categories: [{ category_id: 'c1', categories: { name: 'ירקות' } }],
      }])),
      http.get(`${SUPABASE_URL}/rest/v1/supplier_balances_by_currency`, () => HttpResponse.json([])),
      http.get(`${SUPABASE_URL}/rest/v1/supplier_metrics`, () => HttpResponse.json([])),
    );
  });

  it('offers a column checklist in the mobile sheet at all', async () => {
    wrap('/suppliers', '/suppliers', <SuppliersList />);
    expect((await screen.findAllByText('אחים כהן')).length).toBeGreaterThan(0);
    openSheet();
    expect(screen.getByRole('group', { name: 'בחירת עמודות' })).toBeInTheDocument();
  });

  it('puts איש קשר and מינ׳ הזמנה on the card when the viewer turns them on', async () => {
    wrap('/suppliers', '/suppliers', <SuppliersList />);
    expect((await screen.findAllByText('אחים כהן')).length).toBeGreaterThan(0);

    expect(within(cards()[0]).queryByText('איש קשר:')).not.toBeInTheDocument();
    expect(within(cards()[0]).queryByText('מינ׳ הזמנה:')).not.toBeInTheDocument();

    openSheet();
    turnOn('איש קשר');
    turnOn('מינ׳ הזמנה');
    turnOn('דירוג');
    turnOn('קטגוריות');

    const card = cards()[0];
    expect(within(card).getByText('איש קשר:')).toBeInTheDocument();
    expect(within(card).getByText('סיגל אברהם')).toBeInTheDocument();
    // The figure that decides whether an order can be placed at all.
    expect(within(card).getByText(/1,250\.00/)).toBeInTheDocument();
    expect(within(card).getByText('ירקות')).toBeInTheDocument();
  });
});
