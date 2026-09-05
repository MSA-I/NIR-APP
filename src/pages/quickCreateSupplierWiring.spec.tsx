/**
 * E2 — the three dead ends, and the one pattern that closes them.
 *
 * The owner's complaint was literal: "בקטגורית מחירונים כשאני מנסה להעלות מחירון הוא מכריח אותי
 * לבחור ספק בעוד שאני לא יכול ליצור ספק חדש באותו חלונית". Three screens ask "which supplier?"
 * with a required `<select>` fed only from the rows that already exist. This suite is about the
 * door out of each of them, and about the two ways such a door usually breaks:
 *
 *   1. the caller selects an id its `<select>` cannot render, because the refetch has not landed;
 *   2. the caller adds the row locally and then the refetch adds it again — one supplier, twice.
 *
 * Both are properties of `mergeCreatedSuppliers`, so both are driven directly with a re-render
 * that stands in for the refetch, rather than inferred from whichever screen a UI test happens to
 * exercise. The screen tests then prove the wiring is actually present on each of the three.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { fmtMoneyExact } from '../lib/format';

/** Real supabase-js against the MSW base URL — the PostgREST wire behaviour stays real. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

/**
 * Mutable on purpose: the role gate is half of what this suite asserts, and `vi.mock` is hoisted
 * above every `const` in the file, so the state it closes over has to be hoisted with it.
 */
