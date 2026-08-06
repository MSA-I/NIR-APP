import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
// The inbox row is the positive control for the row-action tests below. Both it and the archived
// row are unfiled by isUnfiled()'s reading — entity_id is null on each — so if the שיוך actions
// appear for one and not the other, the archive flag is the only thing that can explain it.
const UNFILED = 'סריקה-חדשה.pdf';
const DOCS = [
  row('d-1', ARCHIVED, 'archive', null),
  row('d-2', FILED, 'invoice', 'inv-1'),
  row('d-3', UNFILED, 'inbox', null),
];

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

// The gallery also asks for suppliers (filter dropdown), for each row's processing job, and — since
// 0077 — for the autonomy ledger behind the "שויך אוטומטית" badge. None is under test here, and all
// are answered empty so the only thing that can vary between the two renders is which documents
// came back. Answering `document_auto_actions` explicitly rather than leaving it unhandled is
// deliberate: the query only fires on the SECOND render, once the document ids exist, so an
// unstubbed endpoint would make these tests pass or fail on timing.
const quietTraffic = [
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/document_processing_jobs`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/document_auto_actions`, () => HttpResponse.json([])),
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

// Until 0075 gives something the ability to file a document to the archive, the heading and the
// empty state are the whole of that page for a visitor — so they are the part most worth pinning.
describe('מה שמסך הארכיון אומר על עצמו', () => {
  it('כותרת הארכיון, בלי הפסקה של תיקיית המסמכים', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({ archive: true });
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('ארכיון מסמכים');
    expect(screen.queryByText(/כל החשבוניות/)).not.toBeInTheDocument();
  });

  it('כותרת התיקייה, עם הפסקה שלה', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({});
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('תיקיית המסמכים');
    expect(screen.getByText(/כל החשבוניות/)).toBeInTheDocument();
  });

  // The state the archive is actually in until the interpretation layer starts filing, so it has
  // to say which emptiness it is: an archive holding nothing, not the register holding nothing.
  it('ארכיון ריק מסביר שהוא ריק, בלשון הארכיון', async () => {
    server.use(http.get(`${SUPABASE_URL}/rest/v1/documents`, () => HttpResponse.json([])), ...quietTraffic);
    renderGallery({ archive: true });
    expect(await screen.findByText('אין מסמכים בארכיון')).toBeInTheDocument();
    expect(screen.getByText(/לא הצליחה לשייך לאף קטגוריה/)).toBeInTheDocument();
    expect(screen.queryByText('אין מסמכים במערכת')).not.toBeInTheDocument();
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

// file_document takes only a row still in the inbox (0019:167), so offering שיוך on an archived
// document buys the user "המסמך כבר שויך ליעד עסקי" about a document that is here precisely
// because it could not be assigned anywhere.
describe('פעולות השיוך בתפריט השורה', () => {
  const openMenuFor = async (fileName: string) =>
    userEvent.click(screen.getAllByRole('button', { name: `פעולות עבור מסמך ${fileName}` })[0]);

  it('אינן מוצעות על מסמך בארכיון', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({ archive: true });
    await screen.findAllByText(ARCHIVED);
    await openMenuFor(ARCHIVED);
    expect(screen.queryByText('שיוך לחשבונית')).not.toBeInTheDocument();
    expect(screen.queryByText('שיוך לקבלת סחורה')).not.toBeInTheDocument();
  });

  it('מוצעות על מסמך לא משויך בתיקייה', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({});
    await screen.findAllByText(UNFILED);
    await openMenuFor(UNFILED);
    expect(screen.getByText('שיוך לחשבונית')).toBeInTheDocument();
    expect(screen.getByText('שיוך לקבלת סחורה')).toBeInTheDocument();
  });
});

// 0075 gives the archive its own filing action. Its gate is `!canFile || !archive` — the exact
// complement of the `!canFile || archive || !isUnfiled(doc)` above — so the two can never both
// render, and neither can be absent from the screen it belongs to.
describe('פעולות הארכיון', () => {
  const openMenuFor = async (fileName: string) =>
    userEvent.click(screen.getAllByRole('button', { name: `פעולות עבור מסמך ${fileName}` })[0]);

  it('החזרה לטיפול והסרה מוצעות על מסמך בארכיון', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({ archive: true });
    await screen.findAllByText(ARCHIVED);
    await openMenuFor(ARCHIVED);
    expect(screen.getByText('החזרה לטיפול')).toBeInTheDocument();
    expect(screen.getByText('הסרה')).toBeInTheDocument();
  });

  // The control that makes the assertion above mean something: the same row shape in the folder
  // does NOT get them, so `archive` is the only thing that can account for the difference.
  it('אינן מוצעות על מסמך לא משויך בתיקייה', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({});
    await screen.findAllByText(UNFILED);
    await openMenuFor(UNFILED);
    expect(screen.queryByText('החזרה לטיפול')).not.toBeInTheDocument();
    expect(screen.queryByText('הסרה')).not.toBeInTheDocument();
  });

  // A reason is required because of WHICH ACTION was chosen, not because of a prop: rescue opens
  // a dialog with the reason field, removal opens one without it. If these two ever converged on
  // a shared modal, this pair is what fails.
  it('החזרה לטיפול פותחת דיאלוג עם שדה סיבה, והסרה בלעדיו', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({ archive: true });
    await screen.findAllByText(ARCHIVED);

    await openMenuFor(ARCHIVED);
    await userEvent.click(screen.getByText('החזרה לטיפול'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('החזרת מסמך לטיפול');
    expect(screen.getByLabelText(/סיבה/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ביטול' }));

    await openMenuFor(ARCHIVED);
    await userEvent.click(screen.getByText('הסרה'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('הסרת מסמך מהארכיון');
    expect(screen.queryByLabelText(/סיבה/)).not.toBeInTheDocument();
    // The file survives, and the dialog says so rather than letting "הסרה" read as destruction.
    expect(screen.getByText(/הקובץ נשמר לביקורת/)).toBeInTheDocument();
  });
});

// isUnfiled() reads every archived row as "לא משויך" — a false statement about a document that was
// decided to have no target. Rather than teach it a third state and reopen decision #45, the
// archive drops the column and its filter. (OPEN-DECISIONS #111.)
describe('עמודת התיוק אינה נשאלת בארכיון', () => {
  it('הארכיון אינו מציג תווית תיוק ואינו מציג את מסנן התיוק', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({ archive: true });
    await screen.findAllByText(ARCHIVED);
    expect(screen.queryAllByText('לא משויך')).toHaveLength(0);
    expect(screen.queryByLabelText('סטטוס תיוק')).not.toBeInTheDocument();
  });

  it('תיקיית המסמכים כן מציגה את שניהם', async () => {
    server.use(documents, ...quietTraffic);
    renderGallery({});
    await screen.findAllByText(UNFILED);
    expect(screen.queryAllByText('לא משויך')).not.toHaveLength(0);
    expect(screen.getByLabelText('סטטוס תיוק')).toBeInTheDocument();
  });
});
