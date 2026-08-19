/**
 * The manual-product door: two writes, in order, and exactly once each.
 *
 * A product the catalogue never heard of needs a `products` row AND a `supplier_products` row
 * before it can enter an order — the second is the only representation of "belongs to אחים כהן",
 * and without it the line is blocked on step 2 as `no_offers`. The two writes cannot be one
 * transaction from a browser, so the branch that matters is the half-failure: the product landed,
 * the price command did not. A retry there must price the SAME product. `products` has no unique
 * constraint on name, so a second insert would silently fork the catalogue under a success toast —
 * which is precisely the failure this suite exists to catch.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { ToastProvider } from './ui';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

const auth = vi.hoisted(() => ({
  current: {
    profile: { id: 'user-1', org_id: 'org-test', role: 'office' } as { id: string; org_id: string; role: string },
    org: { vat_rate: 18 },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth.current }));

import { QuickCreateProduct, quickProductRow } from './QuickCreateProduct';

const PRODUCTS_ENDPOINT = `${SUPABASE_URL}/rest/v1/products`;
const IMPORT_ENDPOINT = `${SUPABASE_URL}/rest/v1/rpc/import_supplier_prices`;
const SUPPLIERS = [{ id: 'sup-cohen', name: 'אחים כהן' }];
const CREATED = {
  id: 'prod-new', org_id: 'org-test', name: 'עגבניות שרי', category_id: null,
  unit: 'ק"ג', sku: null, barcode: null, notes: null, active: true, min_stock: null,
};

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => {
  auth.current = {
    profile: { id: 'user-1', org_id: 'org-test', role: 'office' },
    org: { vat_rate: 18 },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  };
  // The duplicate-name probe runs before the insert; an empty catalogue is the no-collision path.
  server.use(http.get(PRODUCTS_ENDPOINT, () => HttpResponse.json([])));
});

const wrap = (children: ReactNode) => <ToastProvider>{children}</ToastProvider>;

/** Records both writes in one ordered log, so "which ran first" is an assertion and not a guess. */
function recordWrites(options: { importFails?: boolean } = {}) {
  const calls: { endpoint: 'products' | 'import'; body: Record<string, unknown> }[] = [];
  server.use(
    http.post(PRODUCTS_ENDPOINT, async ({ request }) => {
      const parsed = (await request.json()) as Record<string, unknown> | Record<string, unknown>[];
      calls.push({ endpoint: 'products', body: Array.isArray(parsed) ? parsed[0] : parsed });
      return HttpResponse.json(CREATED);
    }),
    http.post(IMPORT_ENDPOINT, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ endpoint: 'import', body });
      return options.importFails
        ? HttpResponse.json({ message: 'price_import_target_invalid' }, { status: 400 })
        : HttpResponse.json({ updated: 0, created: 1, unchanged: 0 });
    }),
  );
  return calls;
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByLabelText('שם המוצר *'));
  await user.type(screen.getByLabelText('שם המוצר *'), 'עגבניות שרי');
  await user.clear(screen.getByLabelText('יחידת מידה'));
  await user.type(screen.getByLabelText('יחידת מידה'), 'ק"ג');
  await user.type(screen.getByLabelText('מחיר ליחידה *'), '12.5');
  await user.selectOptions(screen.getByLabelText('ספק *'), 'sup-cohen');
}

/**
 * Wait for ONE NAMED alert, not for "an alert" (DEBT §52).
 *
 * This screen can hold two role="alert" nodes at once: the validation note, and the duplicate-
 * name note that arrives asynchronously once the catalogue lookup for the typed name resolves.
 * `findByText` raced on which TEXT existed and `findByRole('alert')` raced on which ALERT came
 * first — both are races, which is why the failure looked intermittent and environment-shaped and
 * why re-running it "fixed" it. Waiting for the condition "some alert says this" is the state the
 * component actually reaches, and it does not care how many alerts are up or in what order they
 * arrived. Measured over ten consecutive runs before this was called closed.
 */
async function expectAlertSaying(pattern: RegExp) {
  await waitFor(() => {
    const said = screen.getAllByRole('alert').some((el) => pattern.test(el.textContent ?? ''));
    expect(said).toBe(true);
  });
}

describe('quickProductRow — the closed payload', () => {
  it('writes only the four columns the browser is granted, with the unit normalised', () => {
    expect(quickProductRow('org-test', '  עגבניות שרי  ', ' יח ')).toEqual({
      org_id: 'org-test', name: 'עגבניות שרי', unit: 'יחידה', active: true,
    });
  });
});

