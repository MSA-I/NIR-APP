import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from './ui';

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

import { NotificationMatrix } from './PushSettings';

interface PreferenceRow {
  event_code: string;
  push_enabled: boolean;
  inapp_enabled: boolean;
  configured: boolean;
}

/** The reader's contract (migration 0068): one row per catalogued code, always the full set. */
const CATALOG = ['duplicate_invoice', 'payment_due', 'price_increase'];

const defaults = (): PreferenceRow[] => CATALOG.map((event_code) => ({
  event_code, push_enabled: true, inapp_enabled: true, configured: false,
}));

/**
 * A stand-in for 0068's pair of RPCs, with the server's own semantics: the reader always answers the
 * full catalogue, and the writer upserts one row and flips `configured`. Returns the recorded write
 * bodies so a test can assert how many rows were written, and which.
 */
function useNotificationRpcs(rows: PreferenceRow[] = defaults(), writeStatus = 200) {
  const state = [...rows];
  const writes: Array<Record<string, unknown>> = [];
  const reads = { calls: 0 };
  server.use(
    http.post(`${SUPABASE_URL}/rest/v1/rpc/read_notification_preferences`, () => {
      reads.calls += 1;
      return HttpResponse.json(state);
    }),
    http.post(`${SUPABASE_URL}/rest/v1/rpc/set_notification_preference`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      writes.push(body);
      if (writeStatus >= 400) {
        return HttpResponse.json(
          { message: 'notification_preference_not_authorized', code: '42501', details: null, hint: null },
          { status: writeStatus },
        );
      }
      const index = state.findIndex((row) => row.event_code === body.p_event_code);
      const next = {
        event_code: String(body.p_event_code),
        push_enabled: body.p_push_enabled === true,
        inapp_enabled: body.p_inapp_enabled === true,
        configured: true,
      };
      if (index >= 0) state[index] = next; else state.push(next);
      return HttpResponse.json({ preference_id: 'pref-1', created: index < 0, ...next });
    }),
  );
  return { writes, reads };
}

