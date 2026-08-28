/**
 * The remedy for "מוצר לא מזוהה", asserted as a control rather than as a sentence.
 *
 * The screen has named this problem since 0110 and offered nothing to fix it — the reviewer's only
 * route was to leave, build the catalogue by hand, and re-open the document.
 *
 * The SHAPE is half of what is asserted, because the first build got it wrong and the owner said
 * so (28.08.2026): "אין צורך שעבור כל פריט יהיה כפתור משלו כי זה יוצר עומס, וברשימה של מאות
 * מוצרים לא רואים את הסוף." A real price list is hundreds of lines. So: one quiet row per line
 * with its details behind a press, a checkbox on each, and ONE action over the selection — and
 * these tests fail if a per-line dialog ever comes back.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../test/msw/server';
import { SUPABASE_URL } from '../../test/msw/handlers';
import { ToastProvider } from '../ui';
import type { AssessmentLine } from './assessment';

vi.mock('../../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-test', role: 'owner' },
    org: { vat_rate: 18 },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { DocumentLineMapping, lineFacts, lineTitle, planBulkCreate } from './DocumentLineMapping';

const PRODUCTS = `${SUPABASE_URL}/rest/v1/products`;
const IMPORT = `${SUPABASE_URL}/rest/v1/rpc/import_supplier_prices`;

function line(index: number, over: Partial<AssessmentLine> = {}): AssessmentLine {
  return {
    line_index: index,
    description: `עגבניות שרי ${index + 1}`,
    sku: null, barcode: null, product_id: null, product_source: 'unmatched',
    quantity: 4, unit: 'ק"ג', unit_price: 12.5, discount_amount: null, vat_rate: 18,
    line_total: 50, normalized_quantity: 4, normalized_unit_price: 12.5,
    baseline_price: null, baseline_source: null, baseline_effective_date: null,
    overcharge_amount: null, findings: [],
    ...over,
  };
}

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => {
  server.use(http.get(PRODUCTS, () => HttpResponse.json([])));
});

function renderMapping(lines: AssessmentLine[], onMap = vi.fn(), supplierId: string | null = 'sup-1') {
  render(
    <ToastProvider>
      <DocumentLineMapping lines={lines} supplierId={supplierId} mapped={{}} onMap={onMap} />
    </ToastProvider>,
  );
  return onMap;
}

describe('the list is a selection, not a wall of controls', () => {
  it('gives each line one row with its details shut, and no per-line create button', async () => {
    renderMapping([line(0), line(1), line(2)]);
    const card = await screen.findByTestId('document-line-mapping');

    // A checkbox per line plus the "select all" one, and exactly ONE create action for all of them.
    expect(within(card).getAllByRole('checkbox')).toHaveLength(4);
    expect(within(card).getAllByRole('button', { name: /יצירת מוצרים/ })).toHaveLength(1);

    // Nothing is expanded, so no product picker exists yet. This is the assertion that fails if
    // every line's details come back onto the screen at once.
    expect(card.querySelectorAll('select')).toHaveLength(0);
    expect(within(card).getAllByRole('button', { expanded: false })).toHaveLength(3);
  });

  it('lays a line out only when it is opened, and one at a time', async () => {
    renderMapping([line(0), line(1)]);
    await screen.findByTestId('document-line-mapping');

    await userEvent.click(screen.getByRole('button', { name: /עגבניות שרי 1/ }));
    expect(screen.getByRole('button', { name: /עגבניות שרי 1/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('שיוך למוצר קיים')).toBeInTheDocument();
    expect(screen.getByText('סה״כ שורה:')).toBeInTheDocument();

    // Opening the second closes the first: two open rows is the wall again, two rows at a time.
    await userEvent.click(screen.getByRole('button', { name: /עגבניות שרי 2/ }));
    expect(screen.getByRole('button', { name: /עגבניות שרי 1/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByLabelText('שיוך למוצר קיים')).toHaveLength(1);
  });

  it('reports a picked product upward — the panel is what puts it in the proposal', async () => {
    server.use(http.get(PRODUCTS, () => HttpResponse.json([
      { id: 'prod-1', name: 'עגבניות', unit: 'ק"ג' },
      { id: 'prod-2', name: 'מלפפונים', unit: 'ק"ג' },
    ])));
    const onMap = renderMapping([line(0)]);
    await screen.findByTestId('document-line-mapping');

    await userEvent.click(screen.getByRole('button', { name: /עגבניות שרי 1/ }));
    const select = screen.getByLabelText('שיוך למוצר קיים');
    await waitFor(() => expect(screen.getByText('בחר מוצר קיים')).toBeInTheDocument());

    await userEvent.selectOptions(select, 'prod-2');
    expect(onMap).toHaveBeenCalledWith(0, 'prod-2');
    // Clearing is a decision too, and it must arrive as an absence rather than an empty string.
    await userEvent.selectOptions(select, '');
    expect(onMap).toHaveBeenLastCalledWith(0, null);
  });

  it('withholds creation, and says why, while no supplier is resolved', async () => {
    renderMapping([line(0)], vi.fn(), null);
    await screen.findByTestId('document-line-mapping');

    expect(screen.getByRole('button', { name: /יצירת מוצרים/ })).toBeDisabled();
    // A disabled control with no sentence is indistinguishable from a broken one.
    expect(screen.getByText(/כל עוד הספק לא זוהה/)).toBeInTheDocument();
  });
});

describe('creating products from a selection', () => {
  it('writes the products once and the prices once, then maps every selected line', async () => {
    const inserts: unknown[] = [];
    const prices: unknown[] = [];
    server.use(
      http.get(PRODUCTS, () => HttpResponse.json([])),
      http.post(PRODUCTS, async ({ request }) => {
        const body = await request.json();
        inserts.push(body);
        return HttpResponse.json((body as { name: string }[]).map((row, index) => ({
          id: `new-${index}`, org_id: 'org-test', name: row.name, category_id: null,
          unit: 'ק"ג', sku: null, barcode: null, notes: null, active: true, min_stock: null,
        })));
      }),
      http.post(IMPORT, async ({ request }) => { prices.push(await request.json()); return HttpResponse.json(null); }),
    );
    const onMap = renderMapping([line(0), line(1)]);
    await screen.findByTestId('document-line-mapping');

    await userEvent.click(screen.getByRole('checkbox', { name: 'בחירת הכל' }));
    await userEvent.click(screen.getByRole('button', { name: /יצירת מוצרים/ }));
    // The confirmation states what will happen before anything is written.
    expect(await screen.findByText(/2 מוצרים חדשים ייווצרו/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'יצירה' }));

    await waitFor(() => expect(prices).toHaveLength(1));
    // ONE insert and ONE price command for the whole selection — not one pair per line.
    expect(inserts).toHaveLength(1);
    expect((inserts[0] as unknown[])).toHaveLength(2);
    expect((prices[0] as { p_rows: unknown[] }).p_rows).toHaveLength(2);
    expect(onMap).toHaveBeenCalledWith(0, 'new-0');
    expect(onMap).toHaveBeenCalledWith(1, 'new-1');
  });
});

describe('what a bulk create would do, before it does it', () => {
  const catalogue = [{ id: 'prod-1', name: 'עגבניות שרי 1', unit: 'ק"ג' }];

  it('matches a name the catalogue already holds instead of forking it', () => {
    const plan = planBulkCreate([line(0)], catalogue);
    // `products` has no unique constraint on name, so a second insert would silently create a
    // duplicate under a success toast. This is the assertion that prevents it.
    expect(plan.create).toHaveLength(0);
    expect(plan.matched).toEqual([{ line: expect.objectContaining({ line_index: 0 }), productId: 'prod-1' }]);
  });

  it('creates one product for two lines naming the same thing', () => {
    const plan = planBulkCreate([line(5, { description: 'בצל' }), line(6, { description: ' בצל ' })], []);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].lines.map((row) => row.line_index)).toEqual([5, 6]);
  });

  it('names the lines it cannot create rather than dropping them quietly', () => {
    const plan = planBulkCreate([line(2, { description: null, sku: 'SKU-9' })], []);
    expect(plan.create).toHaveLength(0);
    expect(plan.unnamed.map((row) => row.line_index)).toEqual([2]);
  });

  it('prices from the normalized reading and falls back to a missing unit', () => {
    const plan = planBulkCreate(
      [line(0, { description: 'שמן', unit: null, unit_price: 120, normalized_unit_price: 12 })], []);
    expect(plan.create[0].price).toBe(12);
    expect(plan.create[0].unit).toBe('יח׳');
  });
});

describe('what a line says about itself', () => {
  it('falls back through description, sku, barcode and finally the line number', () => {
    expect(lineTitle(line(0))).toBe('עגבניות שרי 1');
    expect(lineTitle(line(0, { description: null, sku: 'SKU-9' }))).toBe('SKU-9');
    expect(lineTitle(line(0, { description: null, sku: null, barcode: '729' }))).toBe('729');
    expect(lineTitle(line(4, { description: null, sku: null, barcode: null }))).toBe('שורה 5');
  });

  it('prints only the facts the document carried — an absent quantity is not a zero', () => {
    expect(lineFacts(line(0))).toMatch(/4/);
    // An absent quantity drops the whole segment, unit included, rather than printing "0 ק"ג".
    expect(lineFacts(line(0, { quantity: null }))).not.toMatch(/ק"ג/);
    expect(lineFacts(line(0, { quantity: null, unit_price: null }))).toBe('');
  });
});
