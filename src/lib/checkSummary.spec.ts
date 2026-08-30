/**
 * What the one summary is allowed to claim.
 *
 * The payment-request modal used to state the same blocking finding three times — check row,
 * panel, toast — and the owner ruled on 19.08.2026 that it states it once. Folding three boxes
 * into one only helps if the one box is right, so the partition and the "what now" line are
 * pinned here, away from the modal: `critical` blocks and nothing else does, and an action is
 * either a step the product actually established or `null`.
 */

import { describe, expect, it } from 'vitest';
import { summarizeChecks } from './checkSummary';
import type { CheckResult } from './checks';
import { he } from './i18n/dictionaries/he';
import type { Dictionary } from './i18n/dictionaries/he';
import { translate, type TKey } from './i18n/t';

const say = (key: TKey) => translate(he as unknown as Dictionary, key);

const OVER_ALLOCATED: CheckResult = {
  code: 'allocation_vs_balance_one',
  severity: 'critical',
};

describe('summarizeChecks', () => {
  it('blocks on a critical check and names the step that clears it', () => {
    const summary = summarizeChecks([OVER_ALLOCATED]);

    expect(summary.blocking).toEqual([OVER_ALLOCATED]);
    expect(summary.warnings).toEqual([]);
    expect(summary.info).toEqual([]);
    expect(summary.actionKey).toBe('checks.actionAllocationVsBalance');
    expect(say(summary.actionKey!)).toBe('יש לבטל את הדרישה ולפתוח דרישה חדשה בסכום המעודכן');
  });

  it('sorts a warning and an info finding without blocking on either', () => {
    const warning: CheckResult = {
      code: 'payment_request_open_credit', severity: 'warning', amount: 250,
      vars: { total: '250 ₪' },
    };
    const info: CheckResult = {
      code: 'existing_pr', severity: 'info', vars: { numbers: '7' },
    };

    const summary = summarizeChecks([warning, info]);

    expect(summary.blocking).toEqual([]);
    expect(summary.warnings).toEqual([warning]);
    expect(summary.info).toEqual([info]);
    // Nothing blocks, so there is no block to clear — an action here would be advice nobody asked for.
    expect(summary.actionKey).toBeNull();
  });

  it('leaves the action null for a blocking code with no established remedy', () => {
    // `similar_pr` is critical and has no decided next step: approving past a duplicate suspicion
    // is a judgement call. Silence is the correct output — an invented instruction on a payment
    // screen is followed, fails, and teaches the user the screen does not know what it is doing.
    const summary = summarizeChecks([
      { code: 'similar_pr', severity: 'critical', vars: { numbers: '12' } },
    ]);

    expect(summary.blocking).toHaveLength(1);
    expect(summary.actionKey).toBeNull();
  });

  it('reports a clean run as clean', () => {
    expect(summarizeChecks([])).toEqual({ blocking: [], warnings: [], info: [], actionKey: null });
  });

  it('still finds the remedy when the blocking check is not the first finding', () => {
    const summary = summarizeChecks([
      { code: 'invoice_unapproved', severity: 'critical' },
      OVER_ALLOCATED,
    ]);

    expect(summary.blocking).toHaveLength(2);
    expect(summary.actionKey).toBe('checks.actionAllocationVsBalance');
  });
});
