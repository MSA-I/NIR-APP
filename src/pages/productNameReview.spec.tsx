/**
 * The naming queue's three verdicts, and the promise each one makes to the reviewer.
 *
 * A canonical name is written to every screen at once, so the value of this screen is entirely in
 * what it REFUSES to do: it never approves a name whose sizes disagree, never invents one for a
 * row stored in visual order, and never hides what it dropped on the way. Those are the three
 * assertions below, plus the one that matters to the ledger — that the write goes through
 * `set_product_display_name` carrying a reason (0149 raises `reason_required` without one).
 *
 * Assertions land on `data-verdict`, test ids and button roles rather than on composed Hebrew
 * sentences: DEBT-REGISTER §52 records a sibling suite made intermittent by exactly that, and a
 * catalogue name is the worst possible thing to match on, since a third of this fixture set is
 * malformed on purpose.
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

const authState = vi.hoisted(() => ({ role: 'office' as string }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: authState.role, org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {} },
    session: {},
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { ProductNameReview } from './ProductNameReview';
import Products from './Products';
import type { Product } from '../lib/types';

const RPC_ENDPOINT = `${SUPABASE_URL}/rest/v1/rpc/set_product_display_name`;

const base = { org_id: 'org-test', category_id: null, sku: null, barcode: null, notes: null, active: true, min_stock: null };

/**
 * Every name here is pinned by `productDisplayName.spec.ts` — the first two are the owner's own
 * example with and without its second size, the third is verbatim from the live catalogue's
 * visual-order corpus. Inventing fixtures for this screen would test a parser nobody ships.
 */
const PROPOSAL: Product = { ...base, id: 'p-proposal', name: 'שמן קנולה 100 מ״ל חברת דגן', unit: 'יח׳', display_name: null };
const CONFLICT: Product = { ...base, id: 'p-conflict', name: 'שמן קנולה 100 מ״ל חברת דגן200cc', unit: 'יח׳', display_name: null };
const BLOCKED: Product = { ...base, id: 'p-blocked', name: ')ק"ג 5( קמח לבן', unit: 'ק״ג', display_name: null };
const NAMED: Product = { ...base, id: 'p-named', name: 'עגבניות שרי', unit: 'ק״ג', display_name: 'עגבניות שרי' };

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => { authState.role = 'office'; });

/** Records every call to the one door, so "was a reason sent" is an assertion and not a hope. */
function recordRpc(options: { fails?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  server.use(http.post(RPC_ENDPOINT, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    calls.push(body);
    return options.fails
      ? HttpResponse.json({ message: 'product_display_name_not_authorized' }, { status: 403 })
      : HttpResponse.json({ product_id: body.p_product_id, display_name: body.p_display_name, idempotent: false });
  }));
  return calls;
}

function renderQueue(queue: Product[] | null, onApproved = vi.fn()) {
  render(<ToastProvider><ProductNameReview queue={queue} onApproved={onApproved} /></ToastProvider>);
  return onApproved;
}

