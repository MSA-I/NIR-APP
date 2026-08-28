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

  it('stores candidate keys and import facts instead of resolved sentences', () => {
    expect(source).toContain('labelKey: TKey;');
    expect(source).not.toContain('label: string;');
    expect(source).toContain('setResult({ rowCount: imported.row_count, idempotent: imported.idempotent })');
    expect(source).not.toContain('setResult(imported.idempotent');
  });
});
