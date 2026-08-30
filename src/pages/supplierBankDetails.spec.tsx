import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  payment_terms: null, bank_details: null, notes: null,
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

/** A password sign-in that comes back with a JWT carrying a password `amr` entry from just now. */
function serveFreshToken() {
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
}

function serveCurrentBankDetails(data: Record<string, unknown>[] = []) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/financial_supplier_bank_accounts`, () => HttpResponse.json(data)),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/read_supplier_bank_migration_item`, () => HttpResponse.json([])),
  );
}

function renderForm(onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <SupplierForm supplier={supplier} onClose={vi.fn()} onSaved={onSaved} />
    </ToastProvider>,
  );
  return onSaved;
}

const bankType = () => screen.getByLabelText('סוג פרטי הבנק');
const saveButton = () => screen.getByRole('button', { name: 'שמירה' });

async function fillIsraelBank(user: ReturnType<typeof userEvent.setup>, suffix = '999') {
  await user.selectOptions(bankType(), 'IL');
  await user.type(screen.getByLabelText('שם בעל החשבון *'), 'ספק בדיקה בעמ');
  await user.type(screen.getByLabelText('מספר בנק *'), '12');
  await user.type(screen.getByLabelText('מספר סניף *'), '001');
  await user.type(screen.getByLabelText('מספר חשבון *'), suffix);
}

beforeEach(() => {
  /* Signed in seconds ago. Everywhere else in the app that would skip the password prompt — but
     NOT here: this flow passes `skipWhenFresh={false}` on purpose (#290, #106), so a fresh JWT
     changes nothing and the dialog appears every time. The age is kept at 30s precisely so these
     tests prove that: if the opt-out is ever dropped, they go red instead of quietly passing. */
  authState.session = sessionWithAge(30);
  serveCurrentBankDetails();
});

/** The single dialog the flow now stops at, and the field it carries. */
const STEP_UP_HEADING = 'אימות זהות לעדכון פרטי בנק';
const REASON_LABEL = 'סיבה (רשות — נרשמת ביומן הביקורת)';

/**
 * Walk the one interruption that is always there.
 *
 * Two dialogs became one (#290) — never none. The old reason-only `ConfirmDialog` was
 * unconditional, so letting a fresh token skip the replacement would have made the single most
 * financially consequential write in the app happen on one click with nothing on screen. This
 * helper exists so every bank test pays that price explicitly rather than by omission.
 */
async function passStepUp(user: ReturnType<typeof userEvent.setup>, reason?: string) {
  const dialog = await screen.findByRole('dialog', { name: STEP_UP_HEADING });
  if (reason !== undefined) await user.type(within(dialog).getByLabelText(REASON_LABEL), reason);
  await user.type(within(dialog).getByLabelText('סיסמה לאימות זהות טרי *'), 'owner-pass');
  await user.click(within(dialog).getByRole('button', { name: /אישור זהות/ }));
}

