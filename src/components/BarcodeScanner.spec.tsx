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
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

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

import BarcodeScanControl, { matchScannedBarcode, type BarcodeCatalogueEntry } from './BarcodeScanner';

const entry = (over: Partial<BarcodeCatalogueEntry> & { productId: string }): BarcodeCatalogueEntry => ({
  orderItemId: `item-${over.productId}`,
  supplierSku: null,
  sku: null,
  barcode: null,
  name: `מוצר ${over.productId}`,
  ...over,
});

const wrap = (children: ReactNode, locale: 'he' | 'en' = 'he') => (
  <LocaleProvider initialLocale={locale}>
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">{children}</OrgScopeProvider>
    </QueryClientProvider>
  </LocaleProvider>
);

function resolveFlags(body: unknown, status = 200) {
  server.use(http.post(`${SUPABASE_URL}/rest/v1/rpc/resolve_feature_flags`, () =>
    HttpResponse.json(body as never, { status })));
}

describe('matchScannedBarcode — a key, never a guess', () => {
  const catalogue = [
    entry({ productId: 'p-cola', barcode: '7290000000902', name: 'קולה 1.5 ליטר (ארגז 6)' }),
    entry({ productId: 'p-water', barcode: '7290000000902', name: 'מים מינרליים (ארגז 12)' }),
    entry({ productId: 'p-tomato', barcode: '7290000000019', name: 'עגבניות' }),
  ];

  it('resolves a code that names exactly one product on this order', () => {
    const result = matchScannedBarcode('7290000000019', catalogue);
    expect(result).toEqual({
      kind: 'match', productId: 'p-tomato', orderItemId: 'item-p-tomato', name: 'עגבניות',
      code: '7290000000019',
    });
  });

  it('refuses to choose when two products answer the same code', () => {
    // The shared ambiguity rule (model.ts:358-363). The demo seed carries this exact pair so the
    // path is provable end to end, and `ambiguous` is reported apart from `none` because the two
    // are different facts about the catalogue.
    const result = matchScannedBarcode('7290000000902', catalogue);
    expect(result.kind).toBe('ambiguous');
    expect(result.kind === 'ambiguous' && result.candidates.map((candidate) => candidate.productId))
      .toEqual(['p-cola', 'p-water']);
  });

  it('names an unknown code rather than pre-selecting something plausible', () => {
    expect(matchScannedBarcode('9999999999999', catalogue)).toEqual({ kind: 'none', code: '9999999999999' });
    expect(matchScannedBarcode('   ', catalogue)).toEqual({ kind: 'none', code: '' });
  });

  it('ignores surrounding whitespace and letter case', () => {
    const result = matchScannedBarcode(' 7290000000019 ', catalogue);
    expect(result.kind).toBe('match');
  });

  it('matches nothing against a catalogue with no barcodes at all', () => {
    expect(matchScannedBarcode('7290000000019', [entry({ productId: 'p-1' })]).kind).toBe('none');
  });
});

describe('the flag boundary', () => {
  it('renders nothing at all while receiving.barcode is off', async () => {
    resolveFlags([{ flag_key: 'receiving.barcode', state: false }]);
    const { container } = render(wrap(<BarcodeScanControl entries={[]} onPick={() => {}} />));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByRole('button', { name: 'סריקת ברקוד' })).not.toBeInTheDocument();
  });

  it('renders nothing before the flags have resolved, and nothing if they fail', async () => {
    // Fail-closed (flags.ts:33-34): unknown, loading and errored all read as off, and off means no
    // scanner — not a disabled button, not an empty dialog.
    resolveFlags({ message: 'boom' }, 500);
    const { container } = render(wrap(<BarcodeScanControl entries={[]} onPick={() => {}} />));
    expect(container).toBeEmptyDOMElement();
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('offers the scanner once the flag is on', async () => {
    resolveFlags([{ flag_key: 'receiving.barcode', state: true }]);
    render(wrap(<BarcodeScanControl entries={[]} onPick={() => {}} />));
    await waitFor(() => expect(screen.getByRole('button', { name: 'סריקת ברקוד' })).toBeInTheDocument());
  });

  it('renders scanner state in English while preserving catalogue product data', async () => {
    resolveFlags([{ flag_key: 'receiving.barcode', state: true }]);
    const onPick = vi.fn();
    const product = entry({ productId: 'p-tomato', barcode: '12345', name: 'עגבניות' });
    render(wrap(<BarcodeScanControl entries={[product]} onPick={onPick} />, 'en'));
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Scan barcode' }));
    expect(await screen.findByText(/No camera is available/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Enter code manually'), '12345');
    await user.click(screen.getByRole('button', { name: 'Check code' }));

    expect(screen.getByText('Code 12345 identified עגבניות. You still enter the quantity.'))
      .toBeInTheDocument();
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'match', code: '12345', name: 'עגבניות',
    }));
  });
});
