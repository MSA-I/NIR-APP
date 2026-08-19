// The organization's autonomy switches.
//
// The reason this file exists: `document.packet_split` shipped in migration 0140 and was never
// added to the panel's list, so for weeks the product showed three switches over a database that
// held four. An owner who said "everything is enabled in my settings" was telling the truth about
// what the product showed him. What is asserted here is that every switch the panel claims to
// govern is on screen, that the fourth one says what it does and — the load-bearing half — what it
// does NOT do, and that it keeps the two page limits apart: migration 0144 raised the automatic
// split ceiling to 40, while the worker's paid-OCR cap stayed at 20, so a scanned 21-40 page packet
// is still refused. Both numbers come from `serverLimits.ts` here and in the product.
//
// Since the move into the operator application the panel reads through the platform door —
// platform_get_autonomy_policies(p_org_id) (0147), one call for the whole list — instead of four
// tenant-scoped evaluate_autonomy_policy calls that could only ever answer for the CALLER's own
// organization.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../lib/query/client';
import { OrgScopeProvider } from '../lib/query/orgScope';
import {
  AUTOMATIC_SPLIT_PAGE_CEILING, PAID_OCR_PAGE_CAP,
} from '../components/document-review/serverLimits';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

import { AutonomyPolicyPanel } from './AutonomyPolicyPanel';
import { ToastProvider } from '../components/ui';

const POLICY_KEYS = [
  'document.packet_split', 'document.interpretation', 'price_list.intake', 'delivery_note.receiving',
] as const;

/** `private.autonomy_policy_for_org` always answers, configured or not: an org with no row gets
    `configured: false` and a NULL threshold, never a missing row — and the platform door (0147)
    returns that answer for every defined policy key in one set. */
function policyRow(policy_key: string, overrides: Partial<{
  configured: boolean; autonomy_enabled: boolean; min_confidence: number | null; kill_switch: boolean;
}> = {}) {
  return {
    policy_key,
    configured: overrides.configured ?? false,
    autonomy_enabled: overrides.autonomy_enabled ?? false,
    min_confidence: overrides.min_confidence ?? null,
    kill_switch: overrides.kill_switch ?? false,
  };
}

async function renderPanel() {
  rpc.mockImplementation(async (_fn: string, _args: { p_org_id: string }) => ({
    data: POLICY_KEYS.map((key) => policyRow(key)),
    error: null,
  }));
  render(
    <QueryClientProvider client={createAppQueryClient()}>
      <OrgScopeProvider org="org-1">
        <ToastProvider>
          <AutonomyPolicyPanel orgId="org-1" orgName="גמוס" />
        </ToastProvider>
      </OrgScopeProvider>
    </QueryClientProvider>,
  );
  return screen.findByTestId('autonomy-policy-panel');
}

const card = (key: string) => screen.getByTestId(`autonomy-policy-${key}`);

describe('מדיניות אוטונומיית מסמכים', () => {
  beforeEach(() => { rpc.mockReset(); });

  it('מציג את כל ארבע המדיניויות שקיימות בבסיס הנתונים', async () => {
    await renderPanel();

    for (const key of POLICY_KEYS) {
      expect(card(key)).toBeInTheDocument();
    }
    // One read through the platform door, for the organization the operator picked — not four
    // tenant-scoped evaluator calls that answer for the caller instead of the target.
    expect(rpc).toHaveBeenCalledWith('platform_get_autonomy_policies', { p_org_id: 'org-1' });
    expect(rpc).not.toHaveBeenCalledWith('evaluate_autonomy_policy', expect.anything());
    expect(screen.getAllByTestId(/^autonomy-policy-/)).toHaveLength(5); // four cards + the panel
  });

  it('מתג הפיצול אומר מה הוא עושה, ובמפורש מה הוא לא עושה', async () => {
    await renderPanel();
    const split = within(card('document.packet_split'));

    expect(split.getByRole('heading', { name: /פיצול קובץ שיש בו כמה מסמכים/ })).toBeInTheDocument();
    expect(split.getByText(/נחתך למסמכי בת נפרדים/)).toBeInTheDocument();
    // It moves paper, never money — and every child still faces its own review.
    expect(split.getByText(/אינו כותב שום דבר כספי/)).toBeInTheDocument();
    expect(split.getByText(/כל מסמך בת עובר קריאה, בדיקה ואישור בנפרד/)).toBeInTheDocument();
  });

  it('מונה את התנאים שמשאירים את הפיצול ידני גם כשהמתג פועל', async () => {
    await renderPanel();
    const warning = within(card('document.packet_split')).getByText(/גם כשהמתג פועל/);

    expect(warning).toHaveTextContent('כשלא כל הקובץ נקרא');
    expect(warning).toHaveTextContent(`כשהקובץ ארוך מ־${AUTOMATIC_SPLIT_PAGE_CEILING} עמודים`);
    expect(warning).toHaveTextContent('כשחלק כלשהו בקובץ נקרא מתחת לסף');
  });

  /**
   * The two numbers are different limits, and the case the owner will actually hit is the one
   * where they disagree: migration 0144 raised the split ceiling to 40, but the worker's paid-OCR
   * cap stayed at 20 — so a SCANNED 30-page packet still has unread pages, is honestly partial,
   * and is still refused. Copy that let him believe otherwise would be a promise the server does
   * not keep.
   */
  it('אומר במפורש שסריקה ארוכה מ-20 עמודים נשארת לאישור אדם גם אחרי העלאת התקרה', async () => {
    await renderPanel();
    const warning = within(card('document.packet_split')).getByText(/גם כשהמתג פועל/);

    expect(PAID_OCR_PAGE_CAP).toBe(20);
    expect(AUTOMATIC_SPLIT_PAGE_CEILING).toBe(40);
    expect(warning).toHaveTextContent(`קובץ סרוק נקרא עד ${PAID_OCR_PAGE_CAP} עמודים בלבד`);
    expect(warning).toHaveTextContent('סריקה ארוכה מכך תמיד נשארת לאישור אדם');
    expect(warning).toHaveTextContent(`תקרת ה־${AUTOMATIC_SPLIT_PAGE_CEILING} נוגעת לקובץ PDF שנושא שכבת טקסט משלו`);
  });

  it('ארגון שאין לו שורה למדיניות מקבל מתג כבוי — ולא פאנל שנשבר', async () => {
    await renderPanel();
    const split = within(card('document.packet_split'));

    expect(split.getByText('כבויה')).toBeInTheDocument();
    expect(split.getByRole('button', { name: 'הפעלה' })).toBeEnabled();
    // The uncalibrated floor is the default in the field, not zero.
    expect(split.getByLabelText('סף ביטחון מזערי')).toHaveValue(0.9);
  });
});
