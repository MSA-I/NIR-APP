/**
 * DOC-11 — the 409 an upload burst produced, and who produced it.
 *
 * Three files uploaded within 15 s, and `POST functions/v1/interpret-document` answered 409 once.
 * No document was lost, which is what made it look harmless: the sweep recorded "a 409 in the log
 * with no user-visible consequence".
 *
 * The conflict is not the server's. `interpret-document` refuses a SECOND request for a job whose
 * egress lease is already held (`index.ts` — `if (egressLease.idempotent) … interpretation_in_progress`,
 * 409), which is exactly right. The second request came from this screen. The folder asks for
 * every job it sees at 'extracted', releases its in-flight marker the moment the response lands,
 * and keeps NO memory that it already asked — so any effect pass that runs before the refetched
 * status arrives sees the same job still 'extracted' and asks again. On the burst that window is
 * wide open, because three uploads keep the processing snapshot changing.
 *
 * THE SERVER'S CONFLICT RULE IS MODELLED, not asserted around. The handler below accepts the first
 * request for a job and answers 409 to every later one, as the Edge function does, and the job
 * stays 'extracted' in the folder's read — the stale window, held open so the invariant is tested
 * rather than raced. What is pinned is that the folder never trips it.
 *
 * Retrying a FAILED interpretation is untouched and pinned next door by
 * `documentsInboxInterpretAlert.spec.tsx` (three attempts, then a banner). The memory added here
 * is of a SUCCESS, and a reprocess writes a new job row with a new id (`reprocess_document`,
 * 0045), so a document sent round again is a different job and is asked for again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
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
    profile: { id: 'office-1', role: 'office', full_name: 'בודקת', org_id: 'org-1' },
    org: { settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import DocumentsGallery from './DocumentsInbox';
import { DOCUMENT_PROCESSING_CHANGED_EVENT } from '../lib/useDocumentProcessing';

const IDS = ['doc-a', 'doc-b', 'doc-c'];

const documents = () => IDS.map((id, index) => ({
  id, org_id: 'org-1', entity_type: 'inbox', entity_id: null,
  storage_path: `org-1/${id}.pdf`, file_name: `חשבונית-${index + 1}.pdf`, mime_type: 'application/pdf',
  document_kind: 'other', supplier_id: null, document_date: '2026-09-04',
  uploaded_by: null, created_at: '2026-09-04T00:00:00Z', deleted_at: null, deleted_by: null,
  supplier: null,
}));

/** Every job stays at 'extracted': the read the folder has not caught up on yet. */
const jobs = () => IDS.map((id) => ({
  id: `job-${id}`, org_id: 'org-1', document_id: id, requested_by: 'office-1',
  status: 'extracted', input_checksum: 'etag:1', contract_version: '1', priority: 0,
  attempt_count: 1, lease_owner: null, lease_until: null,
  processing_attempt_id: null, processing_attempt_started_at: null,
  last_error_code: null, last_error_message: null,
  created_at: new Date(Date.now() - 60_000).toISOString(),
  updated_at: new Date(Date.now() - 10_000).toISOString(),
  queue_age_seconds: 60, is_stuck: false, stuck_reason: null,
}));

const interpret = { accepted: new Set<string>(), conflicts: 0, total: 0 };

const traffic = () => [
  http.get(`${SUPABASE_URL}/rest/v1/documents`, () => HttpResponse.json(documents())),
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/document_auto_actions`, () => HttpResponse.json([])),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_document_processing_statuses`, () => HttpResponse.json(jobs())),
  http.post(`${SUPABASE_URL}/functions/v1/interpret-document`, async ({ request }) => {
    const body = await request.json() as { jobId?: string };
    const jobId = body.jobId ?? '';
    interpret.total += 1;
    // `egressLease.idempotent` — the second caller for one job is refused, deliberately.
    if (interpret.accepted.has(jobId)) {
      interpret.conflicts += 1;
      return HttpResponse.json(
        { error: { code: 'interpretation_in_progress', message: 'interpretation_in_progress' } },
        { status: 409 },
      );
    }
    interpret.accepted.add(jobId);
    return HttpResponse.json({ interpretationId: `int-${jobId}`, jobId, status: 'review' });
  }),
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

describe('DOC-11 — a three-document burst produces no interpretation conflict', () => {
  beforeEach(() => {
    interpret.accepted.clear();
    interpret.conflicts = 0;
    interpret.total = 0;
    server.use(...traffic());
  });

  it('asks for each job once and never trips the server\'s conflict', async () => {
    renderGallery();

    // The three uploads land; each one moves the processing read, which is what re-runs the
    // dispatch effect while the previous answers are still settling.
    await waitFor(() => expect(interpret.accepted.size).toBe(IDS.length), { timeout: 10_000 });
    for (let burst = 0; burst < 3; burst += 1) {
      await act(async () => {
        window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
        await Promise.resolve();
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(interpret.conflicts).toBe(0);
    expect(interpret.total).toBe(IDS.length);
  }, 25_000);
});
