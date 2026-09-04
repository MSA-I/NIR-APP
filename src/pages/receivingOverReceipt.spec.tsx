/**
 * `PROC-03` — a quantity the server will certainly refuse, shown as a completed line.
 *
 * Order #268 had 3 ק״ג outstanding on its one line. Typing 9 left the card green, the badge
 * reading 'התקבל מלא' and the hint beside the field reading 'מלא (3 ק״ג)' — three claims, all
 * false, about the number sitting in the field. The refusal came only after 'סיום קבלה', from
 * `save_goods_receipt`, which rejects `qty_received > (qty - received_qty)` unconditionally
 * (`0023:1516`) — there is no over-receipt it accepts, for any status. The clerk then landed in
 * the conflict dialog of `PROC-01`, which could not recover.
 *
 * The rule is pinned here, and the badge is checked on `StatusBadge`, which owns it. `Receiving`
 * itself needs a session, a router and a receipt to render, and a mock stack deep enough to paint
 * it would prove the mock — the same reason `receivingExceptionReason.spec.tsx` reads the wiring
 * from source and checks the rendered behaviour on the component that owns it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../components/ui';
import { he } from '../lib/i18n/dictionaries/he';
import { en } from '../lib/i18n/dictionaries/en';
import { receiptLineClaim } from './Receiving';

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'Receiving.tsx'), 'utf8');

describe('receiptLineClaim — what the card may claim about a quantity', () => {
  it('refuses to call the reported case a completed line', () => {
    // Order #268: 3 outstanding, 9 typed, the status control still on 'full'.
    expect(receiptLineClaim(9, 3, 'full')).toEqual({ overReceipt: true, tone: 'alert' });
  });

  it('still calls an exact remainder complete', () => {
    expect(receiptLineClaim(3, 3, 'full')).toEqual({ overReceipt: false, tone: 'done' });
  });

  it('leaves every quantity at or below the remainder exactly as it was', () => {
    expect(receiptLineClaim(2, 3, 'partial')).toEqual({ overReceipt: false, tone: 'await' });
    expect(receiptLineClaim(0, 3, 'missing')).toEqual({ overReceipt: false, tone: 'alert' });
    expect(receiptLineClaim(1, 3, 'damaged')).toEqual({ overReceipt: false, tone: 'alert' });
  });

  it('does not let a quality judgement hide a surplus', () => {
    // 'damaged' is already alert-toned, so the tone alone proves nothing; the flag is what drives
    // the badge and the inline reason.
    expect(receiptLineClaim(9, 3, 'damaged').overReceipt).toBe(true);
  });

  it('treats a fully received line as having nothing outstanding', () => {
    expect(receiptLineClaim(1, 0, 'full')).toEqual({ overReceipt: true, tone: 'alert' });
  });
});

describe('the surplus is named on screen, before the receipt is finished', () => {
  it('badges the line as the exception it is, not as received in full', () => {
    render(<StatusBadge meta={{ label: he.receiving.overReceiptBadge, tone: 'alert' }} />);
    const badge = screen.getByText(he.receiving.overReceiptBadge);
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain('badge-alert');
    // The claim the defect made, in the exact words the screen used.
    expect(he.receiving.overReceiptBadge).not.toBe(he.status.receiptLine_full);
  });

  it('says why, in both languages, naming the quantity actually outstanding', () => {
    for (const hint of [he.receiving.overReceiptHint, en.receiving.overReceiptHint]) {
      expect(hint).toContain('{quantity}');
      expect(hint.length).toBeGreaterThan(40);
    }
    expect(he.receiving.overReceiptHint).toMatch(/[֐-׿]/);
  });

  it('wires the rule, the badge and the reason into the line card', () => {
    // Booleans, not `toContain`: the file is 1,200 lines and a failure should name the missing
    // wire rather than print the screen.
    const wired = {
      // The rule is used, not merely exported.
      rule: source.includes('receiptLineClaim(line.qty, remaining, line.status)'),
      // The badge stops coming unconditionally from the stored status.
      badge: source.includes("? { label: t('receiving.overReceiptBadge'), tone: 'alert' as const }"),
      // And the reason is announced where the number is typed, not after 'סיום קבלה'.
      reason: /overReceipt && \(\s*<p role="alert"/.test(source),
      hint: source.includes("t('receiving.overReceiptHint'"),
    };
    expect(wired).toEqual({ rule: true, badge: true, reason: true, hint: true });
  });
});
