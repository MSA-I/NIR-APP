import { fmtDate, fmtMoneyExact, formatUnit } from './format';
import type { Locale } from './i18n/locale';
import type { TKey } from './i18n/t';
import type { WorkbookSpec } from './workbook';

/**
 * The built-in workbook behind `/reports/products`, extracted from the screen it used to live in
 * so the file can be READ (`EXP-04`, 04.09.2026) rather than inferred from the builder's inputs —
 * the shape `monthlyReport.ts` already established for the accountant's monthly report.
 *
 * ─── WHY THE PROVENANCE HAD TO MOVE ──────────────────────────────────────────────────────────
 * Every quantity on this screen carries a caveat under the product's name: part of it may rest on
 * the supplier's word rather than our own count, or it may still be waiting for evidence
 * altogether. The screen calls that "the difference between a number you can quote back to them
 * and one you cannot" — and it was attached in the React component, so the twelve-column export
 * carried none of it. The file that leaves the building stated every quantity flat.
 *
 * ─── AND WHY 74 ROWS SAID "WE PURCHASED ZERO" ────────────────────────────────────────────────
 * `0221` computes the canonical quantity per order item as
 * `case when receipt.qty is not null then receipt.qty else coalesce(invoice.qty, 0) end`, so an
 * item with neither a completed receipt nor an approved invoice line contributes **0** and is
 * labelled `not_yet_evidenced`. Summed to the product, that is a canonical quantity of 0 sitting
 * beside an empty `התקבל` and an empty `חויב` — the fabricated zero the constitution forbids,
 * because zero is itself a claim about the world.
 *
 * The same migration makes the test for it exact: `received_qty` is null precisely when no receipt
 * row contributed and `invoiced_qty` precisely when no approved invoice line did. A row with both
 * null is a row whose every item is `not_yet_evidenced`, and its canonical figure is a sum of
 * zeros rather than a count of anything. That is an absence, and it is written as one.
 */

export interface ProductPurchaseRow {
  product_name: string;
  unit: string | null;
  ordered_qty: number | null;
  received_qty: number | null;
  invoiced_qty: number | null;
  canonical_qty: number | null;
  supplier_count: number;
  order_count: number;
  invoice_count: number;
  gross_amount_by_currency: { currency: string; amount: number }[] | null;
  ordered_amount_by_currency: { currency: string; amount: number }[];
  average_unit_price: number | null;
  average_unit_price_currency: string | null;
  spans_currencies: boolean;
  includes_invoice_only_quantity: boolean;
  includes_unevidenced_quantity: boolean;
}

/**
 * True when nothing was measured for this product in the window: no completed receipt and no
 * approved invoice line contributed a single row. Its canonical quantity is then a sum of zeros,
 * and both the screen and the file say so with the absence marker rather than with `0`.
 *
 * The screen and the export share this one predicate on purpose. Two readings of "unmeasured" is
 * how the caveat came to be screen-only in the first place.
 */
export function canonicalQuantityIsUnmeasured(row: Pick<ProductPurchaseRow, 'received_qty' | 'invoiced_qty'>): boolean {
  return row.received_qty == null && row.invoiced_qty == null;
}

/** The screen's own chips are separated by a middle dot; a spreadsheet cell states them plainly. */
const plainCaveat = (value: string) => value.replace(/^[\s·•]+/, '');

/**
 * What the canonical quantity on this row rests on, in the screen's own words.
 *
 * `0221` distinguishes three sources per order item and reports two booleans over them. Neither
 * flag set means every item was counted from a completed receipt — the strongest provenance this
 * report can have, and worth saying, because a silent cell would read as "unknown".
 */
export function quantityProvenance(
  row: Pick<ProductPurchaseRow, 'includes_invoice_only_quantity' | 'includes_unevidenced_quantity'>,
  t: (key: TKey, vars?: Record<string, string | number>) => string,
): string {
  const caveats = [
    ...(row.includes_invoice_only_quantity ? [plainCaveat(t('productPurchase.text_2'))] : []),
    ...(row.includes_unevidenced_quantity ? [plainCaveat(t('productPurchase.text_3'))] : []),
  ];
  return caveats.length ? caveats.join(' · ') : t('productPurchase.provenanceFullyEvidenced');
}

export function buildProductPurchaseWorkbook(input: {
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  locale: Locale;
  orgName: string;
  from: string;
  to: string;
  generatedAt: string;
  products: readonly ProductPurchaseRow[];
}): WorkbookSpec {
  const { t, locale, products } = input;
  return {
    title: t('productPurchase.pdfTitle', { org: input.orgName }),
    subtitle: t('productPurchase.pdfSubtitle', {
      from: fmtDate(input.from), to: fmtDate(input.to), generated: fmtDate(input.generatedAt),
    }),
    sheets: [{
      name: t('productPurchase.book_append_sheet'),
      emptyNote: t('productPurchase.emptyTitle'),
      columns: [
        { header: t('productPurchase.text_11'), key: 'product', width: 32 },
        { header: t('productPurchase.formatUnit'), key: 'unit', width: 10 },
        { header: t('productPurchase.text_12'), key: 'ordered', width: 10, type: 'number' },
        { header: t('productPurchase.text_13'), key: 'received', width: 10, type: 'number' },
        { header: t('productPurchase.text_14'), key: 'invoiced', width: 10, type: 'number' },
        { header: t('productPurchase.text_15'), key: 'canonical', width: 13, type: 'number' },
        // Beside the figure it qualifies, not at the far end of an eleven-column grid: a caveat a
        // reader has to scroll to find is a caveat that will be quoted without.
        { header: t('productPurchase.provenanceColumn'), key: 'provenance', width: 34 },
        { header: t('productPurchase.text_16'), key: 'suppliers', width: 12, type: 'number' },
        { header: t('productPurchase.text_17'), key: 'orders', width: 12, type: 'number' },
        { header: t('productPurchase.text_18'), key: 'invoices', width: 13, type: 'number' },
        // Text, for the same reason the two columns beside it are: a product ordered in two
        // currencies has two committed figures and one numeric cell cannot hold them.
        { header: t('productPurchase.committedCost'), key: 'orderedCost', width: 20 },
        { header: t('productPurchase.text_19'), key: 'gross', width: 20 },
        { header: t('productPurchase.text_20'), key: 'average', width: 20 },
      ],
      rows: products.map((row) => ({
        product: row.product_name,
        unit: formatUnit(row.unit, locale),
        ordered: row.ordered_qty,
        received: row.received_qty,
        invoiced: row.invoiced_qty,
        canonical: canonicalQuantityIsUnmeasured(row) ? null : row.canonical_qty,
        provenance: quantityProvenance(row, t),
        suppliers: row.supplier_count,
        orders: row.order_count,
        invoices: row.invoice_count,
        orderedCost: (row.ordered_amount_by_currency ?? [])
          .map((entry) => fmtMoneyExact(entry.amount, entry.currency)).join(' · '),
        gross: (row.gross_amount_by_currency ?? [])
          .map((entry) => fmtMoneyExact(entry.amount, entry.currency)).join(' · '),
        average: row.spans_currencies
          ? t('productPurchase.inSeveralCurrencies')
          : fmtMoneyExact(row.average_unit_price, row.average_unit_price_currency),
      })),
    }],
  };
}
