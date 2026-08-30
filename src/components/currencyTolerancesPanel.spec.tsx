import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';

/** Real supabase-js against the MSW base URL, the `flags.spec.tsx` precedent. */
vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

import { CurrencyTolerancesPanel } from './CurrencyTolerancesPanel';
import type { Organization } from '../lib/types';

const wrap = (children: ReactNode) => (
  <QueryClientProvider client={createAppQueryClient()}>
    <OrgScopeProvider org="org-1">{children}</OrgScopeProvider>
  </QueryClientProvider>
);

const org = (settings: Record<string, unknown>): Organization => ({
  id: 'org-1',
  name: 'בדיקה',
  vat_rate: 18,
  base_currency: 'ILS',
  country_code: 'IL',
  status: 'active',
  logo_path: null,
  logo_updated_at: null,
  settings: settings as Organization['settings'],
});

/** The two reads the panel makes: the currency history (#292) and the ISO catalogue. */
function stubReads(inUse: { currency: string; sources: string[] }[]) {
  server.use(
    http.post(`${SUPABASE_URL}/rest/v1/rpc/currencies_in_use`, () => HttpResponse.json(inUse as never)),
    http.get(`${SUPABASE_URL}/rest/v1/currencies`, () =>
      HttpResponse.json([{ code: 'EUR' }, { code: 'ILS' }, { code: 'USD' }] as never)),
  );
}

/** Captures the PATCH body so the test can assert what the screen actually decided to store. */
function captureSave(): { body: () => Record<string, unknown> | null } {
  let seen: Record<string, unknown> | null = null;
  server.use(http.patch(`${SUPABASE_URL}/rest/v1/organizations`, async ({ request }) => {
    seen = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json([] as never);
  }));
  return { body: () => seen };
}

describe('the tolerance panel says which currencies still need a decision', () => {
  it('shows a field per key per currency, and marks the unstated ones', async () => {
    stubReads([
      { currency: 'ILS', sources: ['base_currency'] },
      { currency: 'USD', sources: ['invoice'] },
    ]);
    render(wrap(<CurrencyTolerancesPanel org={org({ bank_match_amount_tolerance: 1 })} canWrite />));

    // Four keys x two currencies. The three keys that had no screen at all are among them.
    await waitFor(() => expect(screen.getByLabelText('התאמת תנועת בנק (USD)')).toBeInTheDocument());
    expect(screen.getByLabelText('שורה בחשבונית (ILS)')).toBeInTheDocument();
    expect(screen.getByLabelText('סה״כ החשבונית (USD)')).toBeInTheDocument();
    expect(screen.getByLabelText('בקשת תשלום (ILS)')).toBeInTheDocument();

    // The legacy scalar answers for shekels and for nothing else, so only that box holds a value.
    expect(screen.getByLabelText('התאמת תנועת בנק (ILS)')).toHaveValue(1);
    expect(screen.getByLabelText('התאמת תנועת בנק (USD)')).toHaveValue(null);

    /* AND NOTHING DEMANDS TO BE FILLED IN (#294). An empty box is not a gap: the placeholder
       carries the threshold actually in force, derived from the currency's own units. Before this,
       the panel counted every empty field as "needs a decision" — so a brand-new shekel business
       was told three values were missing while the server was answering all three. */
    expect(screen.queryByText(/דורשים קביעה/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('התאמת תנועת בנק (USD)'))
      .toHaveAttribute('placeholder', expect.stringContaining('1.00'));
    expect(screen.getByLabelText('שורה בחשבונית (USD)'))
      .toHaveAttribute('placeholder', expect.stringContaining('0.05'));
  });

  it('never renders a currency belonging to nobody — an empty history still lists the books', async () => {
    stubReads([{ currency: 'ILS', sources: ['base_currency'] }]);
    render(wrap(<CurrencyTolerancesPanel org={org({})} canWrite />));
    await waitFor(() => expect(screen.getByLabelText('התאמת תנועת בנק (ILS)')).toBeInTheDocument());
    expect(screen.queryByLabelText('התאמת תנועת בנק (USD)')).not.toBeInTheDocument();
  });
});

describe('saving one currency does not touch another', () => {
  it('adds a dollar value and leaves the shekel one exactly where it was', async () => {
    stubReads([
      { currency: 'ILS', sources: ['base_currency'] },
      { currency: 'USD', sources: ['invoice'] },
    ]);
    const saved = captureSave();
    render(wrap(<CurrencyTolerancesPanel org={org({ bank_match_amount_tolerance: 1 })} canWrite />));

    await waitFor(() => expect(screen.getByLabelText('התאמת תנועת בנק (USD)')).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('התאמת תנועת בנק (USD)'), '0.3');
    await userEvent.click(screen.getByRole('button', { name: 'שמירת הסטיות' }));

    await waitFor(() => expect(saved.body()).not.toBeNull());
    const settings = saved.body()!.settings as Record<string, unknown>;
    expect(settings.bank_match_amount_tolerance).toEqual({ ILS: 1, USD: 0.3 });
  });

  it('carries through keys the panel does not edit', async () => {
    stubReads([{ currency: 'ILS', sources: ['base_currency'] }]);
    const saved = captureSave();
    render(wrap(<CurrencyTolerancesPanel
      org={org({ bank_match_amount_tolerance: 1, bank_match_days: 7, role_labels: { owner: 'בעלים' } })}
      canWrite
    />));

    await waitFor(() => expect(screen.getByLabelText('התאמת תנועת בנק (ILS)')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'שמירת הסטיות' }));

    await waitFor(() => expect(saved.body()).not.toBeNull());
    const settings = saved.body()!.settings as Record<string, unknown>;
    expect(settings.bank_match_days).toBe(7);
    expect(settings.role_labels).toEqual({ owner: 'בעלים' });
  });

  it('clears a field back to never-stated rather than to zero', async () => {
    stubReads([{ currency: 'ILS', sources: ['base_currency'] }]);
    const saved = captureSave();
    render(wrap(<CurrencyTolerancesPanel org={org({ bank_match_amount_tolerance: 1 })} canWrite />));

    await waitFor(() => expect(screen.getByLabelText('התאמת תנועת בנק (ILS)')).toBeInTheDocument());
    await userEvent.clear(screen.getByLabelText('התאמת תנועת בנק (ILS)'));
    await userEvent.click(screen.getByRole('button', { name: 'שמירת הסטיות' }));

    await waitFor(() => expect(saved.body()).not.toBeNull());
    const settings = saved.body()!.settings as Record<string, unknown>;
    // Absent, not 0. Zero would say "nothing may differ at all", which nobody asked for.
    expect(settings).not.toHaveProperty('bank_match_amount_tolerance');
  });
});

describe('a reader who cannot write', () => {
  it('shows the values and offers no way to change them', async () => {
    stubReads([{ currency: 'ILS', sources: ['base_currency'] }]);
    render(wrap(<CurrencyTolerancesPanel org={org({ bank_match_amount_tolerance: 1 })} canWrite={false} />));

    await waitFor(() => expect(screen.getByLabelText('התאמת תנועת בנק (ILS)')).toBeDisabled());
    expect(screen.queryByRole('button', { name: 'שמירת הסטיות' })).not.toBeInTheDocument();
  });
});
