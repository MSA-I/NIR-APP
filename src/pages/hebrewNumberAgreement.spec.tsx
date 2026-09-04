import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { LocaleProvider, translateIn } from '../lib/i18n/LocaleProvider';

/**
 * ONE ORACLE FOR FOUR FINDINGS OF THE 2026-09-04 SWEEP, because they are one defect wearing four
 * screens: a number is printed beside a noun that never agrees with it.
 *
 *   ENTRY-08  /pricing publishes «1 משתמשים פעילים» and «1 סניפים» to a logged-out visitor.
 *   PL-09     the price-list import preview says «1 מוצרים חדשים», and its own checkbox offers to
 *             create one product «ועדכן את מחירם» — their price, for a single product.
 *   PROC-05   /orders/new confirms the product's central action with «נוצרו 1 הזמנות ספק».
 *   FIN-05    /credits prints the raw dictionary key `creditReason_returned` where the reason
 *             belongs. Different in kind, same screen-facing failure: the reader is shown the
 *             machinery instead of the sentence.
 *
 * WHY EVERY CASE IS ASSERTED TWICE — at one and at many. Hebrew has one/two/many/other, so a test
 * that only pins the plural form passes against the defect: the plural form is the form that was
 * already there. The pair is the check. `Intl.PluralRules` decides which form applies
 * (`src/lib/i18n/t.ts`), never a hand-rolled `=== 1`, and never string concatenation.
 *
 * WHY THE `_one` SIBLING AND NOT ICU. `t.ts` states the rule and the reason: an ICU plural puts a
 * language rule inside a translation file. The mechanism here is a second key, `<key>_one`, which
 * `t()` reaches for when `vars.count` selects the `one` category — the same door
 * `scripts/check-plurals.mjs` counts.
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
    org: { id: 'org-test', base_currency: 'ILS', settings: {} },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import Pricing from './Pricing';
import Credits from './Credits';
import { PriceListUploadModal } from '../components/PriceListUpload';

const wrap = (node: ReactNode) => render(
  <LocaleProvider initialLocale="he">
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter>{node}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  </LocaleProvider>,
);

/* ------------------------------------------------------------------ ENTRY-08 — /pricing */

const PLAN_CATALOGUE = [
  { plan_key: 'free', label: 'חינם', tier_order: 1, currency: 'ILS', catalogue_version: 'il-2026-08', monthly_amount: 0, yearly_amount: null },
  { plan_key: 'pro', label: 'פרו', tier_order: 3, currency: 'ILS', catalogue_version: 'il-2026-08', monthly_amount: 249, yearly_amount: 2490 },
];

const quota = (planKey: string, key: string, label: string, limit: number) => ({
  plan_key: planKey, entitlement_key: key, label, unit: 'units',
  unlimited: false, numeric_limit: limit, measured: true,
});

/**
 * The pair the finding names, on one page: the free rung is capped at ONE of each, the paid rung
 * at many. Both rungs are rendered by the same code path, so the two assertions differ only in
 * the number the server sent.
 */
const PLAN_QUOTAS = [
  quota('free', 'documents.monthly', 'מסמכים', 25),
  quota('pro', 'documents.monthly', 'מסמכים', 300),
  quota('free', 'users.max', 'משתמשים', 1),
  quota('pro', 'users.max', 'משתמשים', 15),
  quota('free', 'branches.max', 'סניפים', 1),
  quota('pro', 'branches.max', 'סניפים', 10),
];

const rpcOnce = (name: string, body: JsonBodyType) =>
  http.post(`${SUPABASE_URL}/rest/v1/rpc/${name}`, () => HttpResponse.json(body));

function wirePricing() {
  server.use(
    rpcOnce('get_public_plan_catalogue', PLAN_CATALOGUE),
    rpcOnce('get_public_plan_quotas', PLAN_QUOTAS),
    rpcOnce('get_public_plan_features', []),
  );
}

const planCard = (planKey: string) =>
  (screen.getByTestId('plan-cards').querySelector(`[data-plan="${planKey}"]`) as HTMLElement).textContent ?? '';