describe('ProductNameReview — a proposal', () => {
  it('shows what would be dropped, and approves through the reasoned command', async () => {
    const user = userEvent.setup();
    const calls = recordRpc();
    const onApproved = renderQueue([PROPOSAL]);

    const card = screen.getByTestId(`review-${PROPOSAL.id}`);
    expect(card).toHaveAttribute('data-verdict', 'proposal');
    // The check the owner is being asked to perform: the brand leaves the name, visibly.
    expect(within(card).getByTestId('review-dropped')).toHaveTextContent('חברת דגן');
    expect(within(card).getByTestId('review-proposal')).toHaveTextContent('100 מ״ל');

    await user.click(within(card).getByRole('button', { name: /^אישור$/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].p_product_id).toBe(PROPOSAL.id);
    expect(calls[0].p_display_name).toBe('שמן קנולה — 100 מ״ל');
    // Nobody typed one, so `reasonOr` names the action and says so — never a blank the command
    // would reject, and never a typed justification we invented on the reviewer's behalf.
    expect(calls[0].p_reason).toContain('ללא הערה מהמשתמש');
    expect(String(calls[0].p_reason).trim()).not.toBe('');
    await waitFor(() => expect(onApproved).toHaveBeenCalledWith(PROPOSAL.id));
  });

  it('keeps the row when the command refuses, and says so in Hebrew', async () => {
    const user = userEvent.setup();
    const calls = recordRpc({ fails: true });
    const onApproved = renderQueue([PROPOSAL]);

    await user.click(within(screen.getByTestId(`review-${PROPOSAL.id}`)).getByRole('button', { name: /^אישור$/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(onApproved).not.toHaveBeenCalled();
    // toHebrewError, not the raw `product_display_name_not_authorized` — the reader is a
    // procurement manager. The generic sentence is the mapped answer for an unlisted code.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').not.toContain('product_display_name');
    expect(screen.getByTestId(`review-${PROPOSAL.id}`)).toBeInTheDocument();
  });
});

describe('ProductNameReview — a conflict', () => {
  it('offers no one-click approve, shows both candidates, and pre-chooses neither', async () => {
    const user = userEvent.setup();
    const calls = recordRpc();
    renderQueue([CONFLICT]);

    const card = screen.getByTestId(`review-${CONFLICT.id}`);
    expect(card).toHaveAttribute('data-verdict', 'conflict');
    // The whole rule, as one assertion: two sizes disagree, so no button applies either of them.
    expect(within(card).queryByRole('button', { name: /^אישור$/ })).toBeNull();
    expect(within(card).queryByTestId('review-proposal')).toBeNull();

    const conflict = within(card).getByTestId('review-conflict');
    expect(conflict).toHaveTextContent('100 מ״ל');
    expect(conflict).toHaveTextContent('200cc');

    // Manual entry starts empty: pre-filling one of the two candidates would be the system making
    // the choice it just declined to make, with the reviewer's press as cover.
    await user.click(within(card).getByRole('button', { name: /עריכה ואישור/ }));
    expect(within(card).getByLabelText('השם הקנוני')).toHaveValue('');
    expect(calls).toEqual([]);
  });
});

describe('ProductNameReview — a blocked name', () => {
  it('explains why it cannot propose, and takes a typed name with a typed reason', async () => {
    const user = userEvent.setup();
    const calls = recordRpc();
    renderQueue([BLOCKED]);

    const card = screen.getByTestId(`review-${BLOCKED.id}`);
    expect(card).toHaveAttribute('data-verdict', 'blocked');
    expect(within(card).queryByRole('button', { name: /^אישור$/ })).toBeNull();
    expect(within(card).queryByTestId('review-proposal')).toBeNull();
    // Not a silent absence: the row states that its stored text runs the wrong way.
    expect(within(card).getByTestId('review-blocked')).toHaveTextContent(/סדר הפוך/);

    await user.click(within(card).getByRole('button', { name: /עריכה ואישור/ }));
    await user.type(within(card).getByLabelText('השם הקנוני'), 'קמח לבן — 5 ק״ג');
    await user.type(within(card).getByLabelText(/סיבה/), 'תוקן ידנית מול השק');
    await user.click(within(card).getByRole('button', { name: 'שמירת השם' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].p_display_name).toBe('קמח לבן — 5 ק״ג');
    // A typed sentence reaches the ledger verbatim; `reasonOr` only fills a silence.
    expect(calls[0].p_reason).toBe('תוקן ידנית מול השק');
  });

  it('refuses to send a blank name, before the round trip', async () => {
    const user = userEvent.setup();
    const calls = recordRpc();
    renderQueue([BLOCKED]);

    const card = screen.getByTestId(`review-${BLOCKED.id}`);
    await user.click(within(card).getByRole('button', { name: /עריכה ואישור/ }));
    await user.click(within(card).getByRole('button', { name: 'שמירת השם' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(calls).toEqual([]);
  });
});

describe('ProductNameReview — an unknown catalogue', () => {
  it('says the backlog is unknown instead of showing an empty queue', () => {
    renderQueue(null);
    // "Nothing to review" and "we could not count" are different claims; only one is true here.
    expect(screen.getByRole('status')).toHaveTextContent(/לא ידוע/);
    expect(screen.queryByTestId(`review-${PROPOSAL.id}`)).toBeNull();
  });
});

describe('Products — the review mode', () => {
  function wireCatalogue(products: Product[]) {
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/products`, () => HttpResponse.json(products)),
      http.get(`${SUPABASE_URL}/rest/v1/supplier_products`, () => HttpResponse.json([])),
      http.get(`${SUPABASE_URL}/rest/v1/categories`, () => HttpResponse.json([])),
      http.post(`${SUPABASE_URL}/rest/v1/rpc/get_product_name_repair_queue`, () => HttpResponse.json([])),
    );
  }

  it('counts only the products with no canonical name, and queues exactly those', async () => {
    const user = userEvent.setup();
    wireCatalogue([PROPOSAL, CONFLICT, BLOCKED, NAMED]);
    render(
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-test">
          <ToastProvider>
            <MemoryRouter initialEntries={['/products']}><Products /></MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>,
    );

    const toggle = await screen.findByTestId('name-review-toggle');
    // Three of the four rows carry no canonical name. A measured count, not a placeholder.
    await waitFor(() => expect(toggle).toHaveTextContent(/\(3\)/));

    await user.click(toggle);
    expect(await screen.findByTestId(`review-${PROPOSAL.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`review-${CONFLICT.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`review-${BLOCKED.id}`)).toBeInTheDocument();
    // Already approved once; re-proposing a name a person settled would be the backfill 0149 refused.
    expect(screen.queryByTestId(`review-${NAMED.id}`)).toBeNull();
  });
});
