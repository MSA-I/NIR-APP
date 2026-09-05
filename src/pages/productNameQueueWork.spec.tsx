/**
 * `PL-08` and the promise half of `PL-06` — /products → „שמות לאישור".
 *
 * PL-08. The queue is „every product whose `display_name` is null", which on this tenant is the
 * whole catalogue: 270 cards, of which the majority say, on the card itself, „זהה לשם השמור —
 * האישור מסמן שנבדק, ואינו משנה את מה שמוצג." A count offered as work has to be the work. The
 * ~39 rows stored in visual order are the ones a person has to decide, and they were mixed into a
 * majority of no-ops with no way to see how many of either there were.
 *
 * Nothing is removed from the queue and nothing is auto-approved: confirming a name that is
 * already right is a real act and the ledger records it. It is separated, and counted separately.
 *
 * PL-06's second half. The screen promises „כל אישור נרשם ביומן הביקורת" — over a ledger row that
 * `/supplier-log` now reads (see `supplierLogImportAndNames.spec.tsx`) and that only an owner can
 * open. A promise that names neither the screen nor the role is the promise the sweep called
 * unkeepable, so the sentence has to name both.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
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

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: 'office', org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {} },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { ProductNameReview } from './ProductNameReview';
import Products from './Products';
import type { Product } from '../lib/types';

const base = {
  org_id: 'org-test', category_id: null, sku: null, barcode: null, notes: null,
  active: true, min_stock: null, display_name: null,
};

/** Two rows that would change what every screen shows. Both are pinned by productDisplayName.spec. */
const PROPOSAL: Product = { ...base, id: 'p-proposal', name: 'שמן קנולה 100 מ״ל חברת דגן', unit: 'יח׳' };
const REVERSED: Product = { ...base, id: 'p-reversed', name: ')ק"ג 5( קמח לבן', unit: 'ק״ג' };

/** Three rows whose own card says approving them changes nothing that is displayed. */
const CONFIRM_ONLY: Product[] = [
  { ...base, id: 'p-salt', name: 'מלח גס', unit: 'ק״ג' },
  { ...base, id: 'p-sugar', name: 'סוכר לבן', unit: 'ק״ג' },
  { ...base, id: 'p-rice', name: 'אורז בסמטי', unit: 'ק״ג' },
];

const QUEUE = [PROPOSAL, ...CONFIRM_ONLY, REVERSED];

const NO_DRY_RUN = { has_dry_run: false, dry_run_count: 0, latest_dry_run_at: null, candidates: [] };

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/products`, () => HttpResponse.json(QUEUE)),
    http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([])),
    http.get(`${SUPABASE_URL}/rest/v1/categories`, () => HttpResponse.json([])),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/get_product_name_repair_queue`,
      () => HttpResponse.json(NO_DRY_RUN)),
  );
});

const renderQueue = () =>
  render(<ToastProvider><ProductNameReview queue={QUEUE} onApproved={vi.fn()} /></ToastProvider>);

function renderProducts() {
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <MemoryRouter initialEntries={['/products']}><Products /></MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

describe('PL-08 · התור מציע כעבודה את מה שבאמת ישתנה', () => {
  it('הלשונית סופרת את השמות שידרשו החלטה, לא את כל הקטלוג', async () => {
    renderProducts();

    const toggle = await screen.findByTestId('name-review-toggle');
    // Five products with no canonical name; two of them would change something.
    await waitFor(() => expect(toggle).toHaveTextContent(/\(2\)/), { timeout: 3_000 });
    expect(toggle).not.toHaveTextContent(/\(5\)/);
  });

  it('מפריד את האישורים שאינם משנים דבר, וסופר אותם בנפרד', async () => {
    renderQueue();

    const confirmOnly = screen.getByTestId('name-review-confirm-only');
    // The count is stated where the group is, so nothing is hidden — only moved out of the work.
    expect(confirmOnly).toHaveTextContent('3');
    for (const product of CONFIRM_ONLY) {
      expect(within(confirmOnly).getByTestId(`review-${product.id}`)).toBeInTheDocument();
    }
    // And the two that matter are NOT inside it.
    expect(within(confirmOnly).queryByTestId(`review-${PROPOSAL.id}`)).toBeNull();
    expect(within(confirmOnly).queryByTestId(`review-${REVERSED.id}`)).toBeNull();
  });

  it('בקרה — שום שורה לא נעלמת, וכל אחת עדיין ניתנת לאישור', async () => {
    const user = userEvent.setup();
    renderQueue();

    for (const product of QUEUE) {
      expect(screen.getByTestId(`review-${product.id}`)).toBeInTheDocument();
    }
    // The confirm-only group is folded, not removed: it opens, and its cards keep their button.
    await user.click(screen.getByTestId('name-review-confirm-only-summary'));
    expect(within(screen.getByTestId(`review-${CONFIRM_ONLY[0].id}`))
      .getByRole('button', { name: /^אישור$/ })).toBeInTheDocument();
  });
});

describe('PL-06 · המסך אינו מבטיח יומן שאי אפשר לפתוח', () => {
  it('אומר איפה הרישום נקרא ומי יכול לקרוא אותו', () => {
    renderQueue();

    const intro = screen.getByTestId('name-review-intro');
    expect(intro).toHaveTextContent(/יומן ביקורת|יומן הביקורת/);
    // The screen that reads it, and the role that may open it — the two things the promise omitted.
    expect(intro).toHaveTextContent(/יומן עדכון ספקים/);
    expect(intro).toHaveTextContent(/בעלים/);
  });
});
