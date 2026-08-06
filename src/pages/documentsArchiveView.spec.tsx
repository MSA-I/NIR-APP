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

/**
 * The gallery and the archive partition the register: an archived document belongs to exactly one
 * of the two screens. The requirement is that a document matching no category is *מועבר* to the
 * archive — moved, not tagged — so a row visible in both would mean it was never moved, and the
 * working folder would refill with the noise the archive exists to absorb.
 */
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
    profile: { role: 'owner', full_name: 'בודק', org_id: 'org-1' },
    org: { settings: {} },
    session: {},
  }),
}));

import DocumentsGallery from './DocumentsInbox';

const row = (id: string, fileName: string, entityType: string, entityId: string | null) => ({
  id, org_id: 'org-1', entity_type: entityType, entity_id: entityId,
  storage_path: `org-1/${id}.pdf`, file_name: fileName, mime_type: 'application/pdf',
  document_kind: 'other', supplier_id: null, document_date: '2026-08-01',
  uploaded_by: null, created_at: '2026-08-01T00:00:00Z', deleted_at: null, deleted_by: null,
  supplier: null,
});

const ARCHIVED = 'לא-מזוהה.pdf';
const FILED = 'חשבונית-1001.pdf';
const DOCS = [row('d-1', ARCHIVED, 'archive', null), row('d-2', FILED, 'invoice', 'inv-1')];

/**
 * The double interprets exactly the two operators the gallery puts on `entity_type`, `eq.` and
 * `neq.`, and nothing else — it is not a PostgREST reimplementation, and asserting rendered rows
 * would be worthless if it were, since the test would then be checking its own simulator. It fails
 * safe in the direction that matters: an absent or unrecognised filter returns every row, so a
 * dropped `.neq(...)` shows the archived document in the gallery and the assertion catches it.
 */
const documents = http.get(`${SUPABASE_URL}/rest/v1/documents`, ({ request }) => {
  const filter = new URL(request.url).searchParams.get('entity_type');
  const rows = DOCS.filter((doc) => {
    if (filter?.startsWith('eq.')) return doc.entity_type === filter.slice(3);
    if (filter?.startsWith('neq.')) return doc.entity_type !== filter.slice(4);
    return true;
  });
  return HttpResponse.json(rows);
});

// The gallery also asks for suppliers (filter dropdown) and for each row's processing job. Neither
// is under test here, and both are answered empty so the only thing that can vary between the two
// renders is which documents came back.
const quietTraffic = [
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/document_processing_jobs`, () => HttpResponse.json([])),
];

function renderGallery(props: { archive?: boolean }) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<DocumentsGallery {...props} />, { wrapper: Wrapper });
}

describe('חלוקת המסמכים בין התיקייה לארכיון', () => {
  // findAllByText, not findByText: DataTable renders the mobile card list and the desktop table
  // into the same DOM and lets CSS choose between them, so every row legitimately appears twice
  // in jsdom. The claim under test is presence and absence, which counting answers either way.
  it('הארכיון מציג את המסמך שלא שויך לאף קטגוריה, ורק אותו', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({ archive: true });
    expect(await screen.findAllByText(ARCHIVED)).not.toHaveLength(0);
    expect(screen.queryAllByText(FILED)).toHaveLength(0);
  });

  it('תיקיית המסמכים אינה מציגה מסמך שהועבר לארכיון', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({});
    expect(await screen.findAllByText(FILED)).not.toHaveLength(0);
    expect(screen.queryAllByText(ARCHIVED)).toHaveLength(0);
  });
});

// The same partition seen from the actions rather than the rows. uploadDocument writes
// entity_type='inbox', so an upload started from the archive lands in the other half of the
// partition: the toast reports success and the list the person is looking at never changes.
// Nothing files to the archive but apply_document_interpretation.
describe('כפתור ההעלאה', () => {
  it('אינו מוצג בארכיון — אין דרך אנושית להעלות לשם', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({ archive: true });
    expect(await screen.findAllByText(ARCHIVED)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /העלאת מסמך/ })).not.toBeInTheDocument();
  });

  it('מוצג בתיקיית המסמכים', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({});
    expect(await screen.findAllByText(FILED)).not.toHaveLength(0);
    expect(screen.queryByRole('button', { name: /העלאת מסמך/ })).toBeInTheDocument();
  });
});
