import { describe, expect, it } from 'vitest';
import {
  expenseSummaryTemplateValues,
  monthlyReportTemplateValues,
  productPurchaseTemplateValues,
  REPORT_TEMPLATE_ERROR_KEY,
  ReportTemplateError,
  reportTemplateErrorText,
  type ReportTemplateErrorCode,
} from './reportTemplateExport';
import { en } from './i18n/dictionaries/en';
import { he } from './i18n/dictionaries/he';
import type { Dictionary } from './i18n/dictionaries/he';
import { translate, type TKey } from './i18n/t';

const say = (dictionary: Dictionary) => (key: TKey) => translate(dictionary, key);
const sayHe = say(he as unknown as Dictionary);
const sayEn = say(en);

const ERROR_CODES: ReportTemplateErrorCode[] = [
  'mapping_invalid',
  'unknown_report_type',
  'cell_invalid',
  'duplicate_cell',
  'field_invalid',
  'wrong_export_key',
  'path_invalid',
  'bytes_invalid',
  'checksum_invalid',
  'download_failed',
  'downloaded_size_mismatch',
  'downloaded_checksum_mismatch',
  'workbook_invalid',
];

const period = {
  orgName: 'מסעדת בדיקה',
  periodLabel: 'אוגוסט 2026',
  periodFrom: '01.08.2026',
  periodTo: '31.08.2026',
  generatedAt: '01.09.2026',
};

