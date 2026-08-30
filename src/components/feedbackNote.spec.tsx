/**
 * Package 0 — the design partner's note reaches the vendor, or the screen says it did not.
 *
 * What is pinned here, at the wire level (real supabase-js against MSW):
 *   1. The insert carries the context that makes a note actionable — the screen, the role and the
 *      viewport — and carries NO delivery columns. "נשלח" cannot originate in the browser, because
 *      the browser holds no grant on sent_at (0090); this asserts it does not even try.
 *   2. A failed send still leaves the note stored, and the message says exactly that. The one
 *      outcome this feature must never produce is a comfortable "נשלח" over a failed POST.
 *   3. A failed INSERT keeps the dialog open with the text intact. Losing what somebody took the
 *      trouble to type is the other failure it must never have.
 *   4. Every active product account sees the surface; an unavailable feature-flag read cannot
 *      make the screenshot channel disappear.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

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

/**
 * html2canvas, stubbed rather than run. jsdom paints nothing, so the real library would either
 * throw or return an empty canvas -- and either way the test would be measuring jsdom's renderer.
 * What these tests are about is the WIRE, and the stub keeps the one thing that matters to it: the
 * capture is awaited before the dialog opens (package L).
 */
vi.mock('../lib/screenshot', () => ({
  SCREENSHOT_MAX_BYTES: 4 * 1024 * 1024,
  captureViewport: vi.fn(async () => capturedShot),
}));
let capturedShot: {
  blob: Blob; previewUrl: string; bytes: number; checksum: string; width: number; height: number;
} | null = null;

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', org_id: 'org-1', role: 'office', full_name: 'מנהל רכש' },
  }),
}));

import FeedbackButton from './FeedbackButton';
import { ToastProvider } from './ui';

const ROUTE = '/receiving/7';

function renderButton(locale: 'he' | 'en' = 'he') {
  return render(
    <LocaleProvider initialLocale={locale}>
      <ToastProvider>
        <MemoryRouter initialEntries={[ROUTE]}>
          <FeedbackButton />
        </MemoryRouter>
      </ToastProvider>
    </LocaleProvider>,
  );
}

/** Captures every insert body so the assertions can speak about the wire, not the intent. */
function captureInsert(inserts: Record<string, unknown>[], status = 201) {
  return http.post(`${SUPABASE_URL}/rest/v1/feedback_notes`, async ({ request }) => {
    inserts.push((await request.json()) as Record<string, unknown>);
    if (status !== 201) {
      return HttpResponse.json(
        { message: 'permission denied for table feedback_notes', code: '42501' },
        { status },
      );
    }
    return HttpResponse.json({ id: 'note-1' }, { status: 201 });
  });
}

async function openAndSubmit(text: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'שליחת הערה' }));
  // findBy, not getBy: the click captures the viewport BEFORE it opens the dialog (package L), so
  // the dialog arrives one microtask later. That ordering is the feature, not a race.
  await user.type(await screen.findByLabelText('ההערה'), text);
  await user.click(screen.getByRole('button', { name: 'שליחה' }));
}

beforeEach(() => { capturedShot = null; });

describe('feedback note — the wire', () => {
  it('renders the flow in English and preserves the note text', async () => {
    const inserts: Record<string, unknown>[] = [];
    server.use(
      captureInsert(inserts),
      http.post(`${SUPABASE_URL}/functions/v1/send-feedback`, () => HttpResponse.json({ ok: true })),
    );
    renderButton('en');
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Send a note' }));
    await user.type(await screen.findByLabelText('Your note'), 'הטקסט שהמשתמש כתב');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText(/The note was sent/)).toBeInTheDocument();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].note).toBe('הטקסט שהמשתמש כתב');
  });

  it('sends the screen, the role and the viewport, and never a delivery column', async () => {
    const inserts: Record<string, unknown>[] = [];
    const sends: Record<string, unknown>[] = [];
    server.use(
      captureInsert(inserts),
      http.post(`${SUPABASE_URL}/functions/v1/send-feedback`, async ({ request }) => {
        sends.push((await request.json()) as Record<string, unknown>);
        return HttpResponse.json({ ok: true, sentAt: '2026-08-09T12:00:00.000Z' });
      }),
    );

    renderButton();
    await openAndSubmit('  הכפתור נעלם כשמסמנים פגום  ');

    await screen.findByText(/ההערה נשלחה/);
    expect(inserts).toHaveLength(1);
    const body = inserts[0];
    expect(body.note).toBe('הכפתור נעלם כשמסמנים פגום');
    expect(body.route).toBe(ROUTE);
    expect(body.role).toBe('office');
    expect(body.org_id).toBe('org-1');
    expect(body.user_id).toBe('user-1');
    expect(typeof body.viewport_width).toBe('number');
    // The honesty boundary, asserted rather than trusted.
    expect(body).not.toHaveProperty('sent_at');
    expect(body).not.toHaveProperty('send_error');

    // The function receives the id of the stored row, never the text. Since 0124 that id is
    // generated in the browser and travels IN the insert, because attaching a screenshot
    // afterwards would need an UPDATE grant on a table that is append-only by design.
    expect(String(body.id)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sends).toEqual([{ noteId: body.id }]);
  });

  it('a failed send still stores the note, and says so instead of claiming delivery', async () => {
    const inserts: Record<string, unknown>[] = [];
    server.use(
      captureInsert(inserts),
      http.post(`${SUPABASE_URL}/functions/v1/send-feedback`, () => HttpResponse.json(
        { error: { code: 'delivery_failed', message: 'ההערה נשמרה, אך השליחה נכשלה' } },
        { status: 502 },
      )),
    );

    renderButton();
    await openAndSubmit('התאריך מוצג כמקפים');

    await screen.findByText('ההערה נשמרה, אך השליחה נכשלה');
    expect(inserts).toHaveLength(1);
    expect(screen.queryByText(/ההערה נשלחה/)).toBeNull();
  });

  it('a failed insert keeps the dialog open with the text still in it', async () => {
    const inserts: Record<string, unknown>[] = [];
    server.use(captureInsert(inserts, 403));

    renderButton();
    await openAndSubmit('טקסט שאסור לאבד');

    // The dialog is still mounted and still holds what was typed.
    expect(await screen.findByLabelText('ההערה')).toHaveValue('טקסט שאסור לאבד');
    expect(screen.queryByText(/ההערה נשלחה/)).toBeNull();
  });

  it('renders for an active product account without depending on a feature flag', () => {
    renderButton();
    expect(screen.getByRole('button', { name: 'שליחת הערה' })).toBeVisible();
  });
});
