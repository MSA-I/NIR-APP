/**
 * Package 2 — the pins that keep the 09.08.2026 decisions true after later edits.
 *
 * What is here is what breaks SILENTLY: the Hebrew label a new enum value renders under
 * (#116/§17 — without it /exceptions prints a raw enum token), and the #115 procurement
 * filter on the price-list supplier picker (a "tidying" edit that drops the .in() would
 * quietly re-open ordering-adjacent flows to inactive suppliers, and nothing else would
 * notice). The server halves — the damaged/returned credits and open_manual_exception
 * itself — are asserted in supabase/tests/p1_financial_commands.sql where they live.
 */
import { he } from '../lib/i18n/dictionaries/he';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';

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

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    profile: { id: 'user-1', role: 'owner', org_id: 'org-test', full_name: 'בודק' },
    org: { id: 'org-test', settings: {} },
    session: {},
    roleLabels: {},
  }),
}));

import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { EXCEPTION_TYPE } from '../lib/status';
import { ToastProvider } from '../components/ui';
import { PriceListUploadModal } from '../components/PriceListUpload';

describe('item_not_ordered speaks Hebrew on /exceptions (#116, §17 step 1)', () => {
  it('carries the label §17 planned, so the type column never prints a raw enum token', () => {
    expect(he.status[EXCEPTION_TYPE.item_not_ordered as keyof typeof he.status]).toBe('פריט שלא הוזמן');
  });
});

describe('price-list upload honours #115 — inactive means "do not order from anymore"', () => {
  it('asks the server for active/problematic suppliers only', async () => {
    const supplierQueries: URL[] = [];
    server.use(
      http.get(`${SUPABASE_URL}/rest/v1/suppliers`, ({ request }) => {
        supplierQueries.push(new URL(request.url));
        return HttpResponse.json([{ id: 'sup-1', name: 'ספק פעיל' }]);
      }),
    );

    render(
      <MemoryRouter>
        <QueryClientProvider client={createAppQueryClient()}>
          <OrgScopeProvider org="org-test">
            <ToastProvider>
              <PriceListUploadModal supplier={null} onClose={() => {}} onImported={() => {}} />
            </ToastProvider>
          </OrgScopeProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('option', { name: 'ספק פעיל' });
    expect(supplierQueries.length).toBeGreaterThan(0);
    for (const url of supplierQueries) {
      expect(url.searchParams.get('status')).toBe('in.(active,problematic)');
      expect(url.searchParams.get('deleted_at')).toBe('is.null');
    }
  });
});