describe('ENTRY-08 — the public pricing page agrees in number', () => {
  beforeEach(wirePricing);

  it('says «1 משתמש פעיל» on the rung capped at one, and «15 משתמשים פעילים» on the rung that is not', async () => {
    wrap(<Pricing />);
    await screen.findByTestId('plan-cards');

    expect(planCard('free')).toContain('1 משתמש פעיל');
    expect(planCard('free')).not.toContain('משתמשים פעילים');
    expect(planCard('pro')).toContain('15 משתמשים פעילים');
  });

  it('says «1 סניף» on the rung capped at one, and «10 סניפים» on the rung that is not', async () => {
    wrap(<Pricing />);
    await screen.findByTestId('plan-cards');

    expect(planCard('free')).toContain('1 סניף');
    expect(planCard('free')).not.toContain('סניפים');
    expect(planCard('pro')).toContain('10 סניפים');
  });
});

/* ------------------------------------------------------------------ PL-09 — the import preview */

const SUPPLIER = { id: 'sup-alpha', name: 'ספק אלפא', status: 'active', default_currency: 'ILS' };

/**
 * One row that matches the catalogue, one row that does not (a NEW product), and one row the
 * `0298` price parser refuses — file line 4. Exactly one of each, which is the case the screen
 * gets wrong.
 */
const ONE_OF_EACH = [
  'מוצר,מחיר',
  'עגבניות,9.50',
  'מוצר חדש,7.00',
  'בצל,לא ידוע',
].join('\n');

/** The same sheet with two of each, so the plural form has to be the one that survives. */
const TWO_OF_EACH = [
  'מוצר,מחיר',
  'עגבניות,9.50',
  'מוצר חדש,7.00',
  'מוצר חדש נוסף,8.00',
  'בצל,לא ידוע',
  'שום,לא ידוע',
].join('\n');

function wireUpload() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json(SUPPLIER)),
    http.get(`${SUPABASE_URL}/rest/v1/currencies`, () => HttpResponse.json([{ code: 'ILS' }])),
    http.get(`${SUPABASE_URL}/rest/v1/products`, () =>
      HttpResponse.json([{ id: 'prod-tomato', name: 'עגבניות', active: true }])),
  );
}

/** Opens the per-supplier price-list door and walks it as far as the preview. */
async function previewSheet(csv: string) {
  wrap(<PriceListUploadModal supplier={{ id: SUPPLIER.id, name: SUPPLIER.name }} onClose={() => {}} />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([csv], 'prices.csv', { type: 'text/csv' })] } });
  // The primary stays disabled while the supplier list loads, and a click on a disabled button is
  // silently nothing — which on screen is indistinguishable from a file the door refused.
  const go = screen.getByRole('button', { name: translateIn('he', 'priceUpload.isSpreadsheet') });
  await waitFor(() => expect(go).toBeEnabled(), { timeout: 3_000 });
  fireEvent.click(go);
  // The disclosure only exists once the preview has been built, so awaiting it is awaiting the
  // whole preview — summary sentence, skipped note and creation checkbox together.
  await screen.findByText(translateIn('he', 'priceUpload.text_8'));
}

describe('PL-09 — the price-list import preview agrees in number', () => {
  beforeEach(wireUpload);

  it('counts one new product, one skipped row and one source line in the singular', async () => {
    await previewSheet(ONE_OF_EACH);
    const screenText = document.body.textContent ?? '';

    // The summary sentence. «1 מוצרים חדשים» is the wording the sweep read.
    expect(screenText).toContain('מוצר חדש אחד');
    expect(screenText).not.toContain('1 מוצרים חדשים');
    // The skipped-rows note, and the line list inside its disclosure — one row, one line.
    expect(screenText).not.toContain('1 שורות דולגו');
    expect(screenText).toContain('שורה אחת דולגה');
    expect(screenText).toContain('— שורה 4');
    expect(screenText).not.toContain('— שורות 4');
    // The checkbox that performs the creation: one product, ITS price.
    expect(screenText).toContain('צור מוצר חדש אחד בקטלוג ועדכן את מחירו');
    expect(screenText).not.toContain('ועדכן את מחירם');
  });

  it('keeps the plural form when there really are two of each', async () => {
    await previewSheet(TWO_OF_EACH);
    const screenText = document.body.textContent ?? '';

    expect(screenText).toContain('2 מוצרים חדשים');
    expect(screenText).toContain('2 שורות דולגו');
    expect(screenText).toContain('— שורות 5, 6');
    expect(screenText).toContain('ועדכן את מחירם');
    expect(screenText).not.toContain('מוצר חדש אחד');
  });
});