describe('ערכי תבניות הדוחות', () => {
  it('ממפה כל קוד כשל תבנית לשתי השפות', () => {
    expect(Object.keys(REPORT_TEMPLATE_ERROR_KEY).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(sayHe(REPORT_TEMPLATE_ERROR_KEY[code])).not.toBe(REPORT_TEMPLATE_ERROR_KEY[code]);
      expect(sayEn(REPORT_TEMPLATE_ERROR_KEY[code])).not.toBe(REPORT_TEMPLATE_ERROR_KEY[code]);
    }
    const failure = new ReportTemplateError('download_failed');
    expect(reportTemplateErrorText(failure, sayHe, () => 'fallback'))
      .toBe('לא ניתן להוריד את תבנית הייצוא הפרטית. נסו שוב או העלו תבנית חדשה.');
    expect(reportTemplateErrorText(failure, sayEn, () => 'fallback'))
      .toBe('The private export template could not be downloaded. Try again or upload a new template.');
    expect(reportTemplateErrorText(new Error('network'), sayEn, () => 'fallback')).toBe('fallback');
  });

  it('מפיק את דוח רואה החשבון מהחשבוניות ומהזיכוי שהשרת כבר קיזז מהן', () => {
    const values = monthlyReportTemplateValues({
      ...period,
      invoices: [
        { amount_before_vat: 100, vat_amount: 18, total_amount: 118, currency: 'ILS', supplier: { name: 'א' },
          balance: { credited_amount: 20 } },
        { amount_before_vat: 200, vat_amount: 36, total_amount: 236, currency: 'ILS', supplier: { name: 'ב' },
          balance: { credited_amount: 10 } },
        { amount_before_vat: 50, vat_amount: 9, total_amount: 59, currency: 'ILS', supplier: { name: 'א' },
          balance: { credited_amount: 0 } },
      ],
    });

    expect(values).toMatchObject({
      invoice_count: 3,
      supplier_count: 2,
      net_total: 350,
      vat_total: 63,
      gross_total: 413,
      credits_recognized: 30,
      net_expense: 383,
    });
  });

  // The defect this replaces: `0173` lets a credit be consumed in part, and such a credit stays
  // `received`. The old body filtered credits by `offset`/`closed`, so the 30 that
  // `invoice_balances` had already taken off the invoice never reached the accountant's file and
  // `net_expense` overstated the month by exactly that much.
  it('מכיר בזיכוי שנוצל חלקית, שעדיין נושא סטטוס received', () => {
    const values = monthlyReportTemplateValues({
      ...period,
      invoices: [
        { amount_before_vat: 100, vat_amount: 18, total_amount: 118, currency: 'ILS', supplier: { name: 'א' },
          balance: { credited_amount: 30 } },
      ],
    });

    expect(values).toMatchObject({ gross_total: 118, credits_recognized: 30, net_expense: 88 });
  });

  // An invoice the reader may not see a balance row for makes the subtraction unanswerable: the
  // two sides would range over different invoice sets. `—` is the honest cell, and 0 would be the
  // same silent understatement in a new disguise.
  it('מסרב לנקוב זיכוי מוכר כשחסרה שורת יתרה לחשבונית', () => {
    const values = monthlyReportTemplateValues({
      ...period,
      invoices: [
        { amount_before_vat: 100, vat_amount: 18, total_amount: 118, currency: 'ILS', supplier: { name: 'א' },
          balance: { credited_amount: 30 } },
        { amount_before_vat: 200, vat_amount: 36, total_amount: 236, currency: 'ILS', supplier: { name: 'ב' },
          balance: null },
      ],
    });

    expect(values).toMatchObject({ gross_total: 354, credits_recognized: null, net_expense: null });
  });

  it('משתמש במדדים הקנוניים של השרת בריכוז ההוצאות', () => {
    const values = expenseSummaryTemplateValues({
      ...period,
      metrics: {
        committed_by_currency: [{ currency: 'ILS', amount: 900 }],
        gross_expense_by_currency: [{ currency: 'ILS', amount: 700 }],
        credits_recognised_by_currency: [{ currency: 'ILS', amount: 40 }],
        net_expense_by_currency: [{ currency: 'ILS', amount: 660 }],
      },
      bySupplier: [
        { name: 'קטן', total: 100, currency: 'ILS' },
        { name: '=מסוכן', total: 600, currency: 'ILS' },
      ],
    });

    expect(values).toMatchObject({
      committed_total: 900,
      gross_total: 700,
      credits_recognized: 40,
      net_expense: 660,
      top_supplier_name: '=מסוכן',
      top_supplier_total: 600,
    });
  });

  it('שומר את הסכום הלא ממופה גלוי בתוך סך רכישות המוצרים', () => {
    const values = productPurchaseTemplateValues({
      ...period,
      products: [
        { gross_amount_by_currency: [{ currency: 'ILS', amount: 120 }] },
        { gross_amount_by_currency: null },
        { gross_amount_by_currency: [{ currency: 'ILS', amount: 80 }] },
      ],
      unmappedInvoiceLines: 2,
      unmappedInvoiceAmount: [{ currency: 'ILS', amount: 25 }],
    });

    expect(values).toMatchObject({
      product_count: 3,
      gross_total: 225,
      unmapped_invoice_lines: 2,
      unmapped_invoice_amount: 25,
      // A single-currency period fills every numeric cell exactly as it always did, and names
      // the currency those cells are in.
      currency: 'ILS',
      currency_note: null,
    });
  });

  /* THE SENTENCE THIS WHOLE CHANGE IS MEASURED AGAINST (OPEN-DECISIONS #277). A workbook cell is
     a number an accountant sorts and adds in Excel. There is no honest single number for a period
     holding ₪12,400 and $3,100 — 15,500 is not the total, and a cell containing it would be worse
     than an empty one because it looks computed. So the numeric placeholders arrive null, which
     every template already renders as an em dash, and currency_note says in words why. */
  it('תקופה עם שני מטבעות — התאים המספריים נשארים ריקים והקובץ אומר למה', () => {
    const values = monthlyReportTemplateValues({
      ...period,
      invoices: [
        { amount_before_vat: 10000, vat_amount: 2400, total_amount: 12400, currency: 'ILS',
          supplier: { name: 'א' }, balance: { credited_amount: 0 } },
        { amount_before_vat: 3100, vat_amount: 0, total_amount: 3100, currency: 'USD',
          supplier: { name: 'ב' }, balance: { credited_amount: 0 } },
      ],
    });

    expect(values.gross_total).toBeNull();
    expect(values.net_total).toBeNull();
    expect(values.vat_total).toBeNull();
    expect(values.credits_recognized).toBeNull();
    expect(values.net_expense).toBeNull();
    // Nothing in the file equals the sum of the two.
    expect(Object.values(values)).not.toContain(15500);
    // The count and the supplier count are counts, and they are still true.
    expect(values.invoice_count).toBe(2);
    expect(values.supplier_count).toBe(2);
    // The reason is stated, not left as an unexplained gap.
    expect(values.currency).toBeNull();
    expect(values.currency_note).toContain('ILS');
    expect(values.currency_note).toContain('USD');
  });

  it('ריכוז הוצאות בשני מטבעות — אין ספק מוביל וגם אין סכום', () => {
    const values = expenseSummaryTemplateValues({
      ...period,
      metrics: {
        committed_by_currency: [{ currency: 'ILS', amount: 900 }, { currency: 'USD', amount: 200 }],
        gross_expense_by_currency: [{ currency: 'ILS', amount: 700 }, { currency: 'USD', amount: 150 }],
        credits_recognised_by_currency: null,
        net_expense_by_currency: null,
      },
      // The caller passes the slice matching the currency whose cells were filled — and when none
      // were, it passes nothing rather than a supplier whose figure is in a different unit.
      bySupplier: [],
    });

    expect(values.gross_total).toBeNull();
    expect(values.committed_total).toBeNull();
    expect(values.top_supplier_name).toBeNull();
    expect(values.top_supplier_total).toBeNull();
    expect(values.currency_note).toContain('USD');
  });
});
