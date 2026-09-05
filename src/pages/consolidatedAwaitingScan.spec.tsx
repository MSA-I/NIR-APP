/**
 * MON-07 — the one consolidated-invoice case in the tenant, twenty-four hours after its page was
 * uploaded.
 *
 * What the owner saw: `עמוד 1 · consolidated-page-1.png · ממתין לזיהוי · ממתין לסריקה`, every
 * figure `—`, and `אין שורות בערוץ התאמה זה` in all three reconciliation channels. No error, no
 * elapsed time, and — the part that makes it a defect rather than a slow queue — nothing on the
 * screen that a person could act on. `ממתין לסריקה` names a state; it does not say that the state
 * is a gate a PERSON opens, and it does not say who.
 *
 * The state is `document_processing_jobs.status = 'awaiting_scan'`, which DOC-01 established is
 * the manual scan-approval gate: nothing is running, nobody is queued behind a worker, and the
 * document waits for someone to open it and approve the scan. That work produced the product's
 * canonical wording for the gate and the sentence naming the action that clears it. This screen
 * had neither, and it had its own private wording for the same state — the exact drift the
 * comment above `consolidatedStatusKey` warns about ("One state, one string").
 *
 * So the assertion is that this screen answers the gate with the product's answer: the state
 * named the way every other surface names it, and the instruction that says what to do — beside
 * the control that already leads there.
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
    profile: { role: 'owner', full_name: 'בעלים', org_id: 'org-1' },
    org: { id: 'org-1', vat_rate: 17.5, base_currency: 'ILS', country_code: 'IL', settings: {} },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import ConsolidatedInvoices from './ConsolidatedInvoices';

const CASE_ID = 'case-1';

const workspaceCase = {
  id: CASE_ID,
  supplier_id: 'sup-1',
  supplier_name: 'אריזות הדרום',
  target_month: '2026-08-01',
  legal_entity_id: 'le-1',
  legal_entity_name: 'ישות משפטית',
  status: 'awaiting_anchor',
  anchor_invoice_id: null,
  current_revision: 1,
  warning_count: 0,
  created_at: '2026-09-03T00:43:00Z',
  updated_at: '2026-09-03T00:43:00Z',
};

const page = (jobStatus: string) => ({
  page_number: 1,
  document_id: 'doc-1',
  file_name: 'consolidated-page-1.png',
  is_primary: true,
  job_id: 'job-1',
  job_status: jobStatus,
  interpretation_id: null,
  document_type: null,
});

const workspace = (jobStatus: string) => ({
  case: workspaceCase,
  anchor: null,
  intake: null,
  pages: [page(jobStatus)],
  sources: [],
  reconciliation: { anchor_vs_interim: [], anchor_vs_receipts: [], interim_vs_receipts: [] },
  current_revision: null,
  warnings: [],
});

const traffic = (jobStatus: string) => [
  http.post(`${SUPABASE_URL}/rest/v1/rpc/list_consolidated_invoice_cases`, () => HttpResponse.json([])),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/list_consolidated_invoice_legal_entities`, () =>
    HttpResponse.json([{ id: 'le-1', name: 'ישות משפטית' }])),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_consolidated_invoice_workspace`, () =>
    HttpResponse.json(workspace(jobStatus))),
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () =>
    HttpResponse.json([{ id: 'sup-1', name: 'אריזות הדרום' }])),
];

function renderCase() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter initialEntries={[`/documents/consolidated-invoices?case=${CASE_ID}`]}>
            {children}
          </MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<ConsolidatedInvoices />, { wrapper: Wrapper });
}

describe('MON-07 · עמוד חבילה שממתין לאישור סריקה', () => {
  it('קורא למצב בשם הקנוני של המוצר ולא בשם פרטי של המסך הזה', async () => {
    server.use(...traffic('awaiting_scan'));
    renderCase();

    // The whole row, not the file-name paragraph: the state is printed on the line below it, and
    // asserting against the wrong ancestor is a red that has nothing to do with the finding.
    const block = (await screen.findByText(/consolidated-page-1\.png/)).closest('li')!;
    expect(block).toHaveTextContent(he.documentStatus.awaitingScanApproval);
    // The private wording. It reads as a machine queue the owner can only wait out, which is
    // exactly the reading that let one page sit for a day with nobody looking at it.
    expect(block).not.toHaveTextContent('ממתין לסריקה');
  });

  it('אומר מה תקוע ומה לעשות, ולא רק באיזה מצב זה נמצא', async () => {
    server.use(...traffic('awaiting_scan'));
    renderCase();

    expect(await screen.findByText(he.documentStatus.awaitingScanApprovalDescription)).toBeInTheDocument();
  });

  /* Control — passes before and after. A page genuinely waiting on the reader has no action for
     a person to take, and printing one there would be the same non-information in the other
     direction: an instruction on every row is an instruction on none. */
  it('אינו מציג את ההוראה לעמוד שבאמת ממתין לעיבוד', async () => {
    server.use(...traffic('queued'));
    renderCase();

    await screen.findByText(/consolidated-page-1\.png/);
    expect(screen.queryByText(he.documentStatus.awaitingScanApprovalDescription)).toBeNull();
  });
});
