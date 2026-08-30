import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHECK_MESSAGE_KEY,
  checkText,
  type CheckCode,
  type CheckResult,
} from './checks';
import { en } from './i18n/dictionaries/en';
import { he } from './i18n/dictionaries/he';
import type { Dictionary } from './i18n/dictionaries/he';
import { translate, type TKey } from './i18n/t';

const say = (dictionary: Dictionary) =>
  (key: TKey, vars?: Record<string, string | number>) => translate(dictionary, key, vars);
const sayHe = say(he as unknown as Dictionary);
const sayEn = say(en);

const CODES: CheckCode[] = [
  'duplicate_number',
  'duplicate_number_paid',
  'similar_invoice',
  'order_mismatch',
  'receipt_mismatch',
  'existing_pr',
  'bank_matched',
  'already_paid',
  'invoice_open_credit_one',
  'invoice_open_credit_many',
  'invoice_visibility',
  'invoice_paid_one',
  'invoice_paid_many',
  'invoice_unapproved',
  'allocation_vs_balance_one',
  'allocation_vs_balance_many',
  'amount_vs_balance',
  'similar_pr',
  'similar_bank_unavailable',
  'payment_request_open_credit',
];

describe('automatic-check language contract', () => {
  it('maps every CheckCode to exactly one paired dictionary key', () => {
    expect(Object.keys(CHECK_MESSAGE_KEY).sort()).toEqual([...CODES].sort());
    for (const code of CODES) {
      expect(sayHe(CHECK_MESSAGE_KEY[code])).not.toBe(CHECK_MESSAGE_KEY[code]);
      expect(sayEn(CHECK_MESSAGE_KEY[code])).not.toBe(CHECK_MESSAGE_KEY[code]);
    }
  });

  it('resolves a paid duplicate from raw facts in either reader language', () => {
    const check: CheckResult = {
      code: 'duplicate_number_paid',
      severity: 'critical',
      vars: { date: '28.08.2026', amount: '120.00 ₪' },
    };

    expect(checkText(check, sayHe))
      .toBe('קיימת חשבונית עם אותו מספר לאותו ספק (מ־28.08.2026, 120.00 ₪, שולמה)');
    expect(checkText(check, sayEn))
      .toBe('An invoice with the same number exists for this supplier (dated 28.08.2026, 120.00 ₪, paid)');
  });

  it('keeps singular and plural financial findings structurally distinct', () => {
    const one: CheckResult = {
      code: 'allocation_vs_balance_one', severity: 'critical', vars: { count: 1 },
    };
    const many: CheckResult = {
      code: 'allocation_vs_balance_many', severity: 'critical', vars: { count: 3 },
    };

    expect(checkText(one, sayEn)).toMatch(/^One linked invoice is allocated/);
    expect(checkText(many, sayEn)).toMatch(/^3 linked invoices are allocated/);
    expect(checkText(one, sayHe)).toContain('חשבונית מקושרת אחת');
    expect(checkText(many, sayHe)).toContain('3 מהחשבוניות המקושרות');
  });

  it('stores codes and variables, never reader-facing sentences', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'checks.ts'), 'utf8');
    expect(source).not.toMatch(/[֐-׿]/);
    expect(source).not.toContain('message:');
    expect(source).toContain('code: CheckCode;');
    expect(source).toContain('vars?: Record<string, string | number>;');
  });
});
