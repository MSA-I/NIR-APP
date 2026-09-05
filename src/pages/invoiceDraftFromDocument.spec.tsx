/**
 * DOC-05 and DOC-13 — the invoice draft a reviewed document produces, as the form shows it.
 *
 * Both findings were measured on ONE screen, `/invoices/new?document=<id>`, reached from the
 * review of the sweep's document U3. The supplier's page prints `31/07/26` and `מע"מ (18.00%)`;
 * the extraction agreed with both and marked the date `זוהה בבירור`. The form showed neither.
 *
 *   DOC-05 — `תאריך חשבונית` read 04/09/2026, today. Saving as offered books a July invoice into
 *            September: it moves in aging, in the monthly report and in every payment-terms
 *            calculation, and unlike an empty required field a plausible wrong date is invisible.
 *
 *   DOC-13 — the VAT box was labelled `מע״מ (17.5%)` beside a value of 133.2, which is 18.00% of
 *            the 740.00 VAT-liable base the document prints. 17.5 is this tenant's configured
 *            `organizations.vat_rate` (OWN-12); no rate produced the number on screen, and a
 *            person who recomputes from the label gets a different one.
 *
 * The control at the bottom passes in BOTH runs and is the point of the file. A label that never
 * names a rate would satisfy DOC-13's letter and damage the form: on a blank invoice the rate IS
 * in force — it is what `onBeforeVat`/`onTotal` apply the moment an amount is typed — and the
 * label is the only place the person is told which one. So the claim is narrower than "drop the
 * percentage": the label may name a rate exactly when that rate produced, or will produce, the
 * number beside it.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { he } from '../lib/i18n/dictionaries/he';
import { todayISO } from '../lib/format';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

/* 17.50 is the value the sweep read off this tenant's `organizations` row, not a convenient
   fixture: OWN-12 is why DOC-13 was visible at all, and a fixture carrying the product's own
   default would have hidden the disagreement the finding is about. */
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { role: 'office', full_name: 'פקידה', org_id: 'org-1' },
    org: { id: 'org-1', vat_rate: 17.5, base_currency: 'ILS', country_code: 'IL', settings: {} },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import InvoiceNew from './InvoiceNew';

const DOCUMENT_ID = '69517a3e-36db-41ee-9948-aeb72239fa73';
const DATE_LABEL = he.invoiceNew.set_2;

/** The supplier's own page, as the reader returned it: day-first with a two-digit year. */
const interpretation = {
  payload: {
    schema_version: '1',
    document_type: 'invoice',
    document_type_confidence: 0.99,
    supplier: { suggested_id: 'sup-il', suggested_name: 'ספק מקומי', confidence: 0.99, evidence_block_ids: [] },
    fields: [
      { key: 'invoice_number', value: 'SI266001312', confidence: 0.99, evidence_block_ids: [] },
      { key: 'invoice_date', value: '31/07/26', confidence: 0.99, evidence_block_ids: [] },
      { key: 'subtotal', value: 20720.8, confidence: 0.98, evidence_block_ids: [] },
      { key: 'vat_amount', value: 133.2, confidence: 0.98, evidence_block_ids: [] },
      { key: 'total', value: 20854, confidence: 0.98, evidence_block_ids: [] },
      { key: 'currency', value: 'ILS', confidence: 0.99, evidence_block_ids: [] },
    ],
    line_items: [],
    suggested_annotations: [],
  },
  suggested_supplier_id: 'sup-il',
};

const suppliers = [
  { id: 'sup-il', name: 'ספק מקומי', default_currency: 'ILS', country_code: 'IL', deleted_at: null },
  { id: 'sup-us', name: 'Overseas Supply Co', default_currency: 'USD', country_code: 'US', deleted_at: null },
];

const traffic = [
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json(suppliers)),
  http.get(`${SUPABASE_URL}/rest/v1/currencies`, () => HttpResponse.json([
    { code: 'ILS', minor_units: 2 },
    { code: 'USD', minor_units: 2 },
  ])),
  http.get(`${SUPABASE_URL}/rest/v1/document_interpretations`, () => HttpResponse.json(interpretation)),
  http.get(`${SUPABASE_URL}/rest/v1/documents`, () => HttpResponse.json({ file_name: 'u3-invoice.jpeg' })),
  // The duplicate checks fire the moment supplier, number and total are all on the form. They are
  // not under test; they are described so an undescribed request cannot be read as a finding.
  http.get(`${SUPABASE_URL}/rest/v1/invoices`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () => HttpResponse.json([])),
];

function renderForm(search: string) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={[`/invoices/new${search}`]}>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<InvoiceNew />, { wrapper: Wrapper });
}

/** The VAT box is addressed by id, not by accessible name: `סכום לפני מע״מ` contains `מע״מ` too,
 *  and a name query would match two boxes and report an ambiguity instead of the label. */
const vatLabelText = (): string =>
  document.querySelector('label[for="invoice-new-vat"]')?.textContent?.trim() ?? '';

describe('DOC-05 · הטיוטה נושאת את תאריך המסמך, לא את היום', () => {
  it('ממלאת את תאריך החשבונית מהתאריך שהמסמך מדפיס, גם כששנתו דו-ספרתית', async () => {
    server.use(...traffic);
    renderForm(`?document=${DOCUMENT_ID}`);

    // The number and the amounts arrive; the date is the field the finding is about, so its
    // neighbours are asserted first — a date left behind while nothing else was is the defect,
    // and a form that filled nothing would be a different failure wearing the same red.
    expect(await screen.findByDisplayValue('SI266001312')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('20854')).toBeInTheDocument();

    const date = await screen.findByLabelText(DATE_LABEL);
    expect(date).toHaveValue('2026-07-31');
    expect(date).not.toHaveValue(todayISO());
  });
});

describe('DOC-13 · תווית המע״מ מצהירה רק על שיעור שבאמת יצר את המספר שלידה', () => {
  it('אינה מצהירה על שיעור הארגון ליד סכום שהגיע מהמסמך', async () => {
    server.use(...traffic);
    renderForm(`?document=${DOCUMENT_ID}`);

    expect(await screen.findByDisplayValue('133.2')).toBeInTheDocument();
    expect(vatLabelText()).toBe('מע״מ');
  });

  it('אינה מצהירה על שיעור מקומי כשהספק אינו מקומי והטופס אינו מחשב מע״מ כלל', async () => {
    server.use(...traffic);
    renderForm('?supplier=sup-us');

    await screen.findByLabelText(DATE_LABEL);
    expect(vatLabelText()).toBe('מע״מ');
  });

  /* Control — passes before and after. On a blank invoice the organisation rate IS the rate in
     force, and dropping it here would trade one wrong label for a missing one. */
  it('כן מצהירה על שיעור הארגון בטופס ריק, שם הוא באמת השיעור שיופעל', async () => {
    server.use(...traffic);
    renderForm('');

    await screen.findByLabelText(DATE_LABEL);
    expect(vatLabelText()).toBe('מע״מ (17.5%)');
  });
});
