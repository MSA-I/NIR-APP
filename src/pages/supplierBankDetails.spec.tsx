import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ComponentProps } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { ToastProvider } from '../components/ui';

/** Real supabase-js against the MSW base URL — the wire behaviour stays real. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: 'owner', org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {} },
    session: authState.session,
    roleLabels: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import { SupplierForm } from './Suppliers';

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const tokenWithAge = (ageSeconds: number) =>
  `${b64url({ alg: 'HS256' })}.${b64url({
    amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) - ageSeconds }],
  })}.sig`;
const sessionWithAge = (ageSeconds: number) => ({
  access_token: tokenWithAge(ageSeconds),
  user: { id: 'user-1', email: 'owner@example.com' },
});

type SupplierProp = ComponentProps<typeof SupplierForm>['supplier'];
const supplier = {
  id: 'sup-1', org_id: 'org-test', name: 'ספק בדיקה', tax_id: null, contact_name: null,
  phone: '03-1234567', whatsapp: null, email: null, address: null, min_order_amount: null,
  payment_terms: null, bank_details: 'בנק 10 · סניף 800 · חשבון 123', notes: null,
  status: 'active', delivery_days: [], cutoff_time: null,
  rating: null, rating_updated_at: null, rating_note: null,
} as unknown as NonNullable<SupplierProp>;

function trackSupplierPatch() {
  const bodies: Array<Record<string, unknown>> = [];
  server.use(
    http.patch(`${SUPABASE_URL}/rest/v1/suppliers`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return bodies;
}

function trackBankRpc(status = 204, message?: string) {
  const bodies: Array<Record<string, unknown>> = [];
  server.use(
    http.post(`${SUPABASE_URL}/rest/v1/rpc/update_supplier_bank_details`, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>);
      if (status >= 400) {
        return HttpResponse.json({ message, code: '42501', details: null, hint: null }, { status });
      }
      return new HttpResponse(null, { status });
    }),
  );
  return bodies;
}

function renderForm(onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <SupplierForm supplier={supplier} onClose={vi.fn()} onSaved={onSaved} />
    </ToastProvider>,
  );
  return onSaved;
}

const bankField = () => screen.getByLabelText('פרטי בנק (מוצג למבצע ההעברות)');
const saveButton = () => screen.getByRole('button', { name: 'שמירה' });

beforeEach(() => {
  // Signed in seconds ago — ReauthModal's mandatory skip-when-fresh keeps the flow modal-free.
  authState.session = sessionWithAge(30);
});

describe('SupplierForm — the dedicated bank-details flow (PLAN-04 §3.2)', () => {
  it('routes a bank change through reason + step-up to the RPC, never the direct update', async () => {
    const user = userEvent.setup();
    const patched = trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    const onSaved = renderForm();

    await user.clear(bankField());
    await user.type(bankField(), 'בנק 12 · סניף 001 · חשבון 999');
    await user.click(saveButton());

    // The generic save ran, and bank_details was NOT in it — the column left the UPDATE grant.
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(Object.keys(patched[0])).not.toContain('bank_details');

    // The dedicated step opens, and its confirm stays locked until a reason is given.
    const dialogTitle = await screen.findByRole('heading', { name: 'עדכון פרטי בנק' });
    expect(dialogTitle).toBeInTheDocument();
    const confirmButton = screen.getByRole('button', { name: 'אישור העדכון' });
    expect(confirmButton).toBeDisabled();
    expect(rpcBodies).toHaveLength(0);

    await user.type(screen.getByLabelText('סיבה (חובה — נרשם ביומן הביקורת)'), 'עדכון חשבון לפי מכתב מהספק');
    await user.click(confirmButton);

    // Fresh JWT ⇒ the step-up prompt is skipped and the RPC carries the reason.
    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toEqual({
      p_supplier_id: 'sup-1',
      p_bank_details: 'בנק 12 · סניף 001 · חשבון 999',
      p_reason: 'עדכון חשבון לפי מכתב מהספק',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('creation routes non-empty bank details through the reasoned RPC, never the INSERT (#106)', async () => {
    const user = userEvent.setup();
    const inserts: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/suppliers`, async ({ request }) => {
        inserts.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ id: 'sup-new' }, { status: 201 });
      }),
    );
    const rpcBodies = trackBankRpc();
    const onSaved = vi.fn();
    render(
      <ToastProvider>
        <SupplierForm supplier={null} onClose={vi.fn()} onSaved={onSaved} />
      </ToastProvider>,
    );

    await user.type(screen.getByLabelText('שם הספק *'), 'ספק חדש עם בנק');
    await user.type(bankField(), 'בנק 10 · סניף 800 · חשבון 123');
    await user.click(saveButton());

    // The INSERT itself must be bank-less — 0088 revoked the column grant (#106, option 2).
    await waitFor(() => expect(inserts).toHaveLength(1));
    expect(Object.keys(inserts[0])).not.toContain('bank_details');

    // The same reasoned step an existing supplier's change takes, now for the fresh row.
    await screen.findByRole('heading', { name: 'עדכון פרטי בנק' });
    await user.type(screen.getByLabelText('סיבה (חובה — נרשם ביומן הביקורת)'), 'הקמת ספק עם פרטי בנק');
    await user.click(screen.getByRole('button', { name: 'אישור העדכון' }));

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toEqual({
      p_supplier_id: 'sup-new',
      p_bank_details: 'בנק 10 · סניף 800 · חשבון 123',
      p_reason: 'הקמת ספק עם פרטי בנק',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('prompts for a password inside the flow when the session is stale', async () => {
    authState.session = sessionWithAge(10 * 60);
    const user = userEvent.setup();
    trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    server.use(
      http.post(`${SUPABASE_URL}/auth/v1/token`, () =>
        HttpResponse.json({
          access_token: tokenWithAge(0),
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'refresh-1',
          user: { id: 'user-1', aud: 'authenticated', email: 'owner@example.com' },
        }),
      ),
    );
    renderForm();

    await user.clear(bankField());
    await user.type(bankField(), 'בנק 20');
    await user.click(saveButton());
    await user.type(
      await screen.findByLabelText('סיבה (חובה — נרשם ביומן הביקורת)'),
      'החלפת חשבון',
    );
    await user.click(screen.getByRole('button', { name: 'אישור העדכון' }));

    // A stale JWT does not slip through — the step-up dialog interposes before the RPC.
    expect(await screen.findByRole('heading', { name: 'אימות זהות לעדכון פרטי בנק' })).toBeInTheDocument();
    expect(rpcBodies).toHaveLength(0);

    await user.type(screen.getByLabelText('סיסמה לאימות זהות טרי *'), 'owner-pass');
    await user.click(screen.getByRole('button', { name: /אישור זהות/ }));

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toMatchObject({ p_supplier_id: 'sup-1', p_bank_details: 'בנק 20', p_reason: 'החלפת חשבון' });
  });

  it('leaves the other-fields path untouched: no RPC, no reason dialog', async () => {
    const user = userEvent.setup();
    const patched = trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    const onSaved = renderForm();

    const phone = screen.getByLabelText('טלפון');
    await user.clear(phone);
    await user.type(phone, '04-7654321');
    await user.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(patched).toHaveLength(1);
    expect(patched[0].phone).toBe('04-7654321');
    expect(Object.keys(patched[0])).not.toContain('bank_details');
    expect(rpcBodies).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: 'עדכון פרטי בנק' })).toBeNull();
  });

  it('surfaces a step-up rejection through toHebrewError and keeps the dialog for a retry', async () => {
    const user = userEvent.setup();
    trackSupplierPatch();
    trackBankRpc(401, 'fresh_authentication_required');
    const onSaved = renderForm();

    await user.clear(bankField());
    await user.type(bankField(), 'בנק 31');
    await user.click(saveButton());
    await user.type(
      await screen.findByLabelText('סיבה (חובה — נרשם ביומן הביקורת)'),
      'עדכון חשבון',
    );
    await user.click(screen.getByRole('button', { name: 'אישור העדכון' }));

    expect(
      await screen.findByText('נדרש אימות מחדש — הזינו סיסמה כדי לאשר פעולה רגישה.'),
    ).toBeInTheDocument();
    // The reason dialog survives the failure — the user retries instead of retyping everything.
    expect(screen.getByRole('heading', { name: 'עדכון פרטי בנק' })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