/* ------------------------------------------------------------------ PROC-05 — /orders/new */

const NEW_ORDER = path.join(process.cwd(), 'src/pages/neworder/NewOrder.tsx');

describe('PROC-05 — the supplier-order confirmation agrees in number', () => {
  it('confirms one order in the singular and three in the plural, in both locales', () => {
    expect(translateIn('he', 'newOrder.ordersCreated', { count: 1 })).toBe('נוצרה הזמנת ספק אחת');
    expect(translateIn('he', 'newOrder.ordersCreated', { count: 3 })).toBe('נוצרו 3 הזמנות ספק');
    expect(translateIn('en', 'newOrder.ordersCreated', { count: 1 })).toBe('One supplier order was created');
    expect(translateIn('en', 'newOrder.ordersCreated', { count: 3 })).toBe('3 supplier orders were created');
  });

  /**
   * The dictionary can only answer if the screen asks with a count. Without `{ count }` in the
   * call, `t()` never reaches `pluralKey` and the singular sibling is unreachable — a green
   * dictionary test beside a screen that still says «נוצרו 1 הזמנות ספק».
   */
  it('is asked with the count the toast is about', () => {
    expect(readFileSync(NEW_ORDER, 'utf8'))
      .toMatch(/t\('newOrder\.ordersCreated',\s*\{\s*count:/);
  });
});

/* ------------------------------------------------------------------ FIN-05 — /credits */

const CREDIT_ROW = {
  id: 'credit-1', number: 41, supplier_id: 'sup-alpha', invoice_id: null, invoice: null,
  reason: 'returned', status: 'open', amount: 120.5, currency: 'ILS',
  created_at: '2026-08-02T09:00:00Z', notes: null,
};

function wireCredits() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () => HttpResponse.json([CREDIT_ROW])),
    http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_directory`, () => HttpResponse.json([
      { id: 'sup-alpha', name: 'ספק אלפא', tax_id: null, payment_terms: null, status: 'active', bank_details: null },
    ])),
  );
}

/** Every production file under `src/`, so a scan cannot miss a door by not knowing about it. */
function productionFiles(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) { productionFiles(full, out); continue; }
    if (!/\.tsx?$/.test(entry) || /\.spec\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe('FIN-05 — the credit reason reaches the screen as words', () => {
  beforeEach(wireCredits);

  it('prints «החזרת סחורה» in the table and in the credit card, never the key', async () => {
    wrap(<Credits />);

    // More than one match on purpose: `DataTable` draws the desktop row and the phone card from
    // the same column definition, so a fix that reached only one of them would still be half done.
    const listed = await screen.findAllByText('החזרת סחורה');
    expect(listed.length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('creditReason_');

    // The same value again in the detail card, which reads the map through its own expression.
    fireEvent.click(listed[0]);
    const card = await screen.findByRole('dialog');
    expect(within(card).getByText('החזרת סחורה')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('creditReason_');
  });

  /**
   * `CREDIT_REASON` is a `Record<value, dictionary key>` — rendering it directly puts the key on
   * screen, and three doors read it. The rendered assertion above covers `/credits`; this closes
   * the class, so the supplier card cannot quietly keep the defect the credits table just lost.
   */
  it('has no door left that renders the map without resolving it', () => {
    const offenders: string[] = [];
    for (const file of productionFiles(path.join(process.cwd(), 'src'))) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (!line.includes('CREDIT_REASON[')) return;
        if (line.includes('statusLabel(')) return;
        offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
