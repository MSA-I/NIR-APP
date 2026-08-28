/**
 * The remedy for "מוצר לא מזוהה", asserted as a control rather than as a sentence.
 *
 * The screen has named this problem since 0110 and offered nothing to fix it — the reviewer's only
 * route was to leave, build the catalogue by hand, and re-open the document. What is checked here
 * is that every unmatched line now carries a way out, that the way out exists on a BRAND-NEW
 * account where the catalogue is empty (the case the tester actually hit), and that the choice
 * reaches the caller, since that is what ends up in the proposal the server recomputes.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

import { DocumentLineMapping, lineFacts, lineTitle } from './DocumentLineMapping';

const PRODUCTS = `${SUPABASE_URL}/rest/v1/products`;
const SUPPLIERS = `${SUPABASE_URL}/rest/v1/suppliers`;

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
  server.use(
    http.get(PRODUCTS, () => HttpResponse.json([])),
    http.get(SUPPLIERS, () => HttpResponse.json({ id: 'sup-1', name: 'פיופ' })),
  );
});

function renderMapping(lines: AssessmentLine[], onMap = vi.fn(), supplierId: string | null = 'sup-1') {
  render(
    <ToastProvider>
      <DocumentLineMapping lines={lines} supplierId={supplierId} mapped={{}} onMap={onMap} />
    </ToastProvider>,
  );
  return onMap;
}

describe('every line the catalogue did not recognise gets a way out', () => {
  it('offers a picker and a create door per line, on an account with no products at all', async () => {
    renderMapping([line(0), line(1)]);

    const card = await screen.findByTestId('document-line-mapping');
    // Two lines, two selects, two doors. The empty catalogue is the new-account case, and it must
    // not read as "nothing to do here".
    expect(card.querySelectorAll('select')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /מוצר חדש/ })).toHaveLength(2);
    await waitFor(() => expect(screen.getAllByText('אין עדיין מוצרים בקטלוג')).toHaveLength(2));

    // The work list states what is left, and never as a bare "0".
    expect(card.textContent).toMatch(/נותרו/);
  });

  it('reports the chosen product upward — the panel is what puts it in the proposal', async () => {
    server.use(http.get(PRODUCTS, () => HttpResponse.json([
      { id: 'prod-1', name: 'עגבניות', unit: 'ק"ג' },
      { id: 'prod-2', name: 'מלפפונים', unit: 'ק"ג' },
    ])));
    const onMap = renderMapping([line(0)]);

    const select = await screen.findByLabelText('עגבניות שרי 1');
    await waitFor(() => expect(screen.getByText('בחר מוצר קיים')).toBeInTheDocument());
    await userEvent.selectOptions(select, 'prod-2');

    expect(onMap).toHaveBeenCalledWith(0, 'prod-2');

    // Clearing is a decision too, and it must arrive as an absence rather than as an empty string.
    await userEvent.selectOptions(select, '');
    expect(onMap).toHaveBeenLastCalledWith(0, null);
  });

  it('withholds creation, and says why, while no supplier is resolved', async () => {
    renderMapping([line(0)], vi.fn(), null);

    await screen.findByTestId('document-line-mapping');
    expect(screen.getByRole('button', { name: /מוצר חדש/ })).toBeDisabled();
    // A disabled control with no sentence is indistinguishable from a broken one.
    expect(screen.getByText(/כל עוד הספק לא זוהה/)).toBeInTheDocument();
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
    // An absent quantity drops the whole segment — unit included — rather than printing "0 ק"ג".
    expect(lineFacts(line(0, { quantity: null }))).not.toMatch(/ק"ג/);
    expect(lineFacts(line(0, { quantity: null, unit_price: null }))).toBe('');
  });
});
