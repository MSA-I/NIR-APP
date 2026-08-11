import { describe, expect, it } from 'vitest';
import {
  expenseSummaryTemplateValues,
  monthlyReportTemplateValues,
  productPurchaseTemplateValues,
} from './reportTemplateExport';

const period = {
  orgName: 'מסעדת בדיקה',
  periodLabel: 'אוגוסט 2026',
  periodFrom: '01.08.2026',
  periodTo: '31.08.2026',
  generatedAt: '01.09.2026',
};

describe('ערכי תבניות הדוחות', () => {
  it('מפיק את דוח רואה החשבון מהחשבוניות ורק מזיכויים שקוזזו', () => {
    const values = monthlyReportTemplateValues({
      ...period,
      invoices: [
        { amount_before_vat: 100, vat_amount: 18, total_amount: 118, supplier: { name: 'א' } },
        { amount_before_vat: 200, vat_amount: 36, total_amount: 236, supplier: { name: 'ב' } },
        { amount_before_vat: 50, vat_amount: 9, total_amount: 59, supplier: { name: 'א' } },
      ],
      credits: [
        { amount: 20, status: 'offset' },
        { amount: 10, status: 'closed' },
        { amount: 999, status: 'requested' },
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

  it('משתמש במדדים הקנוניים של השרת בריכוז ההוצאות', () => {
    const values = expenseSummaryTemplateValues({
      ...period,
      metrics: { committed: 900, gross_expense: 700, credits_recognised: 40, net_expense: 660 },
      bySupplier: [
        { name: 'קטן', total: 100 },
        { name: '=מסוכן', total: 600 },
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
      products: [{ gross_amount: 120 }, { gross_amount: null }, { gross_amount: 80 }],
      unmappedInvoiceLines: 2,
      unmappedInvoiceAmount: 25,
    });

    expect(values).toMatchObject({
      product_count: 3,
      gross_total: 225,
      unmapped_invoice_lines: 2,
      unmapped_invoice_amount: 25,
    });
  });
});
