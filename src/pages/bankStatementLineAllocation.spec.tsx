/**
 * `MON-04` — the read surface. `/bank` opened a MATCHED statement line and said nothing at all
 * about what that line is spoken for: the dialog printed the line's own amount and went straight
 * to the un-match button. A line carrying two confirmed allocations of its whole amount looked
 * exactly like a line carrying one.
 *
 * `0322` stops a NEW over-allocation from being written. It cannot un-write one that is already
 * there — a row written before it, or by a migration or a repair script — and correcting the pair
 * production holds is an owner decision about which allocation is real, not a code change. So the
 * screen has to be able to SAY it, which is what this file measures.
 *
 * CONFIRMED ROWS ONLY, and the second case is why. Production's 2,950.00 line carries a confirmed
 * match of 2,950.00 beside a leftover SUGGESTION of 2,950.00 written by the demo seed — measured
 * 05.09.2026, and not the "two confirmed allocations" the finding describes. A suggestion claims
 * no money; a screen that counted it would report an over-allocation on every ordinary suggested
 * line, and the alarm would mean nothing by the second week.
 *
 * THE THIRD CASE IS THE CONSTITUTION'S RULE, not decoration: a metric with no data shows `—` and
 * never `0`. A failed read printing "0.00 allocated" would be the screen inventing the most
 * reassuring possible answer out of an error.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { server } from '../test/msw/server';
import { SUPABASE_URL } from '../test/msw/handlers';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import { ToastProvider } from '../components/ui';
import { fmtMoneyExact } from '../lib/format';
import { he } from '../lib/i18n/dictionaries/he';
import { en } from '../lib/i18n/dictionaries/en';
import { toErrorKey } from '../lib/errors';
import type { BankTransaction } from '../lib/types';

vi.mock('../lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  const { SUPABASE_URL: url } = await import('../test/msw/handlers');
  return {
    supabase: createClient(url, 'test-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }),
  };
});

import { UnmatchModal } from './Bank';

/** he-IL joins the figure to ₪ with a NBSP; the DOM queries collapse it, so expectations must too. */
const money = (value: number) => fmtMoneyExact(value, 'ILS').replace(/\s+/g, ' ');
const flat = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ');

const LINE = {
  id: 'tx-2950', org_id: 'org-test', import_id: 'imp-1', tx_date: '2026-07-14',
  description: 'העברה לדגי הים התיכון', amount: 2950, currency: 'ILS', is_debit: true,
  reference: '782044', raw: {}, supplier_id: 'sup-1', status: 'matched', row_hash: 'r-782044',
  supplier: { name: 'דגי הים התיכון' },
} as unknown as Omit<BankTransaction, 'supplier'> & { supplier: { name: string } | null };

