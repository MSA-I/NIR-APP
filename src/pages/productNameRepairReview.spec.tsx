import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { ToastProvider } from '../components/ui';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return { supabase: createClient(url, 'test-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  }) };
});

import { ProductNameRepairReview, type ProductNameRepairCandidate } from './ProductNameRepairReview';

const READY: ProductNameRepairCandidate = {
  candidate_id: 'candidate-ready', product_id: 'product-ready', status: 'ready', reason_code: null,
  old_name: ')ג"ק 5( ןבל חמק', proposed_name: 'קמח לבן (5 ק"ג)',
  source_submission_id: 'submission-1', source_file_name: 'מחירון יולי.xlsx',
  source_checksum: 'a'.repeat(64), source_row: 7,
  source_evidence: { sheet: 'מחירון', cell: 'B7' },
};
const BLOCKED: ProductNameRepairCandidate = {
  ...READY, candidate_id: 'candidate-blocked', product_id: 'product-blocked', status: 'blocked',
  reason_code: 'missing_source', proposed_name: null, source_row: null, source_evidence: {},
};

describe('ProductNameRepairReview', () => {
  it('shows old/new and exact source proof, then approves only one row through the repair command', async () => {
    const calls: Record<string, unknown>[] = [];
    server.use(http.post(`${SUPABASE_URL}/rest/v1/rpc/apply_product_name_repair`, async ({ request }) => {
      calls.push(await request.json() as Record<string, unknown>);
      return HttpResponse.json({ candidate_id: READY.candidate_id, idempotent: false });
    }));
    const applied = vi.fn();
    const user = userEvent.setup();
    render(<ToastProvider><ProductNameRepairReview queue={[READY, BLOCKED]} onApplied={applied} /></ToastProvider>);

    const ready = screen.getByTestId('repair-candidate-ready');
    expect(ready).toHaveTextContent(READY.old_name);
    expect(ready).toHaveTextContent(READY.proposed_name!);
    expect(ready).toHaveTextContent('מחירון יולי.xlsx');
    expect(ready).toHaveTextContent('B7');
    expect(ready).toHaveTextContent(READY.source_checksum.slice(0, 12));
    await user.type(within(ready).getByLabelText(/סיבה/), 'נבדק מול שורה 7');
    await user.click(within(ready).getByRole('button', { name: 'אישור התיקון' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      p_candidate_id: READY.candidate_id,
      p_expected_old_name: READY.old_name,
      p_expected_proposed_name: READY.proposed_name,
      p_expected_source_checksum: READY.source_checksum,
      p_reason: 'נבדק מול שורה 7',
    });
    expect(String(calls[0].p_idempotency_key)).not.toBe('');
    expect(applied).toHaveBeenCalledWith(READY.candidate_id);
  });

  it('keeps missing source blocked and offers no approval button', () => {
    render(<ToastProvider><ProductNameRepairReview queue={[BLOCKED]} onApplied={vi.fn()} /></ToastProvider>);
    const card = screen.getByTestId('repair-candidate-blocked');
    expect(card).toHaveTextContent(/מקור/);
    expect(within(card).queryByRole('button', { name: 'אישור התיקון' })).toBeNull();
  });

  it('reuses the candidate idempotency key after a lost response', async () => {
    const keys: unknown[] = [];
    let attempt = 0;
    server.use(http.post(`${SUPABASE_URL}/rest/v1/rpc/apply_product_name_repair`, async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      keys.push(body.p_idempotency_key);
      attempt += 1;
      return attempt === 1
        ? HttpResponse.json({ message: 'temporary failure' }, { status: 503 })
        : HttpResponse.json({ candidate_id: READY.candidate_id, idempotent: true });
    }));
    const user = userEvent.setup();
    render(<ToastProvider><ProductNameRepairReview queue={[READY]} onApplied={vi.fn()} /></ToastProvider>);
    const card = screen.getByTestId('repair-candidate-ready');
    await user.type(within(card).getByLabelText(/סיבה/), 'נבדק מול המקור');
    await user.click(within(card).getByRole('button', { name: 'אישור התיקון' }));
    await waitFor(() => expect(keys).toHaveLength(1));
    await user.click(within(card).getByRole('button', { name: 'אישור התיקון' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});