function renderMatrix() {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <NotificationMatrix />
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

const switchFor = (channel: string, event: string) => screen.getByRole('switch', { name: `${channel} — ${event}` });
const DUPLICATE = 'חשד לחשבונית כפולה';

describe('NotificationMatrix — per-event delivery preferences (migration 0068)', () => {
  it('renders an absent row as ON and writes nothing for merely being opened', async () => {
    const { writes } = useNotificationRpcs();
    renderMatrix();

    await waitFor(() => expect(screen.getByText(DUPLICATE)).toBeInTheDocument());
    // Opt-in is the default: both channels read "on" with no stored row behind them...
    expect(switchFor('התראה במערכת', DUPLICATE)).toHaveAttribute('aria-checked', 'true');
    expect(switchFor('דחיפה למכשיר', DUPLICATE)).toHaveAttribute('aria-checked', 'true');
    // ...and the screen says so, so "on" is not mistaken for a choice somebody made.
    expect(screen.getAllByText('ברירת המחדל — לא שינית כאן דבר')).toHaveLength(CATALOG.length);
    // The one that would make 0068 change an installation's behaviour by existing.
    expect(writes).toHaveLength(0);
  });

  it('writes exactly one row for one toggle, carrying the untouched channel unchanged', async () => {
    const user = userEvent.setup();
    const { writes } = useNotificationRpcs();
    renderMatrix();
    await waitFor(() => expect(screen.getByText(DUPLICATE)).toBeInTheDocument());

    await user.click(switchFor('דחיפה למכשיר', DUPLICATE));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      p_event_code: 'duplicate_invoice',
      p_push_enabled: false,
      // The in-app channel was not touched, so it travels exactly as displayed — not defaulted again.
      p_inapp_enabled: true,
    });
    // One toggle, one row: the other two catalogued codes stay unconfigured.
    await waitFor(() => expect(switchFor('דחיפה למכשיר', DUPLICATE)).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getAllByText('ברירת המחדל — לא שינית כאן דבר')).toHaveLength(CATALOG.length - 1);
    expect(writes).toHaveLength(1);
  });

  it('says that muting Push removes the device alert only and leaves the bell', async () => {
    useNotificationRpcs([
      { event_code: 'duplicate_invoice', push_enabled: false, inapp_enabled: true, configured: true },
      { event_code: 'payment_due', push_enabled: true, inapp_enabled: true, configured: false },
      { event_code: 'price_increase', push_enabled: true, inapp_enabled: true, configured: false },
    ]);
    renderMatrix();
    await waitFor(() => expect(screen.getByText(DUPLICATE)).toBeInTheDocument());

    // The delivery law of migration 0068: push_enabled = false removes Push and LEAVES the
    // notification row, because OPEN-DECISIONS #39's unread badge counts those rows.
    expect(screen.getByText('מופיעה בפעמון ובמסך ההתראות; לא נשלחת דחיפה למכשיר')).toBeInTheDocument();
    expect(screen.getByText(/כיבוי הדחיפה מסיר רק את ההתראה למכשיר/)).toBeInTheDocument();
  });

  it('says that muting the in-app notification takes Push with it', async () => {
    useNotificationRpcs([
      { event_code: 'duplicate_invoice', push_enabled: true, inapp_enabled: false, configured: true },
      { event_code: 'payment_due', push_enabled: true, inapp_enabled: true, configured: false },
      { event_code: 'price_increase', push_enabled: true, inapp_enabled: true, configured: false },
    ]);
    renderMatrix();

    // Push rides on the notification row, so removing the row removes Push — the copy must not let a
    // member believe the phone still buzzes.
    await waitFor(() => expect(
      screen.getByText('לא נרשמת בפעמון — ולכן גם לא נשלחת דחיפה למכשיר'),
    ).toBeInTheDocument());
  });

  it('reports a rejected write in Hebrew and leaves the switch where it was', async () => {
    const user = userEvent.setup();
    const { writes } = useNotificationRpcs(defaults(), 401);
    renderMatrix();
    await waitFor(() => expect(screen.getByText(DUPLICATE)).toBeInTheDocument());

    await user.click(switchFor('דחיפה למכשיר', DUPLICATE));

    await waitFor(() => expect(writes).toHaveLength(1));
    const toast = await screen.findByText('לא ניתן לעדכן את העדפות ההתראות כרגע. יש להתחבר מחדש ולנסות שוב.');
    expect(toast).toBeInTheDocument();
    // A refused write must not leave the UI claiming the mute happened.
    expect(switchFor('דחיפה למכשיר', DUPLICATE)).toHaveAttribute('aria-checked', 'true');
  });

  /**
   * The phone layout (owner review, 428px): the row used to be one `flex-wrap` container holding a
   * `flex-1` text block and ~300px of switches, and at that width it came apart. The fix is
   * structural — the switches own a one-column grid that stacks them full-width below `sm` — so the
   * assertion is structural too. jsdom has no layout engine; a pixel expectation here would be a
   * claim this file cannot make.
   */
  it('keeps the two switches in their own grid, a sibling of the label rather than its ancestor', async () => {
    useNotificationRpcs();
    renderMatrix();
    await waitFor(() => expect(screen.getByText(DUPLICATE)).toBeInTheDocument());

    const group = switchFor('התראה במערכת', DUPLICATE).parentElement;
    // Both switches hang off one container...
    expect(switchFor('דחיפה למכשיר', DUPLICATE).parentElement).toBe(group);
    // ...that container is a grid, which is what gives each switch a full-width line on a phone...
    expect(group?.className).toContain('grid');

    // ...and it sits BESIDE the text, not around it: a label swallowed by the stretching control
    // would be the same collapse in a new shape.
    const label = screen.getByText(DUPLICATE);
    expect(group?.contains(label)).toBe(false);
    expect(group?.parentElement).toBe(label.parentElement?.parentElement);
  });
});
