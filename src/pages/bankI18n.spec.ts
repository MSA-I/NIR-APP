import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../lib/i18n/dictionaries/en';
import { he } from '../lib/i18n/dictionaries/he';

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'Bank.tsx'), 'utf8');

describe('bank screen language boundaries', () => {
  it('renders the transaction sentence from a paired dictionary key', () => {
    expect(source).toContain("t('bank.transactionRowLabel'");
    expect(he.bank.transactionRowLabel)
      .toBe('תנועת בנק מיום {date} בסכום {amount} עבור {description}');
    expect(en.bank.transactionRowLabel)
      .toBe('Bank transaction dated {date}, amount {amount}, for {description}');
  });

  it('keeps input normalization and audit defaults stable at their write sites', () => {
    expect(source).toContain(".replace(/בע\\s*מ/g, '')");
    const auditDefaults = [
      'הסרת ההתאמה',
      'ייבוא תדפיס הבנק',
      'פעולה',
      'אישור ההתאמה',
      'פתיחת החריג',
      'סימון התנועה',
    ];
    for (const value of auditDefaults) {
      expect(source).toContain(`p_reason: reasonOr(reason, '${value}')`);
    }
    expect(source.match(/p_reason: reasonOr\(reason, 'אישור ההתאמה'\)/g)).toHaveLength(2);
    expect(source).not.toContain("t('bank.reasonOr");
    expect(he.bank).not.toHaveProperty('reasonOr');
    expect(en.bank).not.toHaveProperty('reasonOr');
  });

  /**
   * FIN-08 / MON-08 — one screen, two contradictory conventions for the same box.
   *
   * MON-08 measured the server half: `unmatch_bank_transaction` refuses a blank `p_reason` by name
   * (`bank_unmatch_invalid`, 22023). The client never lets that refusal happen, and deliberately so
   * — `reasonOr` writes a ledger sentence when the box is empty, which is the decided behaviour
   * (owner, 11.08.2026, quoted in `src/lib/reason.ts`) and is pinned by the assertion above.
   *
   * So the box genuinely does NOT block the button, and the '*' on its label was the only thing on
   * this screen making a claim the code does not keep — while the action dialog beside it, over an
   * identically optional box, said "(רשות)". The label now reads from the one key `reason.ts`
   * documents as "the label for a reason box that no longer blocks the button", so there is one
   * convention rather than two, and no second place for the asterisk to come back to.
   */
  it('never marks the un-match reason box required, because nothing enforces it', () => {
    expect(source).toContain("p_reason: reasonOr(reason, 'הסרת ההתאמה')");
    expect(source).toContain("htmlFor=\"bank-unmatch-reason\">{t(OPTIONAL_REASON_LABEL_KEY)}");
    expect(source).toContain("import { OPTIONAL_REASON_LABEL_KEY, reasonOr } from '../lib/reason';");
    expect(he.bank).not.toHaveProperty('text_12');
    expect(en.bank).not.toHaveProperty('text_12');
    expect(he.reason.optionalLabel).toContain('רשות');
    for (const dict of [he.bank, en.bank]) {
      const reasonLabels = Object.entries(dict).filter(([key]) => /^setReason/.test(key));
      expect(reasonLabels.length).toBeGreaterThan(0);
      for (const [, value] of reasonLabels) expect(String(value)).not.toContain('*');
    }
  });

  it('stores candidate keys and import facts instead of resolved sentences', () => {
    expect(source).toContain('labelKey: TKey;');
    expect(source).not.toContain('label: string;');
    expect(source).toContain('setResult({ rowCount: imported.row_count, idempotent: imported.idempotent })');
    expect(source).not.toContain('setResult(imported.idempotent');
  });
});
