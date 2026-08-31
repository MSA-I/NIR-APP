// The unread-alerts block on מרכז הבקרה.
//
// What is pinned here is the difference between what the block SAYS and what `read_at` can
// actually support. The plan's literal requirement was "what changed since your last visit", and
// `notifications.read_at` cannot answer that in either direction — so the heading is "unread
// alerts", the block never computes a visit, and it never renders a zero.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { UnreadAlerts } from './UnreadAlerts';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

const navigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigate };
});

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'n-1', org_id: 'org-1', user_id: 'u-1', event_code: 'invoice_duplicate',
    entity_key: 'inv-1', severity: 'warning', title: 'חשבונית כפולה · מאפיית לחם הארץ',
    body: 'אותו מספר חשבונית הופיע פעמיים', target_url: '/invoices/inv-1',
    created_at: '2026-08-30T09:00:00Z', read_at: null, ...over,
  };
}

function feed(rows: unknown[]) {
  return http.get(`${SUPABASE_URL}/rest/v1/notifications`, () => HttpResponse.json(rows));
}

function renderBlock(userId: string | null = 'u-1') {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <MemoryRouter>{children}</MemoryRouter>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  return render(<UnreadAlerts userId={userId} />, { wrapper: Wrapper });
}

beforeEach(() => { navigate.mockReset(); });

describe('UnreadAlerts', () => {
  it('lists a condition that is still unread', async () => {
    server.use(feed([row()]));
    renderBlock();
    expect(await screen.findByText('חשבונית כפולה · מאפיית לחם הארץ')).toBeInTheDocument();
    expect(screen.getByText('התראות שלא נקראו')).toBeInTheDocument();
  });

  /**
   * Zero unread renders NOTHING — not "0 unread".
   *
   * The attention zone directly above is this screen's answer to "what needs me". An empty block
   * announcing zero would be a second, competing answer, and the constitution's rule about a zero
   * being a claim about reality applies to the block's own existence as much as to its figures.
   */
  it('renders nothing at all when everything has been read', async () => {
    server.use(feed([row({ read_at: '2026-08-30T10:00:00Z' })]));
    const { container } = renderBlock();
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(screen.queryByText('התראות שלא נקראו')).toBeNull();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('renders nothing when the feed is empty', async () => {
    server.use(feed([]));
    const { container } = renderBlock();
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  /**
   * A failed read says nothing rather than "nothing is waiting" — the same reasoning
   * `useUnreadNotifications` gives for the bell. Silence here costs the reader nothing because the
   * attention zone above carries the load-bearing answer; a false all-clear would not.
   */
  it('says nothing when the feed fails, rather than claiming an empty inbox', async () => {
    server.use(http.get(`${SUPABASE_URL}/rest/v1/notifications`, () => HttpResponse.error()));
    const { container } = renderBlock();
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
    expect(screen.queryByText('התראות שלא נקראו')).toBeNull();
  });

  it('counts conditions, not rows — twenty repeats of one thing is one thing', async () => {
    server.use(feed([
      row({ id: 'a', created_at: '2026-08-30T09:00:00Z' }),
      row({ id: 'b', created_at: '2026-08-30T08:00:00Z' }),
      row({ id: 'c', created_at: '2026-08-30T07:00:00Z' }),
    ]));
    renderBlock();
    await screen.findByText('התראות שלא נקראו');
    // One grouped condition, and the repeat count is printed rather than hidden.
    expect(screen.getAllByText('חשבונית כפולה · מאפיית לחם הארץ')).toHaveLength(1);
    expect(await screen.findByText(/נשלחה 3 פעמים/)).toBeInTheDocument();
  });

  it('never claims "since your last visit" anywhere on screen', async () => {
    server.use(feed([row()]));
    const { container } = renderBlock();
    await screen.findByText('התראות שלא נקראו');
    expect(container.textContent ?? '').not.toMatch(/מאז הביקור|since your (last )?visit/i);
  });

  it('opens the notification target', async () => {
    const user = userEvent.setup();
    server.use(feed([row()]));
    renderBlock();
    await user.click(await screen.findByText('חשבונית כפולה · מאפיית לחם הארץ'));
    expect(navigate).toHaveBeenCalledWith('/invoices/inv-1');
  });

  it('asks for nothing when there is no signed-in profile yet', async () => {
    const { container } = renderBlock(null);
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });
});
