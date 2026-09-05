/**
 * PROC-02 — the manual price editor reads a price with the SAME parser as the importer.
 *
 * THE DEFECT THIS PINS. `/prices` has two doors into `supplier_products.current_price`. The
 * importer hands the cell to `parsePrice` — the client twin of `private.parse_price`, the one
 * reading `0298` installed — and refuses `12,50` because a comma groups thousands only when it
 * groups in threes. The manual editor had no parser at all: an `<input type="number">` whose
 * value went straight to `Number()`. That is not "no parser", it is a SECOND one, owned by the
 * browser and keyed to the reader's locale: Chrome strips the group separator before the value
 * is ever read, so `12,50` arrived as 1250 and was written as ₪1,250.00 — a hundredfold error on
 * the number that then decides the cheapest supplier and the next order's unit price.
 *
 * The four cases below are the four the parser distinguishes and `Number()` cannot:
 *   `12,50`     a comma that does not group in threes — refused, never read as 1250
 *   `1.2345`    more digits than the currency has — SAYS it was rounded, and stores what it said
 *   `2000000`   above the 1,000,000 cap — refused BY THE CAP, not lumped into "invalid price"
 *   `$12.50`    a currency other than the row's — refused by name, never converted
 *   `-5`        negative — refused as not positive, with the sign preserved rather than stripped
 *
 * Each case asserts what the field holds, what the screen says, and what reached the write —
 * because the defect was invisible in exactly the first of those three.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
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
    profile: { id: 'user-1', role: 'office', org_id: 'org-test', full_name: 'רות משרד' },
    org: { id: 'org-test', settings: {} },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import PriceLists from './PriceLists';

const ROW = {
  id: 'sp-1', org_id: 'org-test', supplier_id: 'sup-1', product_id: 'p1',
  current_price: 10, previous_price: null, price_effective_date: '2026-08-01',
  currency: 'ILS', available: true, supplier_sku: null, min_qty: null, package_size: null,
  updated_at: '2026-08-01',
  supplier: { id: 'sup-1', name: 'ספק בדיקה', status: 'active', default_currency: 'ILS' },
  product: { id: 'p1', name: 'מטליות מיקרופייבר', unit: 'יח׳' },
};

/** Every body that reached `set_supplier_product_price`. The defect was a write nobody saw. */
const writes: Array<Record<string, unknown>> = [];

function wire() {
  writes.length = 0;
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([ROW])),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_price_submissions`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/set_supplier_product_price`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      writes.push(body);
      // The server's own refusal, so a client that skips the parser still fails HONESTLY here
      // rather than appearing to succeed: `0023` raises `price_values_invalid` for <= 0 and for
      // anything above the cap, with no word about which.
      const price = Number(body.p_price);
      if (!(price > 0) || price > 1_000_000) {
        return HttpResponse.json({ message: 'price_values_invalid', code: '22023' }, { status: 400 });
      }
      return HttpResponse.json({ supplier_product_id: 'sp-1', price, price_changed: true });
    }),
  );
}

function renderPrices() {
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

async function openEditor(typed: string) {
  const user = userEvent.setup();
  renderPrices();
  await user.click((await screen.findAllByRole('button', { name: /פעולות עבור מטליות מיקרופייבר אצל ספק בדיקה/ }))[0]);
  await user.click(await screen.findByRole('menuitem', { name: 'עדכון מחיר' }));
  const dialog = await screen.findByRole('dialog');
  const field = within(dialog).getByLabelText(/מחיר חדש/);
  await user.clear(field);
  await user.type(field, typed);
  return { user, dialog, field };
}

const save = async (user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) =>
  user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

beforeEach(() => { wire(); });

describe('PROC-02 — /prices manual editor: one parser for a price', () => {
  it('refuses 12,50 by its cause and writes nothing — the comma does not group in threes', async () => {
    const { user, dialog, field } = await openEditor('12,50');

    // THE WRITE IS THE FINDING, so it is asserted first: neither 1250 nor 50 nor anything else. A
    // price nobody could read is not written, and the number that IS written is never one the
    // typist did not type.
    await save(user, dialog);
    expect(writes.map((write) => write.p_price)).toEqual([]);

    // And the field holds what was typed. A number input never gets this far: the browser's own
    // sanitiser has already read the cell — in jsdom by the HTML spec, in a Hebrew-locale Chrome
    // by stripping the comma as a thousands separator — and that reading is the defect.
    expect(field).toHaveValue('12,50');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('לא ניתן לקרוא את המחיר בתא');
  });

  it('says a price was rounded to the currency\'s smallest unit, and stores exactly what it said', async () => {
    const { user, dialog, field } = await openEditor('1.2345');

    expect(field).toHaveValue('1.2345');
    expect(await within(dialog).findByText(/1\.23/)).toBeInTheDocument();

    await save(user, dialog);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].p_price).toBe(1.23);
  });

  it('refuses a price above the cap AS above the cap, without asking the server', async () => {
    const { user, dialog, field } = await openEditor('2000000');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('המחיר חורג מהתקרה של 1,000,000');

    await save(user, dialog);
    // The server lumps <= 0 and > cap into one `price_values_invalid`; the cause is on screen
    // here, so the round trip that cannot name it is never made.
    expect(writes).toHaveLength(0);
    expect(field).toHaveValue('2000000');
  });

  it('refuses a cell priced in another currency by naming both, and never converts', async () => {
    // A PRINTED SYMBOL, not a three-letter code: the editor passes no currency list, so by
    // `parsePrice`'s documented contract a bare `USD` beside an ILS row is a word it will not
    // guess at (unreadable), while `$` is a marker it resolves without one.
    const { user, dialog } = await openEditor('$12.50');

    expect(await within(dialog).findByRole('alert'))
      .toHaveTextContent('המחיר נקוב ב-USD והמחירון הזה ב-ILS');

    await save(user, dialog);
    expect(writes).toHaveLength(0);
  });

  it('refuses a negative price as not positive, not as a missing one', async () => {
    const { user, dialog } = await openEditor('-5');

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('המחיר שנקרא אינו חיובי');

    await save(user, dialog);
    expect(writes).toHaveLength(0);
  });
});
