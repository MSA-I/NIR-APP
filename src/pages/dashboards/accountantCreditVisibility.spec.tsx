/**
 * `ASSIST-12` — the accountant's control room printed `זיכויים פתוחים 0` over a credits
 * population that was real, worth ₪3,423.20 across nine records, and simply not visible to that
 * role.
 *
 * WHY IT IS NOT VISIBLE, read in the tree rather than assumed: `credit_requests` carries a
 * restrictive rider (`0073:208-240`) under which a row appears only when its anchor does — the
 * invoice for an invoice-anchored credit, the receipt's order for a receipt-anchored one. The
 * accountant's `invoices` scope stops at approved, and purchase orders are outside their scope
 * entirely, so a whole tenant's credits can come back as an empty array with no error and no
 * signal. `fmtNum(0)` then prints a confident zero on top of it.
 *
 * THE ORACLE, and it is the constitution's own sentence: a metric with no data shows `—`, never
 * `0`, because zero is itself a claim about reality. The distinction this file pins is the one
 * that makes that rule usable here:
 *
 *   NO CREDIT ROW AT ALL   the role's read returned nothing, which is indistinguishable from
 *                          "there are none" — so the screen says it cannot measure, and names
 *                          why. This is the same choice `getDashboardSnapshot.ts:40-48` already
 *                          makes for office and the bank figures: "office receives a named
 *                          not_permitted failure instead of a false zero".
 *   ROWS BUT NONE OPEN     a measured zero, and it stays a zero. Hiding it would be the mirror
 *                          mistake, and the constitution forbids that one too.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../../test/msw/server';
import { SUPABASE_URL } from '../../test/msw/handlers';
import { createAppQueryClient } from '../../lib/query/client';
import { OrgScopeProvider } from '../../lib/query/orgScope';
import { ToastProvider } from '../../components/ui';

vi.mock('../../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'u-2', role: 'accountant', full_name: 'רו״ח', org_id: 'org-1' },
    org: { settings: {}, base_currency: 'ILS' },
    session: {},
    organizationAccess: { mode: 'active', canWrite: true },
  }),
}));

import AccountantDashboard from './AccountantDashboard';

beforeAll(() => {
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (typeof window.IntersectionObserver !== 'function') {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [];
    } as unknown as typeof window.IntersectionObserver;
  }
});

type CreditRow = { amount: number; currency: string; status: string };

function renderWithCredits(credits: CreditRow[]) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/credit_requests`, () => HttpResponse.json(credits)),
    http.get(`${SUPABASE_URL}/rest/v1/:table`, () => HttpResponse.json([])),
  );
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider><MemoryRouter>{children}</MemoryRouter></ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>
  );
  render(<AccountantDashboard />, { wrapper: Wrapper });
}

/** The KPI tile is a label and a value; read the value that belongs to THIS label. */
function creditsTileValue(): string {
  const label = [...document.querySelectorAll<HTMLElement>('*')]
    .filter((el) => /זיכויים/.test(el.textContent ?? '') && el.children.length === 0)
    .at(0);
  expect(label, 'the credits KPI label is on screen').toBeDefined();
  return (label!.parentElement?.textContent ?? '').replace(label!.textContent ?? '', '').trim();
}

describe('ASSIST-12 — אפס שקרי בזיכויים של רואה החשבון', () => {
  it('קריאה שחזרה ריקה אינה נכתבת כ-0 אלא כ"לא נמדד"', async () => {
    renderWithCredits([]);
    await screen.findByText('מרכז הבקרה — הנהלת חשבונות');

    // The whole point: nothing came back, so nothing is known. `0` here is the sentence
    // "this organisation has no open credits", which the accountant's read cannot support.
    expect(creditsTileValue()).toContain('—');
    expect(creditsTileValue()).not.toMatch(/(^|\s)0(\s|$)/);
  });

  it('שורות שנקראו ואף אחת אינה פתוחה — אפס מדוד, ונשאר אפס', async () => {
    renderWithCredits([{ amount: 50, currency: 'ILS', status: 'offset' }]);
    await screen.findByText('מרכז הבקרה — הנהלת חשבונות');

    // The mirror mistake. A row was read and it is closed; "0 open" is a measurement, and
    // replacing it with an em dash would hide a real all-clear.
    expect(creditsTileValue()).toContain('0');
    expect(creditsTileValue()).not.toContain('—');
  });

  it('הריק אומר גם למה — היקף הקריאה, לא תקלה', async () => {
    renderWithCredits([]);
    await screen.findByText('מרכז הבקרה — הנהלת חשבונות');
    // An unexplained dash reads as a bug. The reason belongs beside it, the way the assistant
    // names its refusal instead of returning an empty answer. BOTH surfaces that would otherwise
    // have printed the zero carry it — the KPI tile and the attention row — which is why this is
    // `findAllByText`: one of them saying it and the other going quiet is half a fix.
    expect(await screen.findAllByText(/היקף הקריאה של רואה החשבון/)).toHaveLength(2);
  });
});