describe('SupplierForm — structured bank-details flow (migration 0171)', () => {
  it('routes a bank change through the step-up to the RPC, never the direct update', async () => {
    const user = userEvent.setup();
    const patched = trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    const onSaved = renderForm();

    await fillIsraelBank(user);
    serveFreshToken();
    await user.click(saveButton());

    // The generic save ran, and bank_details was NOT in it — the column left the UPDATE grant.
    await waitFor(() => expect(patched).toHaveLength(1));
    expect(Object.keys(patched[0])).not.toContain('bank_details');

    /* #290: the reason-only ConfirmDialog that used to stand here is gone — two interruptions
       became one, not none. The remaining one is the password, and this flow refuses to let a
       fresh JWT skip it, so the account the money leaves for never changes without a person
       looking at it. The ledger still gets a sentence either way: the server refuses a blank
       `p_reason` outright. */
    await passStepUp(user);

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toEqual({
      p_supplier_id: 'sup-1',
      p_bank_details: {
        account_holder: 'ספק בדיקה בעמ',
        country_code: 'IL',
        bank_code: '12',
        branch_code: '001',
        account_number: '999',
        iban: null,
        bic: null,
      },
      p_reason: 'עדכון פרטי בנק של ספק — ללא הערה מהמשתמש',
    });
    expect(String(rpcBodies[0].p_reason).trim().length).toBeGreaterThan(0);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    // One dialog, and only when it has something to ask: the ConfirmDialog is not hiding anywhere.
    expect(screen.queryByRole('button', { name: 'אישור העדכון' })).toBeNull();
  });

  it('collapses the old two dialogs into the password step, and carries the typed reason through it', async () => {
    authState.session = sessionWithAge(10 * 60);
    const user = userEvent.setup();
    trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    serveFreshToken();
    renderForm();

    await fillIsraelBank(user, '404');
    await user.click(saveButton());

    // Exactly one interruption, and it is the password one. Nothing has reached the RPC yet.
    const dialog = await screen.findByRole('dialog', { name: STEP_UP_HEADING });
    expect(screen.getAllByRole('dialog', { name: STEP_UP_HEADING })).toHaveLength(1);
    expect(rpcBodies).toHaveLength(0);

    // It still says which account is about to change — that half of the removed dialog moved here.
    expect(within(dialog).getByText(/יעודכנו לחשבון IL שמסתיים ב־404/)).toBeInTheDocument();

    // The reason box rides along, and it does not gate the button: the confirm button is disabled
    // by the empty PASSWORD, and enabling it takes a password, never a reason.
    const confirm = within(dialog).getByRole('button', { name: /אישור זהות/ });
    await user.type(within(dialog).getByLabelText(REASON_LABEL), 'החלפת חשבון לפי מכתב מהספק');
    expect(confirm).toBeDisabled();
    expect(rpcBodies).toHaveLength(0);

    await user.type(within(dialog).getByLabelText('סיסמה לאימות זהות טרי *'), 'owner-pass');
    await user.click(confirm);

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toMatchObject({
      p_supplier_id: 'sup-1',
      p_bank_details: { country_code: 'IL', account_number: '404' },
      p_reason: 'החלפת חשבון לפי מכתב מהספק',
    });
  });

  it('an empty reason box still succeeds — the ledger sentence is written for the user', async () => {
    authState.session = sessionWithAge(10 * 60);
    const user = userEvent.setup();
    trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    serveFreshToken();
    renderForm();

    await fillIsraelBank(user, '505');
    await user.click(saveButton());

    const dialog = await screen.findByRole('dialog', { name: STEP_UP_HEADING });
    // Not a word typed in the box; the password alone opens the button (#290).
    await user.type(within(dialog).getByLabelText('סיסמה לאימות זהות טרי *'), 'owner-pass');
    await user.click(within(dialog).getByRole('button', { name: /אישור זהות/ }));

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    // Non-blank is the server's hard rule (`supplier_bank_details_reason_required`, 22023).
    expect(rpcBodies[0].p_reason).toBe('עדכון פרטי בנק של ספק — ללא הערה מהמשתמש');
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
    await fillIsraelBank(user, '123');
    serveFreshToken();
    await user.click(saveButton());

    // The INSERT itself must be bank-less — 0088 revoked the column grant (#106, option 2).
    await waitFor(() => expect(inserts).toHaveLength(1));
    expect(Object.keys(inserts[0])).not.toContain('bank_details');

    // The same audited step an existing supplier's change takes, now for the fresh row.
    // The one interruption this flow always shows, fresh token or not (#290).
    await passStepUp(user);

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toEqual({
      p_supplier_id: 'sup-new',
      p_bank_details: {
        account_holder: 'ספק בדיקה בעמ',
        country_code: 'IL',
        bank_code: '12',
        branch_code: '001',
        account_number: '123',
        iban: null,
        bic: null,
      },
      p_reason: 'עדכון פרטי בנק של ספק — ללא הערה מהמשתמש',
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('creating with the bank select left on "ללא פרטי בנק" saves nothing and demands no step-up', async () => {
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

    await user.type(screen.getByLabelText('שם הספק *'), 'ספק חדש בלי בנק');
    // Opened the select, looked, and chose to enter nothing. The row is inserted bank-less
    // anyway, so there is no prior value to clear and nothing for a reason or a password to guard.
    await user.selectOptions(bankType(), 'IL');
    await user.selectOptions(bankType(), '');
    await user.click(saveButton());

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(inserts).toHaveLength(1);
    expect(rpcBodies).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: STEP_UP_HEADING })).toBeNull();
    expect(screen.queryByText('הספק נוצר — פרטי הבנק דורשים אימות זהות')).toBeNull();
  });

  it('clearing an EXISTING supplier\'s bank details is still an audited, stepped-up change', async () => {
    const user = userEvent.setup();
    serveCurrentBankDetails([{
      supplier_id: 'sup-1', account_holder: 'ספק בדיקה בעמ', country_code: 'IL',
      bank_code: '12', branch_code: '001', account_number: '999',
      iban: null, bic: null, migration_pending: false,
    }]);
    trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    renderForm();

    await waitFor(() => expect(bankType()).toHaveValue('IL'));
    await user.selectOptions(bankType(), '');
    serveFreshToken();
    await user.click(saveButton());

    // Erasing details that exist is a real change — it keeps the step-up boundary and the ledger.
    // The one interruption this flow always shows, fresh token or not (#290).
    await passStepUp(user);

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toEqual({
      p_supplier_id: 'sup-1',
      p_bank_details: null,
      p_reason: 'עדכון פרטי בנק של ספק — ללא הערה מהמשתמש',
    });
  });

  /**
   * The dialog that was deleted was never the gate, and this is the test that says so. A stale JWT
   * has to meet the password prompt before a single byte reaches `update_supplier_bank_details`,
   * and a wrong password has to leave the RPC untouched — which is exactly what the server's
   * `assert_recent_password_authentication()` (`0171:314`) enforces on its own side.
   */
  it('a stale session cannot reach the RPC without a correct password', async () => {
    authState.session = sessionWithAge(10 * 60);
    const user = userEvent.setup();
    trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    let attempts = 0;
    server.use(
      http.post(`${SUPABASE_URL}/auth/v1/token`, () => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, { status: 400 });
        }
        return HttpResponse.json({
          access_token: tokenWithAge(0),
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: 'refresh-1',
          user: { id: 'user-1', aud: 'authenticated', email: 'owner@example.com' },
        });
      }),
    );
    renderForm();

    await fillIsraelBank(user, '20');
    await user.click(saveButton());

    // The step-up dialog interposes; the write has not started.
    const dialog = await screen.findByRole('dialog', { name: STEP_UP_HEADING });
    expect(rpcBodies).toHaveLength(0);

    // A wrong password: the dialog stays, and still nothing reached the RPC.
    await user.type(within(dialog).getByLabelText('סיסמה לאימות זהות טרי *'), 'wrong-pass');
    await user.click(within(dialog).getByRole('button', { name: /אישור זהות/ }));
    await waitFor(() => expect(attempts).toBe(1));
    expect(rpcBodies).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: STEP_UP_HEADING })).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('סיסמה לאימות זהות טרי *'), 'owner-pass');
    await user.type(within(dialog).getByLabelText(REASON_LABEL), 'החלפת חשבון');
    await user.click(within(dialog).getByRole('button', { name: /אישור זהות/ }));

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toMatchObject({
      p_supplier_id: 'sup-1',
      p_bank_details: { country_code: 'IL', account_number: '20' },
      p_reason: 'החלפת חשבון',
    });
  });

  it('leaves the other-fields path untouched: no RPC, no step-up dialog', async () => {
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
    expect(screen.queryByRole('heading', { name: STEP_UP_HEADING })).toBeNull();
  });

  it('surfaces a step-up rejection through toHebrewError and keeps the dialog for a retry', async () => {
    const user = userEvent.setup();
    trackSupplierPatch();
    trackBankRpc(401, 'fresh_authentication_required');
    const onSaved = renderForm();

    await fillIsraelBank(user, '31');
    serveFreshToken();
    await user.click(saveButton());

    // The first pass through the step-up is what sends the write the server then refuses.
    await passStepUp(user);

    expect(
      await screen.findByText('נדרש אימות מחדש — הזינו סיסמה כדי לאשר פעולה רגישה.'),
    ).toBeInTheDocument();
    /* The dialog comes back for a retry, asking again and carrying an empty reason box. It must
       never come back in a mode that could re-fire the write on its own: a refused sensitive
       write that retries itself is an infinite loop against the server. */
    const dialog = await screen.findByRole('dialog', { name: STEP_UP_HEADING });
    expect(within(dialog).getByLabelText('סיסמה לאימות זהות טרי *')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(REASON_LABEL)).toHaveValue('');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('renders international fields and sends IBAN/BIC without Israel-only columns', async () => {
    const user = userEvent.setup();
    trackSupplierPatch();
    const rpcBodies = trackBankRpc();
    renderForm();

    await user.selectOptions(bankType(), 'international');
    await user.type(screen.getByLabelText('שם בעל החשבון *'), 'Global Supplier GmbH');
    await user.type(screen.getByLabelText('קוד מדינה (ISO) *'), 'de');
    await user.type(screen.getByLabelText('IBAN *'), 'de89 3704 0044 0532 0130 00');
    await user.type(screen.getByLabelText('BIC / SWIFT'), 'cobadeffxxx');
    serveFreshToken();
    await user.click(saveButton());

    // The one interruption this flow always shows, fresh token or not (#290).
    await passStepUp(user);

    await waitFor(() => expect(rpcBodies).toHaveLength(1));
    expect(rpcBodies[0]).toMatchObject({
      p_bank_details: {
        account_holder: 'Global Supplier GmbH', country_code: 'DE',
        bank_code: null, branch_code: null, account_number: null,
        iban: 'DE89370400440532013000', bic: 'COBADEFFXXX',
      },
    });
  });

  it('shows legacy free text only as migration evidence and never pre-fills structured fields', async () => {
    server.use(
      http.post(`${SUPABASE_URL}/rest/v1/rpc/read_supplier_bank_migration_item`, () => HttpResponse.json([{
        supplier_id: 'sup-1',
        legacy_bank_details: 'בנק ישן 10 סניף 800 חשבון 123',
        status: 'pending',
      }])),
    );
    renderForm();

    expect(await screen.findByText('בנק ישן 10 סניף 800 חשבון 123')).toBeInTheDocument();
    expect(bankType()).toHaveValue('');
    expect(screen.queryByDisplayValue('123')).toBeNull();
  });
});
