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
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

/**
 * Task C5, browser half — and this file is the first place in `src/` where the browser says what
 * the automation did.
 *
 * The owner granted a language model permission to CREATE financial records above a confidence
 * threshold. That permission was grantable because it is reversible; a machine-authored invoice
 * with no way back is a trap. But reversibility is only half of supervision: a user who cannot
 * tell a machine-authored invoice from one their colleague typed cannot supervise anything, so
 * the row has to NAME the author and the confidence before it offers to undo it.
 *
 * What is pinned here, and why each one is a product claim rather than a rendering detail:
 *
 *   * the action appears only where an auto-action EXISTS — not merely where a document is filed.
 *     "This row has an invoice" and "a machine wrote that invoice" are different facts, and only
 *     the second is undone here. A colleague's invoice is undone from the invoice screen.
 *   * the action appears only for owner/office, mirroring the server's gate — the three comparable
 *     reversals in this codebase all use it.
 *   * the row says the invoice was machine-written, from this document, at this confidence.
 *   * the dialog will not submit an empty reason. The server refuses one by name regardless; this
 *     asserts the browser does not offer the button that would earn that refusal.
 */
const ROLE = { current: 'owner' as 'owner' | 'office' | 'accountant' };

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
    profile: { role: ROLE.current, full_name: 'בודק', org_id: 'org-1' },
    // The organisation states the currency it keeps its own books in (0217). Every screen
    // reads it for DISPLAY ORDER and for which currency a single-figure tile is about; it is
    // never a conversion target.
    org: { settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
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

const MACHINE = 'חשבונית-אוטומטית.pdf';
// The control. Same shape, same entity_type, same filed-ness — a person typed this invoice and
// filed the document to it by hand. If the reversal offered itself here too, "filed" and
// "machine-written" would have been conflated, which is the exact confusion this screen exists
// to remove.
const HUMAN = 'חשבונית-של-עמית.pdf';
const DOCS = [
  row('d-auto', MACHINE, 'invoice', 'inv-auto'),
  row('d-human', HUMAN, 'invoice', 'inv-human'),
];

const AUTO_ACTION = {
  id: 'act-1',
  document_id: 'd-auto',
  invoice_id: 'inv-auto',
  decision: { decision_confidence: 0.97, model: 'fixture-model' },
};

const rpcCalls: Array<Record<string, unknown>> = [];

const traffic = (autoActions: unknown[] = [AUTO_ACTION]) => [
  http.get(`${SUPABASE_URL}/rest/v1/documents`, () => HttpResponse.json(DOCS)),
  http.get(`${SUPABASE_URL}/rest/v1/suppliers`, () => HttpResponse.json([])),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_document_processing_statuses`, () => HttpResponse.json([])),
  http.get(`${SUPABASE_URL}/rest/v1/document_auto_actions`, () => HttpResponse.json(autoActions)),
  http.post(`${SUPABASE_URL}/rest/v1/rpc/revert_document_auto_action`, async ({ request }) => {
    rpcCalls.push(await request.json() as Record<string, unknown>);
    return HttpResponse.json({ auto_action_id: 'act-1', invoice_deleted: true });
  }),
];

function renderGallery(locale: 'he' | 'en' = 'he') {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <LocaleProvider initialLocale={locale}>
      <QueryClientProvider client={createAppQueryClient()}>
        <OrgScopeProvider org="org-1">
          <ToastProvider>
            <MemoryRouter>{children}</MemoryRouter>
          </ToastProvider>
        </OrgScopeProvider>
      </QueryClientProvider>
    </LocaleProvider>
  );
  render(<DocumentsGallery />, { wrapper: Wrapper });
}

// findAllByText, not findByText: DataTable renders the mobile card list and the desktop table into
// the same DOM and lets CSS choose, so every row legitimately appears twice in jsdom.
const openMenuFor = async (fileName: string) =>
  userEvent.click(screen.getAllByRole('button', { name: `פעולות עבור מסמך ${fileName}` })[0]);

describe('מה השורה אומרת על מסמך ששויך אוטומטית', () => {
  it('משנה את מעטפת האוטומציה לאנגלית ושומר את שם קובץ המקור', async () => {
    ROLE.current = 'owner';
    server.use(...traffic([{ ...AUTO_ACTION, decision: { decision_confidence: null } }]));
    renderGallery('en');

    expect(await screen.findAllByText('Assigned automatically')).not.toHaveLength(0);
    expect(screen.getAllByText(/at unknown confidence/)).not.toHaveLength(0);
    expect(screen.getAllByText(MACHINE)).not.toHaveLength(0);
  });

  it('אומרת שהחשבונית נוצרה על ידי המערכת, ברמת הביטחון שבה פעלה', async () => {
    ROLE.current = 'owner';
    server.use(...traffic());
    renderGallery();
    expect(await screen.findAllByText('שויך אוטומטית')).not.toHaveLength(0);
    // The confidence is a sentence a person can read, not a raw 0.97 — and it is a SIBLING of the
    // badge rather than a title attribute, because a tooltip does not exist on touch.
    expect(screen.getAllByText(/ברמת ביטחון 97%/)).not.toHaveLength(0);
    expect(screen.getAllByText(/ללא אישור אדם/)).not.toHaveLength(0);
  });

  // The control, and the assertion that makes the one above mean something: the colleague's
  // invoice reads exactly as it always did.
  it('מסמך ששויך ביד מציין את היעד ואינו נטען כאוטומטי', async () => {
    ROLE.current = 'owner';
    server.use(...traffic());
    renderGallery();
    // Waiting on the MACHINE badge, not on the file name: the documents and the autonomy ledger
    // are two queries, and the rows render before the second answers. Asserting the absence of a
    // badge that has not loaded yet would pass against a screen that never labels anything.
    const machineBadges = await screen.findAllByText('שויך אוטומטית');
    const humanBadges = screen.getAllByText('שויך לחשבונית');
    // Both rows are filed to an invoice and differ in nothing else, so the counts being EQUAL and
    // non-zero is the claim: exactly one of the two is labelled machine-written. (Each badge
    // renders once per surface — desktop table and mobile card — which is why this compares the
    // two counts rather than pinning either to a literal.)
    expect(humanBadges.length).toBeGreaterThan(0);
    expect(machineBadges).toHaveLength(humanBadges.length);
  });

  // A confidence the decision record does not carry is UNKNOWN and says so. Never 0% — "the system
  // was 0% sure and created this invoice anyway" is a sentence about the software that is not true,
  // and the constitution's rule about dashes instead of zeros applies hardest here.
  it('ביטחון שאינו ידוע מוצג כ"לא ידועה", לא כאפס', async () => {
    ROLE.current = 'owner';
    server.use(...traffic([{ ...AUTO_ACTION, decision: { decision_confidence: null } }]));
    renderGallery();
    await screen.findAllByText('שויך אוטומטית');
    expect(screen.getAllByText(/ברמת ביטחון לא ידועה/)).not.toHaveLength(0);
    expect(screen.queryAllByText(/ברמת ביטחון 0%/)).toHaveLength(0);
  });
});

describe('פעולת ביטול השיוך האוטומטי', () => {
  it('מוצעת על מסמך ששויך אוטומטית', async () => {
    ROLE.current = 'owner';
    server.use(...traffic());
    renderGallery();
    await screen.findAllByText('שויך אוטומטית');
    await openMenuFor(MACHINE);
    expect(screen.getByText('ביטול השיוך האוטומטי')).toBeInTheDocument();
  });

  it('אינה מוצעת על מסמך שאדם שייך — "משויך" אינו "נכתב על ידי מכונה"', async () => {
    ROLE.current = 'owner';
    server.use(...traffic());
    renderGallery();
    await screen.findAllByText(HUMAN);
    await openMenuFor(HUMAN);
    expect(screen.queryByText('ביטול השיוך האוטומטי')).not.toBeInTheDocument();
  });

  it('אינה מוצעת ל-accountant — אותה סמכות שהשרת אוכף', async () => {
    ROLE.current = 'accountant';
    server.use(...traffic());
    renderGallery();
    await screen.findAllByText('שויך אוטומטית');
    await openMenuFor(MACHINE);
    expect(screen.queryByText('ביטול השיוך האוטומטי')).not.toBeInTheDocument();
  });

  it('מוצעת ל-office', async () => {
    ROLE.current = 'office';
    server.use(...traffic());
    renderGallery();
    await screen.findAllByText('שויך אוטומטית');
    await openMenuFor(MACHINE);
    expect(screen.getByText('ביטול השיוך האוטומטי')).toBeInTheDocument();
  });
});

describe('הדיאלוג של ביטול השיוך', () => {
  it('לא נשלח בלי סיבה, ונשלח עם סיבה', async () => {
    ROLE.current = 'owner';
    rpcCalls.length = 0;
    server.use(...traffic());
    renderGallery();
    await screen.findAllByText('שויך אוטומטית');
    await openMenuFor(MACHINE);
    await userEvent.click(screen.getByText('ביטול השיוך האוטומטי'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('ביטול השיוך האוטומטי');
    // All four things the person needs before undoing a financial record: what the machine did, at
    // what confidence, what the undo changes, and what survives it.
    expect(dialog).toHaveTextContent(/ברמת ביטחון 97%/);
    expect(dialog).toHaveTextContent(/הרשומה נשמרת לביקורת/);
    expect(dialog).toHaveTextContent(/לא מפני שהפער נבדק/);
    expect(dialog).toHaveTextContent(/רישום היצירה ורישום הביטול נשמרים שניהם/);

    const confirm = screen.getByRole('button', { name: 'ביטול השיוך' });
    // The reason stopped gating the button on 11.08.2026 (owner: nobody reads these notes). What
    // did NOT change is that the ledger gets a sentence -- whitespace still never reaches the
    // server, it is replaced by one naming the action.
    expect(confirm).toBeEnabled();
    await userEvent.type(screen.getByLabelText(/סיבה/), '   ');
    expect(confirm).toBeEnabled();
    expect(rpcCalls).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText(/סיבה/));
    await userEvent.type(screen.getByLabelText(/סיבה/), 'הספק לא סיפק את הפריט');
    await userEvent.click(confirm);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toEqual({ p_action_id: 'act-1', p_reason: 'הספק לא סיפק את הפריט' });
  });

  it('שולח משפט ליומן גם כשלא נכתבה סיבה', async () => {
    // The half of the owner's ruling that is invisible on screen: an empty box must not become an
    // empty p_reason. Roughly fifty server commands refuse that by name, and an audit line reading
    // "" explains nothing to whoever opens it a year later.
    ROLE.current = 'owner';
    rpcCalls.length = 0;
    server.use(...traffic());
    renderGallery();
    await screen.findAllByText('שויך אוטומטית');
    await openMenuFor(MACHINE);
    await userEvent.click(screen.getByText('ביטול השיוך האוטומטי'));
    await screen.findByRole('dialog');

    await userEvent.click(screen.getByRole('button', { name: 'ביטול השיוך' }));

    expect(rpcCalls).toHaveLength(1);
    expect(String(rpcCalls[0].p_reason)).toContain('ללא הערה');
    expect(String(rpcCalls[0].p_reason).length).toBeGreaterThan(0);
  });
});
