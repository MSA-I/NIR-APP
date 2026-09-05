/**
 * ASSIST-09 — three answers to "did a supplier raise prices?" inside fifteen minutes.
 *
 * 01:50 `get_business_summary` returned `ספקים שהעלו מחיר ב-30 הימים האחרונים = 0`, a MEASURED
 * zero. 01:51 `get_monthly_price_rises` returned both of its counts as NULL and the answer said
 * the metric itself came back unmeasured, so no list of suppliers could be shown and it could not
 * be established that there were no rises. Sixty seconds apart, one tool said "positively none"
 * and the other said "cannot be determined" about the same underlying question.
 *
 * THE CAUSE IS THE CARRIER, NOT THE MEASUREMENT. `supplier_monthly_price_rises()` computes
 * `measured_rise_rows` and `unmeasurable_rows` as window counts over its whole reported set
 * (`0203:209-210`, `count(*) filter (…) over ()`), so every returned ROW carries the totals. The
 * tool read them as `rows[0]?.measured_rise_rows ?? null`. An empty result set — which is what "no
 * supplier raised a price this month, and no product was unmeasurable" LOOKS like coming out of
 * that function — has no row to carry them, so both totals collapsed to `null` and the tool
 * reported a measured zero as an absent measurement.
 *
 * THE MIRROR MISTAKE IS GUARDED, and it is the reason this cannot be "return 0 when the array is
 * empty" without a second control: an RPC that FAILED also produces no rows, and that really is
 * unmeasured. The failure branch returns before this code and the control below asserts it, so
 * the fix distinguishes "the month was measured and held nothing" from "the month was not read".
 */
import { describe, expect, it } from 'vitest';
import { getMonthlyPriceRises } from '../../../supabase/functions/assistant/tools/getMonthlyPriceRises.ts';
import {
  RunEvidence,
  type ToolContext,
} from '../../../supabase/functions/assistant/tools/registry.ts';
import { he } from '../i18n/dictionaries/he';

const RISEN = he.assistantTools.priceRisenProducts;
const UNMEASURABLE = he.assistantTools.priceUnmeasurableProducts;

/** A context whose only database is the one answer this test is about. */
function context(answer: { data: unknown; error: { message: string } | null }): ToolContext {
  return {
    db: {
      rpc: () => Promise.resolve(answer),
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
    now: () => new Date('2026-09-04T01:51:00Z'),
    locale: 'he',
  } as unknown as ToolContext;
}

const factNamed = (facts: readonly { label: string; value: number | string | null }[], label: string) =>
  facts.find((fact) => fact.label === label);

/** One product of one supplier, risen — the shape a non-empty month comes back in. */
const oneRise = [{
  supplier_id: 's-1', supplier_name: 'חוות השדה',
  product_id: 'p-1', product_name: 'מלפפון',
  measurable: true, unmeasurable_reason: null,
  baseline_price: 10, baseline_source: 'price_list', baseline_as_of: '2026-09-01',
  current_price: 12, current_as_of: '2026-09-03',
  delta_amount: 2, delta_percent: 20,
  supplier_rise_count: 1, supplier_rise_total: 2, supplier_unmeasurable_count: 0,
  measured_rise_rows: 1, unmeasurable_rows: 0,
  month_start: '2026-09-01', month_end: '2026-09-30', time_zone: 'Asia/Jerusalem',
}];

describe('ASSIST-09 — a month that was read and held nothing is a zero, not an absence', () => {
  it('counts a month with no rise as a measured zero', async () => {
    const envelope = await getMonthlyPriceRises.run(context({ data: [], error: null }), { limit: 20 });
    expect(factNamed(envelope.facts, RISEN)?.value).toBe(0);
  });

  it('counts the unmeasurable products of that same month as a measured zero too', async () => {
    const envelope = await getMonthlyPriceRises.run(context({ data: [], error: null }), { limit: 20 });
    expect(factNamed(envelope.facts, UNMEASURABLE)?.value).toBe(0);
  });

  /**
   * The half that must NOT move, green in BOTH runs: when the server DID return rows, its own
   * window counts are relayed unchanged. A fix that always answered 0 would break this.
   */
  it('still relays the server’s own counts when the month held a rise', async () => {
    const envelope = await getMonthlyPriceRises.run(context({ data: oneRise, error: null }), { limit: 20 });
    expect(factNamed(envelope.facts, RISEN)?.value).toBe(1);
    expect(factNamed(envelope.facts, UNMEASURABLE)?.value).toBe(0);
  });

  /**
   * The mirror mistake, green in BOTH runs: a read that FAILED also returns no rows, and that is
   * genuinely unmeasured. It must stay a named failure with no counted fact behind it — a zero
   * here would be the same defect this fix removes, pointing the other way.
   */
  it('does not turn a failed read into a zero', async () => {
    const envelope = await getMonthlyPriceRises.run(
      context({ data: null, error: { message: 'connection reset' } }),
      { limit: 20 },
    );
    expect(envelope.complete).toBe(false);
    expect(envelope.failures.length).toBeGreaterThan(0);
    expect(factNamed(envelope.facts, RISEN)).toBeUndefined();
  });
});