const auth = vi.hoisted(() => ({
  current: {
    profile: { id: 'user-1', org_id: 'org-test', role: 'office' } as { id: string; org_id: string; role: string },
    org: { vat_rate: 18, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth.current }));

import {
  SupplierSelectField,
  QUICK_CREATE_SUPPLIER_HINT_KEY,
  SUPPLIER_FIELD_NO_CREATE_HINT_KEY,
  SUPPLIER_FIELD_QUICK_CREATE_HINT_KEY,
  mergeCreatedSuppliers,
  useQuickSupplier,
  type SupplierOption,
} from '../components/QuickSupplierPicker';
import { translateIn } from '../lib/i18n/LocaleProvider';

const QUICK_CREATE_SUPPLIER_HINT = translateIn('he', QUICK_CREATE_SUPPLIER_HINT_KEY);
const SUPPLIER_FIELD_NO_CREATE_HINT = translateIn('he', SUPPLIER_FIELD_NO_CREATE_HINT_KEY);
const SUPPLIER_FIELD_QUICK_CREATE_HINT = translateIn('he', SUPPLIER_FIELD_QUICK_CREATE_HINT_KEY);
import { PriceListUploadModal } from '../components/PriceListUpload';
import InvoiceNew from './InvoiceNew';
import PaymentRequests from './PaymentRequests';

const SUPPLIERS_ENDPOINT = `${SUPABASE_URL}/rest/v1/suppliers`;
const CREATE_SUPPLIER_ENDPOINT = `${SUPABASE_URL}/rest/v1/rpc/create_supplier_from_document`;
const FINANCIAL_SUPPLIERS_ENDPOINT = `${SUPABASE_URL}/rest/v1/financial_supplier_directory`;
const CURRENCIES_ENDPOINT = `${SUPABASE_URL}/rest/v1/currencies`;
const EXISTING = {
  id: 'sup-1', name: 'ספק קיים בע״מ', tax_id: '514000000', status: 'active',
  default_currency: 'USD', country_code: 'US',
};
const NEW_ROW = { id: 'sup-new', name: 'ירקות השדה בע״מ' };

beforeAll(() => {
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

beforeEach(() => {
  auth.current = {
    profile: { id: 'user-1', org_id: 'org-test', role: 'office' },
    org: { vat_rate: 18, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  };
});

/** Every GET the three screens and the quick-create dialog make against `suppliers`. */
function useSupplierTable(rows: Array<Record<string, unknown>> = [EXISTING]) {
  server.use(
    http.get(SUPPLIERS_ENDPOINT, () => HttpResponse.json(rows)),
    http.get(CURRENCIES_ENDPOINT, () => HttpResponse.json([
      { code: 'ILS', minor_units: 2 }, { code: 'USD', minor_units: 2 },
    ])),
    http.get(FINANCIAL_SUPPLIERS_ENDPOINT, () => HttpResponse.json(rows.map((row) => ({
      id: row.id,
      name: row.name,
      tax_id: row.tax_id ?? null,
      payment_terms: row.payment_terms ?? null,
      status: row.status ?? 'active',
      bank_details: row.bank_details ?? null,
    })))),
  );
}

/** The insert, recorded, so a test can assert both what was written and that nothing was. */
function useSupplierInsert(row: Record<string, unknown> = NEW_ROW) {
  const bodies: Record<string, unknown>[] = [];
  server.use(http.post(CREATE_SUPPLIER_ENDPOINT, async ({ request }) => {
    const parsed = (await request.json()) as Record<string, unknown> | Record<string, unknown>[];
    bodies.push(Array.isArray(parsed) ? parsed[0] : parsed);
    return HttpResponse.json({ supplier_id: row.id, name: row.name, idempotent: false });
  }));
  return bodies;
}

const wrap = (children: ReactNode, path = '/') => (
  <QueryClientProvider client={createAppQueryClient()}>
    <OrgScopeProvider org="org-test">
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
      </ToastProvider>
    </OrgScopeProvider>
  </QueryClientProvider>
);

const newSupplierButton = () => screen.getByRole('button', { name: 'ספק חדש' });

/**
 * Drives the quick-create dialog to a successful create.
 *
 * The dialog is nested inside whichever dialog opened it, so every query is scoped to the panel
 * named "ספק חדש" — the outer screen has controls with the same names.
 */
async function createSupplier(user: ReturnType<typeof userEvent.setup>, name = NEW_ROW.name) {
  await user.click(newSupplierButton());
  const dialog = await screen.findByRole('dialog', { name: 'ספק חדש' });
  await waitFor(() => expect(dialog).toHaveFocus());
  await user.type(within(dialog).getByLabelText('שם הספק *'), name);
  await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
}

/* ================= the merge, driven directly ================= */

describe('mergeCreatedSuppliers — a local row that does not fight the refetch', () => {
  const fetched: SupplierOption[] = [{ id: 'sup-1', name: 'בית קפה' }, { id: 'sup-2', name: 'תבלינים' }];

  it('returns the fetched list untouched when nothing was created here', () => {
    expect(mergeCreatedSuppliers(fetched, [])).toEqual(fetched);
  });

  it('shows a created supplier before any refetch, in its alphabetical place', () => {
    expect(mergeCreatedSuppliers(fetched, [{ id: 'sup-3', name: 'ירקות' }]).map((row) => row.id))
      .toEqual(['sup-1', 'sup-3', 'sup-2']);
  });

  it('adds nothing once the refetch carries the same row — one supplier, one option', () => {
    const refetched = [...fetched, { id: 'sup-3', name: 'ירקות' }];
    // Returned identical to what the server sent: same rows, same order, no local re-sort — so the
    // refetch cannot make the open `<select>` jump under the user's cursor.
    expect(mergeCreatedSuppliers(refetched, [{ id: 'sup-3', name: 'ירקות' }])).toEqual(refetched);
    // Matched on id, not on name: the server's copy of the row is the authoritative one, even when
    // the name it came back with differs from the one that was typed.
    expect(mergeCreatedSuppliers(refetched, [{ id: 'sup-3', name: 'ירקות ישנות' }])).toEqual(refetched);
  });

  it('carries the created row while the list is still null — a select cannot render an id it lacks', () => {
    expect(mergeCreatedSuppliers(null, [NEW_ROW])).toEqual([NEW_ROW]);
    expect(mergeCreatedSuppliers(undefined, [])).toEqual([]);
  });
});

/* ================= the field, driven directly ================= */

function Harness({ fetched }: { fetched: SupplierOption[] | null }) {
  const [value, setValue] = useState('');
  const picker = useQuickSupplier(fetched, setValue);
  return (
    <>
      <SupplierSelectField picker={picker} id="harness-supplier" label="ספק *"
        placeholder="בחר ספק..." value={value} />
      <span data-testid="harness-selected">{value}</span>
    </>
  );
}

describe('SupplierSelectField — the affordance next to the select', () => {
  it('keeps the selection when the refetch finally lands, and never doubles the option', async () => {
    const user = userEvent.setup();
    useSupplierTable([]);
    useSupplierInsert();
    const view = render(wrap(<Harness fetched={[{ id: 'sup-1', name: 'ספק קיים בע״מ' }]} />));

    await createSupplier(user);
    await waitFor(() => expect(screen.getByTestId('harness-selected')).toHaveTextContent('sup-new'));

    // The refetch lands and now carries the row the caller added locally.
    view.rerender(wrap(<Harness fetched={[{ id: 'sup-1', name: 'ספק קיים בע״מ' }, NEW_ROW]} />));
    await waitFor(() => expect(screen.getAllByRole('option', { name: NEW_ROW.name })).toHaveLength(1));
    expect(screen.getByTestId('harness-selected')).toHaveTextContent('sup-new');
    expect(screen.getByLabelText('ספק *')).toHaveValue('sup-new');
  });

  it('ties the button to the field it fills, for a reader that cannot see they are adjacent', async () => {
    render(wrap(<Harness fetched={[]} />));

    // One group holds both, so the button is announced inside the field and not as a loose control.
    const group = screen.getByRole('group', { name: 'ספק — בחירה או יצירה' });
    const select = within(group).getByLabelText('ספק *');
    expect(select.tagName).toBe('SELECT');
    const button = within(group).getByRole('button', { name: 'ספק חדש' });

    // The user who is stuck is sitting on the select, so the select is where the door is announced.
    expect(select).toHaveAccessibleDescription(SUPPLIER_FIELD_QUICK_CREATE_HINT);
    // And the button says what pressing it does to that field — the part adjacency only implies.
    expect(button).toHaveAccessibleDescription(QUICK_CREATE_SUPPLIER_HINT);

    // The group must NOT repeat the field's own name: the invoice-linked browser gate
    // locates this select with Playwright's getByLabel('ספק *', { exact: true }), which reads
    // aria-labelledby too — a second element with that name is a strict-mode violation there.
    expect(screen.getAllByLabelText('ספק *')).toHaveLength(1);
  });

  it('is reachable by keyboard from the select, and opens on Enter', async () => {
    const user = userEvent.setup();
    useSupplierTable([]);
    render(wrap(<Harness fetched={[]} />));

    screen.getByLabelText('ספק *').focus();
    await user.tab();
    expect(newSupplierButton()).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: 'ספק חדש' })).toBeInTheDocument();
  });

  it('offers no button to an accountant — and says who can, instead of nothing', () => {
    auth.current.profile.role = 'accountant';
    render(wrap(<Harness fetched={[]} />));

    expect(screen.getByLabelText('ספק *')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ספק חדש' })).toBeNull();
    // Still no group named "בחירה או יצירה" around a lone select: that would send a screen-reader
    // accountant hunting for an affordance that was never rendered — a dead end manufactured by
    // the accessibility layer.
    expect(screen.queryByRole('group')).toBeNull();

    /**
     * G1, finding 4. This assertion used to read `.not.toHaveAccessibleDescription()`, i.e. it
     * PINNED the silence: a required "ספק *" field, no button, and not one word about why. The
     * fence is right — supplier creation is owner/office only — but financial screens can still
     * need supplier context. The sentence is the field's own, so every screen that mounts it
     * inherits the same next step.
     */
    expect(screen.getByText(SUPPLIER_FIELD_NO_CREATE_HINT)).toBeInTheDocument();
    expect(screen.getByLabelText('ספק *')).toHaveAccessibleDescription(SUPPLIER_FIELD_NO_CREATE_HINT);
  });

  it('does not tell a permitted user to ask somebody else merely because the field is locked', () => {
    render(wrap(
      <SupplierSelectField
        picker={{
          suppliers: [], canCreate: true, dialogOpen: false,
          openDialog: () => {}, closeDialog: () => {}, select: () => {}, acceptCreated: () => {},
        }}
        id="locked-supplier" label="ספק *" placeholder="בחר ספק..." value="" disabled />,
    ));

    // `disabled && canCreate` is /invoices/new with a linked order: the button is visible and grey,
    // and this user MAY create suppliers — just not here. "בקש ממנהל המשרד" would be false.
    expect(screen.queryByText(SUPPLIER_FIELD_NO_CREATE_HINT)).toBeNull();
  });

  it('disables the button with the select — a field you may not change is not a field you may add to', () => {
    render(wrap(
      <SupplierSelectField
        picker={{
          suppliers: [], canCreate: true, dialogOpen: false,
          openDialog: () => {}, closeDialog: () => {}, select: () => {}, acceptCreated: () => {},
        }}
        id="locked-supplier" label="ספק *" placeholder="בחר ספק..." value="" disabled />,
    ));

    const select = screen.getByLabelText('ספק *');
    expect(select).toBeDisabled();
    expect(newSupplierButton()).toBeDisabled();
    // Nothing promises a door that cannot be opened: no group, and neither control is described.
    expect(screen.queryByRole('group')).toBeNull();
    expect(select).not.toHaveAccessibleDescription();
    expect(newSupplierButton()).not.toHaveAccessibleDescription();

    // And the references are dropped, not merely left pointing at spans that stopped rendering.
    // `toHaveAccessibleDescription` cannot tell those apart — an unresolvable id yields no
    // description either way — but axe's `aria-valid-attr-value` can, and check-browser-smoke
    // audits these screens. A dangling aria-describedby is a gate failure, not a cosmetic one.
    expect(select).not.toHaveAttribute('aria-describedby');
    expect(newSupplierButton()).not.toHaveAttribute('aria-describedby');
  });

  it('keeps a caller-supplied description when the field is locked', () => {
    render(wrap(
      <>
        <SupplierSelectField
          picker={{
            suppliers: [], canCreate: true, dialogOpen: false,
            openDialog: () => {}, closeDialog: () => {}, select: () => {}, acceptCreated: () => {},
          }}
          id="locked-supplier" label="ספק *" placeholder="בחר ספק..." value=""
          disabled describedBy="locked-supplier-help" />
        <div id="locked-supplier-help">הספק נקבע לפי הרשומות המקושרות ואינו ניתן לשינוי כאן.</div>
      </>,
    ));

    // Dropping the quick-create hint must not drop the caller's own — /invoices/new says exactly
    // this when a linked order fixed the supplier, and that sentence is the reason it is disabled.
    expect(screen.getByLabelText('ספק *'))
      .toHaveAccessibleDescription('הספק נקבע לפי הרשומות המקושרות ואינו ניתן לשינוי כאן.');
  });
});

/* ================= the screen he named ================= */

describe('PriceListUploadModal — the dialog that already creates products on the fly', () => {
  const renderModal = () => render(wrap(<PriceListUploadModal onClose={() => {}} />));

  it('creates a supplier without leaving the dialog and selects it on the spot', async () => {
    const user = userEvent.setup();
    useSupplierTable();
    const bodies = useSupplierInsert();
    renderModal();

    await screen.findByRole('option', { name: EXISTING.name });
    await createSupplier(user);

    await waitFor(() => expect(screen.getByLabelText('ספק *')).toHaveValue('sup-new'));
    expect(screen.getByRole('option', { name: NEW_ROW.name })).toBeInTheDocument();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ p_document_id: null, p_name: NEW_ROW.name, p_tax_id: null });
    // The nested dialog is the caller's to close, and the caller closed it — leaving the upload
    // dialog open behind it.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ספק חדש' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'העלאת מחירון' })).toBeInTheDocument();
  });

  it('gives focus back to the button that opened the nested dialog', async () => {
    const user = userEvent.setup();
    useSupplierTable();
    useSupplierInsert();
    // `useDialogLayer` restores the opener only if it still has a box, and jsdom lays nothing out,
    // so `getClientRects()` is empty for every element and the restore branch is unreachable by
    // default — the assertion below would report a jsdom artifact as a product defect. Giving the
    // guard the one fact a real browser supplies is what makes the branch testable at all.
    vi.spyOn(HTMLElement.prototype, 'getClientRects')
      .mockReturnValue([{}] as unknown as DOMRectList);
    renderModal();

    await screen.findByRole('option', { name: EXISTING.name });
    const trigger = newSupplierButton();
    await createSupplier(user);

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ספק חדש' })).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes only the nested dialog on Escape — the upload dialog is not collateral', async () => {
    const user = userEvent.setup();
    useSupplierTable();
    const bodies = useSupplierInsert();
    renderModal();

    await screen.findByRole('option', { name: EXISTING.name });
    await user.click(newSupplierButton());
    const dialog = await screen.findByRole('dialog', { name: 'ספק חדש' });
    await waitFor(() => expect(dialog).toHaveFocus());

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'ספק חדש' })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'העלאת מחירון' })).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
  });

  it('does not lose the file already chosen — a nested dialog is not a restart', async () => {
    const user = userEvent.setup();
    useSupplierTable();
    useSupplierInsert();
    renderModal();

    const fileField = await screen.findByLabelText(/קובץ מחירון \*/) as HTMLInputElement;
    await user.upload(fileField, new File(['מוצר,מחיר\n'], 'מחירון.csv', { type: 'text/csv' }));
    // A spreadsheet takes the preview route, so this label is proof the File is still in state —
    // not merely that the input element survived the re-render.
    expect(screen.getByRole('button', { name: 'המשך לתצוגה מקדימה' })).toBeInTheDocument();

    await createSupplier(user);

    await waitFor(() => expect(screen.getByLabelText('ספק *')).toHaveValue('sup-new'));
    expect(fileField.files?.[0]?.name).toBe('מחירון.csv');
    expect(screen.getByRole('button', { name: 'המשך לתצוגה מקדימה' })).toBeInTheDocument();
  });

});

