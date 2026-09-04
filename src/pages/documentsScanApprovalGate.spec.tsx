/**
 * DOC-01 — the manual scan-approval gate, as the library reports it.
 *
 * A photograph uploaded from a phone does not go straight to the reader: it stops at a scan
 * approval a PERSON has to give, and `document_processing_jobs.status` says so — `awaiting_scan`.
 * `documentStatus.ts` had a state for `review` and a state for `unassigned` and none for this one,
 * so the document fell past every processing branch to the residual `isUnassigned` and the row
 * told the reader to attach it to an invoice: an action that neither starts the reading nor is
 * possible yet. Two uploads sat there for 477 s, and three older documents for two days, with
 * nothing on the screen saying a person was being waited on.
 *
 * So the assertion is not "a nicer label". It is that the library names the gate, names the
 * action that clears it, and offers the way in — and that it no longer prints the filing
 * instruction, which is the sentence that sent the reader looking in the wrong place.
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
import { documentUiStatus } from '../lib/documentStatus';

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
    profile: { role: 'office', full_name: 'בודקת', org_id: 'org-1' },
    org: { settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import DocumentsGallery from './DocumentsInbox';

const DOC_ID = 'doc-awaiting-scan';
const FILE_NAME = 'WhatsApp Image 2026-08-16 at 14.02.58.jpeg';

const documentRow = {
  id: DOC_ID, org_id: 'org-1', entity_type: 'inbox', entity_id: null,
  storage_path: `org-1/${DOC_ID}.jpeg`, file_name: FILE_NAME, mime_type: 'image/jpeg',
  document_kind: 'other', supplier_id: null, document_date: null,
  uploaded_by: null, created_at: '2026-09-02T09:00:00Z', deleted_at: null, deleted_by: null,
  supplier: null,
};

/** The row `get_document_processing_statuses` returns for a scan that nobody has approved yet. */
const awaitingScanJob = {
  id: 'job-1', org_id: 'org-1', document_id: DOC_ID, requested_by: 'user-1',
  status: 'awaiting_scan', input_checksum: 'sha', contract_version: '3', priority: 5,
  attempt_count: 0, lease_owner: null, lease_until: null,
  processing_attempt_id: null, processing_attempt_started_at: null,
  last_error_code: null, last_error_message: null,
  created_at: '2026-09-02T09:00:05Z', updated_at: '2026-09-02T09:00:05Z',
  queue_age_seconds: 477, is_stuck: false, stuck_reason: null,
  progress_done: null, progress_total: null,
};

const traffic = [
  http.get(`${SUPABASE_URL}/rest/v1/documents`, () => HttpResponse.json([documentRow])),
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/document_auto_actions`, () => HttpResponse.json([])),
  http.post(
    `${SUPABASE_URL}/rest/v1/rpc/get_document_processing_statuses`,
    () => HttpResponse.json([awaitingScanJob]),
  ),
];

function renderGallery() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<DocumentsGallery />, { wrapper: Wrapper });
}

describe('documentUiStatus knows the scan-approval gate', () => {
  const inbox = { entity_type: 'inbox', entity_id: null };

  it('does not resolve a scan waiting for approval to the residual unassigned state', () => {
    const status = documentUiStatus({
      status: 'queued', job: awaitingScanJob as never, document: inbox,
      evaluatedAt: Date.parse('2026-09-02T09:08:02Z'),
    });
    expect(status.state).toBe('awaiting_scan');
    // The filing filter counts an unassigned row as work for the filing clerk. A document nobody
    // has read yet is not that, and counting it there is how it hid in plain sight.
    expect(status.countsAsUnassigned).toBe(false);
  });

  it('ranks it with the work that waits on a person, not below it', () => {
    const gate = documentUiStatus({
      status: 'queued', job: awaitingScanJob as never, document: inbox,
      evaluatedAt: Date.parse('2026-09-02T09:08:02Z'),
    });
    const filing = documentUiStatus({ status: 'completed', document: inbox });
    expect(gate.priority).toBeLessThan(filing.priority);
  });
});

/**
 * The row is rendered before the job is: the gallery lists documents first and only then asks
 * `get_document_processing_statuses` about the ids it now has. Every assertion below therefore
 * waits for the SECOND wave — asserting on the first would be asserting about a row the app has
 * not been told the status of yet, which is a different (and always-unassigned) claim.
 */
describe('DOC-01 · תיקיית המסמכים על סריקה שממתינה לאישור', () => {
  it('קוראת למצב בשמו ולא ״לא משויך״', async () => {
    server.use(...traffic);
    renderGallery();

    // Waited on the row's own sentence, not on the label: "ממתין לאישור סריקה" is now also a
    // filter option, and an option exists before any status has been fetched — so waiting on it
    // would let this assertion run against the first render, where every row is unassigned.
    expect(await screen.findAllByText(/צריך לפתוח את המסמך ולאשר את הסריקה/)).not.toHaveLength(0);
    // Asserted on the BADGE and not on the page, because "לא משויך" is also the name of a filter
    // option — a control offering to narrow the list, which is a different claim from a row
    // stating what is true of the document in front of you.
    const badges = screen.getAllByTestId('document-processing-status');
    expect(badges).not.toHaveLength(0);
    for (const badge of badges) {
      expect(badge).toHaveTextContent('ממתין לאישור סריקה');
      expect(badge).not.toHaveTextContent('לא משויך');
    }
  });

  it('נותנת את הפעולה שמשחררת אותו, ולא את הוראת השיוך', async () => {
    server.use(...traffic);
    renderGallery();

    expect(await screen.findAllByText(/צריך לפתוח את המסמך ולאשר את הסריקה/)).not.toHaveLength(0);
    // The sentence the sweep read on this row. It sent the reader to a filing action that could
    // not have started the reading, and `file_document` would have refused it anyway.
    expect(screen.queryAllByText(/צריך לשייך אותו לחשבונית או לקבלת סחורה/)).toHaveLength(0);
  });

  it('מציעה קישור אל מסך הבדיקה, שבו נמצא הכפתור שמשחרר', async () => {
    server.use(...traffic);
    renderGallery();

    const links = await screen.findAllByRole('link', { name: 'אישור הסריקה' });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', `/documents/${DOC_ID}/review`);
  });

  it('מציגה כמה זמן הוא כבר ממתין, כי אף עובד לא יזיז אותו', async () => {
    server.use(...traffic);
    renderGallery();

    expect(await screen.findAllByText('· 7 דק׳')).not.toHaveLength(0);
  });
});