/** PostgREST is asked for `confirmed=eq.true`; the fixture answers what that filter would return. */
function allocationsReturn(rows: Array<{ id: string; amount: number }>) {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/bank_allocations`, () =>
      HttpResponse.json(rows.map((row) => ({ ...row, currency: 'ILS' })))),
  );
}

function allocationsFail() {
  server.use(
    http.get(`${SUPABASE_URL}/rest/v1/bank_allocations`, () =>
      HttpResponse.json(
        { message: 'the allocations could not be read', code: '57014', details: null, hint: null },
        { status: 500 },
      )),
  );
}

function renderDialog(client = createAppQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <OrgScopeProvider org="org-test">
        <ToastProvider>
          <UnmatchModal tx={LINE} onClose={() => {}} onChanged={() => {}} />
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
}

/** The product retries a failed read twice (`client.ts`); the failure case does not need to wait
    out that backoff to prove what it is about. Only the retry count is changed. */
function clientWithoutRetries() {
  const client = createAppQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, retry: false },
  });
  return client;
}

/**
 * The ALLOCATED row on its own, not the whole dialog.
 *
 * A dialog-wide `toContain` would pass for the wrong reason on three of the four cases below: the
 * line's own amount of 2,950.00 is already printed at the top of this panel, and an em dash
 * already appears in the reason label ("סיבה (רשות — …)"). Reading the row the figure belongs to
 * is what makes each assertion about the allocation and not about the neighbourhood.
 */
async function allocatedRow(): Promise<string> {
  const label = await screen.findByText(flat(he.bank.allocatedLabel));
  return flat(label.parentElement?.textContent);
}

describe('/bank — the un-match dialog states what the statement line is spoken for', () => {
  it('names the over-allocation, and by how much, when two confirmed rows exceed the line', async () => {
    allocationsReturn([
      { id: 'alloc-seed', amount: 2950 },
      { id: 'alloc-match', amount: 2950 },
    ]);
    renderDialog();

    // The figure itself: 5,900.00 of allocation against a 2,950.00 line.
    await waitFor(async () => expect(await allocatedRow()).toContain(money(5900)));

    // And the sentence, worded from the dictionary rather than restated here, so a copy pass moves
    // one string instead of two. It is an alert because it is a discrepancy in money.
    const alert = await screen.findByRole('alert');
    expect(flat(alert.textContent)).toBe(flat(he.bank.overAllocated
      .replace('{claimed}', money(5900))
      .replace('{amount}', money(2950))
      .replace('{excess}', money(2950))));
  });

  it('says nothing alarming when the confirmed allocations add up to exactly the line', async () => {
    // 1,000 + 1,950 = 2,950 against a 2,950.00 line. Equal is not over: a split is the ordinary
    // way one transfer settles two invoices, and a screen that flagged it would be crying wolf.
    allocationsReturn([
      { id: 'alloc-a', amount: 1000 },
      { id: 'alloc-b', amount: 1950 },
    ]);
    renderDialog();

    await waitFor(async () => expect(await allocatedRow()).toContain(money(2950)));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('counts a confirmed match once when a suggestion of the same amount sits beside it', async () => {
    // Production's actual shape: one confirmed 2,950.00 and one unconfirmed 2,950.00 suggestion.
    // The read asks for `confirmed=eq.true`, so the suggestion is not in the answer and the line
    // reads as fully — not doubly — allocated.
    allocationsReturn([{ id: 'alloc-match', amount: 2950 }]);
    renderDialog();

    await waitFor(async () => expect(await allocatedRow()).toContain(money(2950)));
    expect(await allocatedRow()).not.toContain(money(5900));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an em dash rather than a reassuring zero when the allocations could not be read', async () => {
    allocationsFail();
    renderDialog(clientWithoutRetries());

    // The failure is stated, not swallowed: the reader is told the read failed rather than left
    // with a dash that could mean anything. `useQuery` resolves a raw Postgres string to a
    // sentence, so the sentence is what the dialog carries.
    await waitFor(async () => expect(flat((await screen.findByRole('dialog')).textContent))
      .toContain(flat(he.errors.fallback)));
    expect(await allocatedRow()).toContain('—');
    expect(await allocatedRow()).not.toContain(money(0));
  });
});

describe('the server refusal 0322 raises has a sentence of its own', () => {
  /**
   * `REQ-01` in this same sweep was a refusal falling through to a generic sentence that named a
   * cause which had not happened. `bank_allocation_exceeds_statement_line` sits next to
   * `allocation_exceeds_balance` in the pattern list, and that one talks about an invoice's open
   * balance — a number with nothing to do with a statement line being full.
   */
  it('maps to its own key and not to the invoice-balance sentence', () => {
    // `unwrap` re-throws a PostgrestError as `new Error(error.message)`, so this is the shape the
    // screen actually receives.
    expect(toErrorKey(new Error('bank_allocation_exceeds_statement_line')))
      .toBe('bank_allocation_exceeds_statement_line');
    // The control: its neighbour in the pattern list still resolves to itself, so the new entry
    // took a key rather than swallowing one.
    expect(toErrorKey(new Error('allocation_exceeds_balance'))).toBe('allocation_exceeds_balance');
  });

  it('carries a sentence in both dictionaries', () => {
    for (const dictionary of [he.errors, en.errors]) {
      const sentence = (dictionary as Record<string, string>).bank_allocation_exceeds_statement_line;
      expect(sentence).toBeTruthy();
      expect(sentence).not.toBe(dictionary.fallback);
      expect(sentence).not.toBe(dictionary.allocation_exceeds_balance);
    }
  });
});