/* ================= the other two dead ends ================= */

describe('InvoiceNew — the same door', () => {
  it('creates and selects the supplier without abandoning the invoice', async () => {
    const user = userEvent.setup();
    useSupplierTable();
    useSupplierInsert();
    render(wrap(<InvoiceNew />, '/invoices/new'));

    await screen.findByRole('option', { name: EXISTING.name });
    // The browser scenarios drive this id; it must survive the restructure.
    expect(document.querySelector('#invoice-new-supplier')).not.toBeNull();

    await createSupplier(user);

    await waitFor(() => expect(screen.getByLabelText('ספק *')).toHaveValue('sup-new'));
    expect(screen.getByRole('option', { name: NEW_ROW.name })).toBeInTheDocument();
  });

  it('defaults the manual invoice currency from the selected supplier', async () => {
    const user = userEvent.setup();
    useSupplierTable();
    server.use(http.get(CURRENCIES_ENDPOINT, () => HttpResponse.json([
      { code: 'ILS', minor_units: 2 }, { code: 'USD', minor_units: 2 },
    ])));
    render(wrap(<InvoiceNew />, '/invoices/new'));

    await screen.findByRole('option', { name: EXISTING.name });
    await user.selectOptions(screen.getByLabelText('ספק *'), EXISTING.id);
    expect(screen.getByLabelText('מטבע *')).toHaveValue('USD');
  });

});

