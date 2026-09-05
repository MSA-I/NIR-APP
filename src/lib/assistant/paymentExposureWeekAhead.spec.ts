/**
 * ASSIST-07 — asked for the coming week's payment exposure the assistant answered 0, while the
 * dashboard tile answering the same question read 4,236.
 *
 * Every individual fact was correct. `get_payment_exposure` measured the overdue money (4,236 and
 * two requests) and the seven-day money (0 and none) and put both in the envelope; the model then
 * answered "the coming week" with the half whose label most literally matched, and the headline
 * read "nothing to worry about" over money that was already late.
 *
 * THE PRODUCT ALREADY HAS AN ANSWER TO THAT QUESTION AND THE TOOL DID NOT CARRY IT.
 * `Dashboard.tsx:1479` prints `overdueAmount + dueWithin7Amount` under the title "לתשלום בשבוע
 * הקרוב" and the subtitle "דרישות תשלום פעילות, כולל מה שכבר באיחור". The two buckets are disjoint
 * by construction — `0218:395-404` counts `due_date < p_today` as overdue and
 * `due_date between p_today and p_today + 6` as the week — so their sum is well defined, and
 * `/payment-requests?status=active&due=soon` is exactly that union on screen
 * (`PaymentRequests.tsx:69`, `due_date <= today + 6`). The tool emitted the two halves and never
 * the figure the product itself publishes, so the one claim that matches the screen could not be
 * made out of the facts on offer.
 *
 * THE SUM IS RELAYED, NOT INVENTED. It is the product's own composition, taken from the same
 * snapshot block, INSIDE one currency — a dollar exposure and a shekel exposure are two exposures
 * and the fixture below asserts that their total never appears anywhere.
 */
import { describe, expect, it } from 'vitest';
import { getPaymentExposure } from '../../../supabase/functions/assistant/tools/getPaymentExposure.ts';
import {
  RunEvidence,
  type ToolContext,
} from '../../../supabase/functions/assistant/tools/registry.ts';

/**
 * The measured state, with every figure distinct so no assertion can be satisfied by the wrong
 * one: overdue 4,236 ILS over two requests, another 500 ILS over one falling inside seven days,
 * and a dollar exposure beside them. The combined figures — 4,736 ILS, 120 USD, three requests —
 * appear nowhere in the input.
 */
const snapshot = {
  paymentRequests: {
    activeCount: 9,
    dueDateCoverage: 5,
    overdue: 2,
    dueToday: 0,
    dueWithin7Count: 1,
    pendingApproval: 4,
    overdueAmountByCurrency: [{ currency: 'ILS', amount: 4236 }, { currency: 'USD', amount: 100 }],
    dueWithin7AmountByCurrency: [{ currency: 'ILS', amount: 500 }, { currency: 'USD', amount: 20 }],
  },
};

/** No active request carries a due date at all: the snapshot's own "unknown", never zero. */
const undated = {
  paymentRequests: {
    activeCount: 6,
    dueDateCoverage: 0,
    overdue: null,
    dueToday: null,
    dueWithin7Count: null,
    pendingApproval: 2,
    overdueAmountByCurrency: null,
    dueWithin7AmountByCurrency: null,
  },
};

function context(data: unknown): ToolContext {
  return {
    db: {
      rpc: () => Promise.resolve({ data, error: null }),
      countSentOrders: () => Promise.resolve({ count: 0, error: null }),
    },
    actor: {
      userId: 'user-1',
      orgId: 'org-1',
      role: 'owner',
      scopes: [],
      canWrite: true,
      capabilities: { ui: true, history: true, drafts: false, actions: false },
    },
    evidence: new RunEvidence(),
    now: () => new Date('2026-09-04T01:57:00Z'),
    locale: 'he',
  } as unknown as ToolContext;
}

const run = (data: unknown) => getPaymentExposure.run(context(data), {});
const values = (facts: readonly { value: number | string | null; unit: string }[], unit: string) =>
  facts.filter((fact) => fact.unit === unit).map((fact) => fact.value);

describe('ASSIST-07 — the assistant can answer the week the way the screen answers it', () => {
  it('carries the shekel figure the dashboard tile prints for the same question', async () => {
    const envelope = await run(snapshot);
    expect(values(envelope.facts, 'ils')).toContain(4736);
  });

  it('carries the number of requests behind it', async () => {
    const envelope = await run(snapshot);
    expect(values(envelope.facts, 'count')).toContain(3);
  });

  /**
   * A second currency is a second exposure. Control that the composition stayed inside one:
   * the dollar total is stated, and the cross-currency sum exists nowhere.
   */
  it('composes inside one currency and never across two', async () => {
    const envelope = await run(snapshot);
    expect(values(envelope.facts, 'usd')).toContain(120);
    expect(envelope.facts.map((fact) => fact.value)).not.toContain(4856);
  });

  /**
   * Control, green in BOTH runs: the two halves are still separately citable. The answer must
   * still be able to say how much of the week's money is ALREADY late — that is the sentence the
   * dashboard prints under its own headline.
   */
  it('still states each half on its own', async () => {
    const envelope = await run(snapshot);
    expect(values(envelope.facts, 'ils')).toContain(4236);
    expect(values(envelope.facts, 'ils')).toContain(500);
  });

  /**
   * Control, green in BOTH runs: the screen that reproduces the union is cited. `?due=soon` is
   * `due_date <= today + 6`, which is exactly overdue ∪ the coming seven days.
   */
  it('cites the screen state that reproduces the union', async () => {
    const envelope = await run(snapshot);
    expect(envelope.sources.map((source) => source.route))
      .toContain('/payment-requests?status=active&due=soon');
  });

  /**
   * Control, green in BOTH runs, and it is the one that stops the fix from becoming a zero
   * factory: when no active request carries a due date the snapshot returns null, there is no
   * currency to state an exposure in, and the absence is NAMED. Nothing may be composed out of
   * two nulls.
   */
  it('states nothing at all when no dated request exists to measure', async () => {
    const envelope = await run(undated);
    expect(envelope.facts.filter((fact) => fact.kind === 'metric.money')).toEqual([]);
    expect(envelope.failures.length).toBeGreaterThanOrEqual(2);
  });
});
