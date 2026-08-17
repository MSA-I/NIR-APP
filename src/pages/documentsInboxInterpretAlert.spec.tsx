// The decode alert in the documents folder, and the state it is allowed to describe.
//
// The folder asks the interpretation service for every job sitting at 'extracted', gives up after
// three failures, and raises a banner. The banner was then permanent for the rest of the session:
// the only line that cleared it lived inside the same loop that had already excluded the job on
// its third attempt (`attempts < 3`), so it could never run again for that job. A document could
// reach "דורש בדיקה" — from the review screen, from a reprocess, from a fourth attempt in another
// tab — and the person was still being told their decoding had failed.
//
// What is asserted is the tie between the two: the banner appears from real failures, and it is
// withdrawn by the server saying the job is no longer waiting. Nothing here asserts wording.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
    profile: { id: 'owner-1', role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { settings: {} },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import DocumentsGallery from './DocumentsInbox';
import { DOCUMENT_PROCESSING_CHANGED_EVENT } from '../lib/useDocumentProcessing';

const DOC = {
  id: 'doc-1', org_id: 'org-1', entity_type: 'inbox', entity_id: null,
  storage_path: 'org-1/doc-1.pdf', file_name: 'חשבונית.pdf', mime_type: 'application/pdf',
  document_kind: 'other', supplier_id: null, document_date: '2026-08-01',
  uploaded_by: null, created_at: '2026-08-01T00:00:00Z', deleted_at: null, deleted_by: null,
  supplier: null,
};

/** Mutable, because the point of the test is what happens when the server's answer changes. */
const jobState = { status: 'extracted' };

// Timestamps relative to now: a fixed one would eventually cross the two-hour threshold in
// `isDocumentProcessingStuck` and change which badge the row renders.
const job = () => ({
  id: 'job-1', org_id: 'org-1', document_id: 'doc-1', requested_by: 'owner-1',
  status: jobState.status, input_checksum: 'etag:1', contract_version: '1', priority: 0,
  attempt_count: 1, lease_owner: null, lease_until: null,
  processing_attempt_id: null, processing_attempt_started_at: null,
  last_error_code: null, last_error_message: null,
  created_at: new Date(Date.now() - 60_000).toISOString(),
  updated_at: new Date(Date.now() - 10_000).toISOString(),
  queue_age_seconds: 60, is_stuck: false, stuck_reason: null,
});

const interpretCalls = { count: 0 };

const traffic = () => [
  http.get(`${SUPABASE_URL}/rest/v1/documents`, () => HttpResponse.json([DOC])),
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/document_auto_actions`, () => HttpResponse.json([])),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_document_processing_statuses`, () => HttpResponse.json([job()])),
  http.post(`${SUPABASE_URL}/functions/v1/interpret-document`, () => {
    interpretCalls.count += 1;
    return HttpResponse.json({ error: { message: 'interpretation service unavailable' } }, { status: 500 });
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

const ALERT = /שלב הפענוח לא הצליח/;

describe('התראת הפענוח בתיקיית המסמכים', () => {
  beforeEach(() => {
    jobState.status = 'extracted';
    interpretCalls.count = 0;
    server.use(...traffic());
  });

  it('נעלמת ברגע שהשרת מדווח שהמסמך כבר אינו ממתין לפענוח', async () => {
    renderGallery();

    // Three real failures, then the banner. Nothing shortcuts them.
    expect(await screen.findByText(ALERT, undefined, { timeout: 10_000 })).toBeInTheDocument();
    expect(interpretCalls.count).toBeGreaterThanOrEqual(3);

    // The document moves on without this screen: a retry from the review screen, a reprocess, a
    // fourth attempt in another tab. The next refetch is where the folder learns about it.
    jobState.status = 'review';
    await act(async () => {
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText(ALERT)).toBeNull());
  }, 25_000);

  it('נשארת כל עוד המסמך עדיין ממתין לפענוח', async () => {
    renderGallery();
    expect(await screen.findByText(ALERT, undefined, { timeout: 10_000 })).toBeInTheDocument();

    // A refetch that changes nothing must not withdraw a failure the person has not seen resolved.
    await act(async () => {
      window.dispatchEvent(new Event(DOCUMENT_PROCESSING_CHANGED_EVENT));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByText(ALERT)).toBeInTheDocument());
  }, 25_000);
});
