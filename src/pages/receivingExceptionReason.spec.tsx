/**
 * The one reason box in this campaign that is not ceremony.
 *
 * #290 removed the audit-reason boxes that only ever produced "asdf", and kept the ones whose text
 * a person actually reads. This is the second kind, and the chain is short enough to pin end to
 * end: `Receiving` writes it through `open_manual_exception`, the command copies it into the
 * exception's `details.reason` (`0087:165`), and `Exceptions` renders it back to whoever picks the
 * exception up, under the label "סיבה". A future edit that deletes the box here does not remove a
 * nag — it blanks a field an investigator was going to read.
 *
 * So the question the box asks was changed to the one the investigator needs answered — what to
 * look into, not why a button was pressed — and both halves are pinned: the label, and the fact
 * that it still does not block.
 *
 * `Receiving` itself needs a session and a receipt to render, and a mock stack deep enough to paint
 * it would prove the mock (`deadEndFixes.spec.tsx` says the same about the same four screens). So
 * the wiring is read from source, and the rendered behaviour is checked on the dialog that owns it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '../components/ui';

const source = (file: string) => readFileSync(join(process.cwd(), 'src', 'pages', file), 'utf8');

/** The exact question the manual-exception dialog asks, as `Receiving.tsx` passes it. */
const RECEIVING_REASON_LABEL = 'מה צריך לברר? (רשות — יוצג למי שיטפל בחריג)';

describe('the manual-exception box asks the investigator\'s question', () => {
  it('passes that label to the dialog it opens, alongside the box it keeps', () => {
    const receiving = source('Receiving.tsx');
    expect(receiving).toContain(`reasonLabel="${RECEIVING_REASON_LABEL}"`);
    // The box itself stays — this is the flow where the typed text is content.
    expect(receiving).toContain('confirmLabel="פתיחת חריג" requireReason');
    // And it does not fall back to the shared audit wording, which asks the wrong question here.
    expect(receiving).not.toContain('OPTIONAL_REASON_LABEL');
  });

  it('is asking for something a person will read, not for the ledger alone', () => {
    // The fact that makes this box content: the exceptions screen prints `details.reason` back.
    const exceptions = source('Exceptions.tsx');
    expect(exceptions).toContain("reason: 'סיבה'");
    expect(exceptions).toContain('businessDetailLines(row.details)');
  });

  it('shows the question on screen and still lets an empty box through', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open onClose={vi.fn()} onConfirm={onConfirm}
        title="פתיחת חריג לבירור"
        message='ייפתח חריג "פריט שלא הוזמן" על הזמנה #1041.'
        reasonLabel={RECEIVING_REASON_LABEL}
        confirmLabel="פתיחת חריג" requireReason />,
    );

    // The label a person sees is the question, not "סיבה (רשות …)".
    expect(screen.getByLabelText(RECEIVING_REASON_LABEL)).toBeInTheDocument();

    // Nothing typed, and the button is live — #290 forbids the block even here.
    const confirm = screen.getByRole('button', { name: 'פתיחת חריג' });
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    // `open_manual_exception` raises `reason_required` (22023) on a blank string, so what reaches it
    // is the honest sentence `reasonOr` writes rather than nothing at all.
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const written = onConfirm.mock.calls[0][0] as string;
    expect(written.trim().length).toBeGreaterThan(0);
    expect(written).toContain('ללא הערה');
  });

  it('keeps what an investigator did write, untouched', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open onClose={vi.fn()} onConfirm={onConfirm}
        title="פתיחת חריג לבירור"
        message='ייפתח חריג "פריט שלא הוזמן" על הזמנה #1041.'
        reasonLabel={RECEIVING_REASON_LABEL}
        confirmLabel="פתיחת חריג" requireReason />,
    );

    await user.type(screen.getByLabelText(RECEIVING_REASON_LABEL), 'הגיעו 3 ארגזי עגבניות שלא בהזמנה — לברר מול הספק אם זו טעות שינוע');
    await user.click(screen.getByRole('button', { name: 'פתיחת חריג' }));

    expect(onConfirm).toHaveBeenCalledWith('הגיעו 3 ארגזי עגבניות שלא בהזמנה — לברר מול הספק אם זו טעות שינוע');
  });
});