describe('PaymentRequests — the same door', () => {
  /** One open invoice for `sup-1`, and nothing for anybody else. */
  const OPEN_INVOICE = {
    id: 'inv-1', invoice_number: '1001', invoice_date: '2026-07-01',
    total_amount: 1234, currency: 'ILS', review_status: 'approved', payment_status: 'unpaid',
  };

  const useScreenTables = () => {
    useSupplierTable();
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/payment_requests`, () => HttpResponse.json([])),
      http.get(`${SUPABASE_URL}/rest/v1/invoices`, ({ request }) => HttpResponse.json(
        new URL(request.url).searchParams.get('supplier_id') === 'eq.sup-1' ? [OPEN_INVOICE] : [],
      )),
      http.post(`${SUPABASE_URL}/rest/v1/rpc/payment_request_financial_check_signals`, () =>
        HttpResponse.json({
          requested_invoice_count: 1, visible_invoice_count: 1, paid_invoice_count: 0,
          unapproved_invoice_count: 0, amount_matches_open_balance: true,
          similar_bank_transfer_check: 'unavailable',
          currency: 'ILS', open_credit_total_by_currency: [],
          over_allocated_invoice_count: 0,
        })),
    );
  };

  /** Intl puts non-breaking spaces in ₪ amounts; both sides get flattened so neither can lie. */
  const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
  const amountText = () => flat(screen.getByText('סכום הדרישה').parentElement?.textContent ?? '');

  it('creates and selects the supplier inside the new-request dialog', async () => {
    const user = userEvent.setup();
    useScreenTables();
    useSupplierInsert();
    render(wrap(<PaymentRequests />, '/payment-requests'));

    await user.click(await screen.findByRole('button', { name: 'דרישה חדשה' }));
    await screen.findByRole('option', { name: EXISTING.name });
    // The browser scenarios drive this id; it must survive the restructure.
    expect(document.querySelector('#payment-request-supplier')).not.toBeNull();

    await createSupplier(user);

    await waitFor(() => expect(screen.getByLabelText('ספק *')).toHaveValue('sup-new'));
    expect(screen.getByRole('option', { name: NEW_ROW.name })).toBeInTheDocument();
  });

  /**
   * The one invariant in this change that touches money.
   *
   * `setChosen({})` in the picker callback (PaymentRequests.tsx:207-210) is load-bearing, and not
   * obviously so: `amount` sums EVERY value in `chosen` and `invoiceIds` is EVERY key of it, both
   * independent of whichever `invoices` are currently loaded, and both go straight into `save()`.
   * Leave `chosen` populated across a supplier change and the saved payment request names supplier
   * B while carrying supplier A's invoice ids and A's amount.
   *
   * Creating a supplier is the route that makes this reachable rather than theoretical: it changes
   * the supplier without going through the `<select>`. It is covered here for both routes at once,
   * because both go through the one callback — which is why it was written that way, and therefore
   * the thing worth pinning.
   */
  it('drops the previous supplier\'s chosen invoices — and its amount — when one is created', async () => {
    const user = userEvent.setup();
    useScreenTables();
    useSupplierInsert();
    render(wrap(<PaymentRequests />, '/payment-requests'));

    await user.click(await screen.findByRole('button', { name: 'דרישה חדשה' }));
    await screen.findByRole('option', { name: EXISTING.name });
    await user.selectOptions(screen.getByLabelText('ספק *'), 'sup-1');

    await user.click(await screen.findByRole('checkbox', { name: /בחירת חשבונית 1001/ }));
    expect(amountText()).toContain(flat(fmtMoneyExact(1234, 'ILS')));

    await createSupplier(user);

    await waitFor(() => expect(screen.getByLabelText('ספק *')).toHaveValue('sup-new'));
    // The new supplier has no invoices, and the request no longer carries the old one's money.
    expect(amountText()).toContain(flat(fmtMoneyExact(0, 'ILS')));
    expect(amountText()).not.toContain(flat(fmtMoneyExact(1234, 'ILS')));
    expect(screen.queryByRole('checkbox', { name: /בחירת חשבונית 1001/ })).toBeNull();
  });
});