describe('QuickCreateProduct', () => {
  it('creates the product, then prices it for the chosen supplier, then hands it back', async () => {
    const user = userEvent.setup();
    const calls = recordWrites();
    const created = vi.fn();
    render(wrap(<QuickCreateProduct suppliers={SUPPLIERS} onClose={() => {}} onCreated={created} />));

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'הוספה להזמנה' }));

    await waitFor(() => expect(created).toHaveBeenCalledWith(CREATED));
    // Order is the contract: import_supplier_prices needs a product_id that already exists.
    expect(calls.map((call) => call.endpoint)).toEqual(['products', 'import']);
    // Typed with an ASCII quote, stored with the Hebrew gershayim — normalizeUnitInput runs on the
    // way in, so the catalogue does not accumulate two spellings of one unit.
    expect(calls[0].body).toEqual({ org_id: 'org-test', name: 'עגבניות שרי', unit: 'ק״ג', active: true });
    expect(calls[1].body.p_rows).toEqual([
      { supplier_id: 'sup-cohen', product_id: 'prod-new', price: 12.5, available: true },
    ]);
    // reasonOr marks an unedited reason as the system's own sentence rather than passing a typed
    // justification off as one — the audit row says which it was.
    expect(calls[1].body.p_reason).toBe('הוספת מוצר ומחיר מתוך הזמנה חדשה — ללא הערה מהמשתמש');
  });

  it('does not write at all when the supplier is missing — the price row is the whole point', async () => {
    const user = userEvent.setup();
    const calls = recordWrites();
    render(wrap(<QuickCreateProduct suppliers={SUPPLIERS} onClose={() => {}} onCreated={() => {}} />));

    await user.type(screen.getByLabelText('שם המוצר *'), 'עגבניות שרי');
    await user.type(screen.getByLabelText('מחיר ליחידה *'), '12.5');
    await user.click(screen.getByRole('button', { name: 'הוספה להזמנה' }));

    await expectAlertSaying(/יש לבחור ספק/);
    expect(calls).toEqual([]);
  });

  it('refuses a price of zero or above the command ceiling before the round trip', async () => {
    const user = userEvent.setup();
    const calls = recordWrites();
    render(wrap(<QuickCreateProduct suppliers={SUPPLIERS} onClose={() => {}} onCreated={() => {}} />));

    await user.type(screen.getByLabelText('שם המוצר *'), 'עגבניות שרי');
    await user.selectOptions(screen.getByLabelText('ספק *'), 'sup-cohen');
    await user.type(screen.getByLabelText('מחיר ליחידה *'), '0');

    // THE ROOT OF DEBT §52, found 19.08.2026. `save()` validates in order — name, then SUPPLIER,
    // then price — and returns at the first failure. If the supplier select has not yet reached
    // React state when the click lands, the component honestly reports "יש לבחור ספק" and this
    // test, which is about the price, waits forever for a message it made impossible. That is why
    // it failed intermittently, why the frequency tracked CPU load, and why re-running "fixed" it.
    // Asserting the preconditions before pressing removes the race instead of widening a timeout.
    await waitFor(() => {
      expect((screen.getByLabelText('ספק *') as HTMLSelectElement).value).toBe('sup-cohen');
      expect((screen.getByLabelText('מחיר ליחידה *') as HTMLInputElement).value).toBe('0');
    });
    await user.click(screen.getByRole('button', { name: 'הוספה להזמנה' }));

    await expectAlertSaying(/מחיר גדול מאפס/);
    expect(calls).toEqual([]);
  });

  it('retries the PRICE after a failed price command, never a second product row', async () => {
    const user = userEvent.setup();
    const calls = recordWrites({ importFails: true });
    const created = vi.fn();
    render(wrap(<QuickCreateProduct suppliers={SUPPLIERS} onClose={() => {}} onCreated={created} />));

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'הוספה להזמנה' }));

    // The half-failure is reported as what it is, with the next step named.
    await expectAlertSaying(/המוצר נוצר בקטלוג אך עדיין ללא מחיר לספק/);
    expect(created).not.toHaveBeenCalled();
    expect(calls.map((call) => call.endpoint)).toEqual(['products', 'import']);

    // Second press: the product row is reused, so the catalogue does not fork.
    server.use(http.post(IMPORT_ENDPOINT, async ({ request }) => {
      calls.push({ endpoint: 'import', body: (await request.json()) as Record<string, unknown> });
      return HttpResponse.json({ updated: 0, created: 1, unchanged: 0 });
    }));
    await user.click(screen.getByRole('button', { name: 'הוספה להזמנה' }));

    await waitFor(() => expect(created).toHaveBeenCalledWith(CREATED));
    expect(calls.map((call) => call.endpoint)).toEqual(['products', 'import', 'import']);
  });
});
