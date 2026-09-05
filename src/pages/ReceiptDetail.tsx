import { Link, useParams } from 'react-router';
import { FileText } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, Card, EmptyState, ErrorNote, Note, RecordHeader, RecordSkeleton, StatusBadge, ICON } from '../components/ui';
import { DocumentList } from '../components/FileUpload';
import OfflineQueueStatus from '../components/OfflineQueueStatus';
import { fmtDate, fmtMoneyExact, formatQuantity, productLabel } from '../lib/format';
import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { isUuid } from '../lib/invoiceLinkedContext';
import { CREDIT_STATUS, PO_STATUS, RECEIPT_LINE_STATUS, RECEIPT_STATUS } from '../lib/status';
import { supabase } from '../lib/supabase';
import type { CreditRequest, GoodsReceipt, GoodsReceiptItem, Product, PurchaseOrder, PurchaseOrderItem } from '../lib/types';
import { useQuery } from '../lib/useQuery';

type ReceiptRow = Pick<GoodsReceipt, 'id' | 'number' | 'order_id' | 'status' | 'received_at' | 'notes'>;
type ReceiptOrder = Pick<PurchaseOrder, 'id' | 'number' | 'supplier_id' | 'status'>;
/**
 * REQ-06. A line carries three quantities and they are three different facts, so they are held
 * apart rather than folded into one number: `qty_received` is what THIS delivery brought,
 * `ordered` is what the order line asked for, and `outstanding` is what the ORDER is still owed
 * across every delivery it has had. `null` on the last two means the order line could not be
 * read — the screen then says nothing about them rather than printing a zero.
 */
type ReceiptLine = Pick<GoodsReceiptItem, 'id' | 'order_item_id' | 'product_id' | 'qty_received' | 'status' | 'notes'> & {
  product: Pick<Product, 'id' | 'name' | 'display_name' | 'unit'> | null;
  ordered: number | null;
  outstanding: number | null;
};
/** A credit the receipt itself opened, and the way back to it. */
type ReceiptCredit = Pick<CreditRequest, 'id' | 'number' | 'amount' | 'currency' | 'status' | 'receipt_item_id'>;

interface ReceiptDetailData {
  receipt: ReceiptRow;
  order: ReceiptOrder;
  supplier: { id: string; name: string };
  lines: ReceiptLine[];
  credits: ReceiptCredit[];
}

const UNAVAILABLE_KEY: TKey = 'receiptDetail.unavailable';

export default function ReceiptDetail() {
  const { locale, t } = useT();
  const { receiptId } = useParams<{ receiptId: string }>();
  const { profile } = useAuth();
  const orgId = profile?.org_id ?? null;
  const canOpenOrder = profile?.role === 'owner' || profile?.role === 'office';

  const { data, loading } = useQuery<ReceiptDetailData | null>(async () => {
    if (!orgId || !isUuid(receiptId ?? null)) return null;
    try {
      const receiptResult = await supabase.from('goods_receipts')
        .select('id, number, order_id, status, received_at, notes')
        .eq('id', receiptId!).eq('org_id', orgId).maybeSingle();
      if (receiptResult.error || !receiptResult.data) return null;
      const receipt = receiptResult.data as ReceiptRow;

      const [orderResult, linesResult] = await Promise.all([
        supabase.from('purchase_orders').select('id, number, supplier_id, status')
          .eq('id', receipt.order_id).eq('org_id', orgId).maybeSingle(),
        supabase.from('goods_receipt_items').select('id, order_item_id, product_id, qty_received, status, notes')
          .eq('receipt_id', receipt.id).eq('org_id', orgId).order('id'),
      ]);
      if (orderResult.error || !orderResult.data || linesResult.error) return null;
      const order = orderResult.data as ReceiptOrder;
      const rawLines = (linesResult.data ?? []) as Array<Pick<GoodsReceiptItem, 'id' | 'order_item_id' | 'product_id' | 'qty_received' | 'status' | 'notes'>>;

      const supplierResult = await supabase.from('suppliers').select('id, name')
        .eq('id', order.supplier_id).eq('org_id', orgId).maybeSingle();
      if (supplierResult.error || !supplierResult.data) return null;

      const productIds = [...new Set(rawLines.map(({ product_id }) => product_id))];
      let products: Array<Pick<Product, 'id' | 'name' | 'display_name' | 'unit'>> = [];
      if (productIds.length > 0) {
        const productsResult = await supabase.from('products').select('id, name, display_name, unit')
          .eq('org_id', orgId).in('id', productIds).order('id');
        if (productsResult.error) return null;
        products = (productsResult.data ?? []) as Array<Pick<Product, 'id' | 'name' | 'display_name' | 'unit'>>;
      }
      const productsById = new Map(products.map((product) => [product.id, product]));

      /* REQ-06. Two reads keyed by THIS receipt's own lines, and neither of them widens anything:
         `purchase_order_items` is the same table `/orders` reads for the same roles, addressed by
         the ids the lines already carry, and `credit_requests` is `/credits`, whose route admits a
         superset of this screen's roles. A row either role cannot see simply does not come back,
         and the screen then states nothing rather than a zero. */
      const orderItemIds = [...new Set(rawLines.map(({ order_item_id }) => order_item_id).filter(Boolean))];
      const lineIds = rawLines.map(({ id }) => id);
      const [orderItemsResult, creditsResult] = await Promise.all([
        orderItemIds.length > 0
          ? supabase.from('purchase_order_items').select('id, order_id, product_id, qty, unit_price, received_qty')
            .in('id', orderItemIds).order('id')
          : Promise.resolve({ data: [], error: null }),
        lineIds.length > 0
          ? supabase.from('credit_requests').select('id, number, amount, currency, status, receipt_item_id')
            .eq('org_id', orgId).in('receipt_item_id', lineIds).order('number')
          : Promise.resolve({ data: [], error: null }),
      ]);
      const orderItemsById = new Map(((orderItemsResult.data ?? []) as PurchaseOrderItem[])
        .map((item) => [item.id, item]));

      return {
        receipt,
        order,
        supplier: supplierResult.data as { id: string; name: string },
        lines: rawLines.map((line) => {
          const item = orderItemsById.get(line.order_item_id) ?? null;
          return {
            ...line,
            product: productsById.get(line.product_id) ?? null,
            ordered: item ? item.qty : null,
            // Never negative: an over-receipt is a different finding and this figure must not
            // report one as a debt owed the other way.
            outstanding: item ? Math.max(item.qty - item.received_qty, 0) : null,
          };
        }),
        credits: (creditsResult.data ?? []) as ReceiptCredit[],
      };
    } catch {
      // Missing and cross-tenant rows deliberately share one non-disclosing state.
      return null;
    }
  }, [receiptId, orgId]);

  if (loading) return <RecordSkeleton />;
  if (!data) {
    return <div className="max-w-2xl" data-testid="receipt-detail-unavailable"><ErrorNote message={t(UNAVAILABLE_KEY)} /></div>;
  }

  const { receipt, order, supplier, lines, credits } = data;
  /**
   * G1, finding 9. This screen never said the word "זיכוי", and it is where somebody stands after
   * marking goods damaged. The automatic credit fires on missing/partial only (0023:1619,:1638),
   * so a damaged line produced nothing and said nothing — while /credits told the reader that
   * credits "open from the receiving screen". The sentence appears only when such a line exists,
   * and it states the route that works today. Whether damaged goods should open a credit
   * automatically stays a business decision (OPEN-DECISIONS #49).
   */
  const unsettledLines = lines.filter((line) => line.status === 'damaged' || line.status === 'returned');
  return (
    <div className="max-w-3xl space-y-4" data-testid="receipt-detail">
      {/* G1, finding 14. This is the durable second entrance to the linked invoice form; it keeps
          the order and receipt context that drives three-way matching. */}
      <RecordHeader
        breadcrumbs={<Breadcrumbs items={[{ label: t('receiptDetail.receivingCrumb'), to: '/receiving' }, { label: t('receiptDetail.receiptNumberCrumb', { number: receipt.number }) }]} />}
        title={<span data-testid="receipt-detail-number">{t('receiptDetail.text')} <span className="num">#{receipt.number}</span></span>}
        status={<StatusBadge meta={RECEIPT_STATUS[receipt.status]} />}
        meta={t('receiptDetail.meta', { supplier: supplier.name, date: fmtDate(receipt.received_at) })}
        primaryAction={canOpenOrder && (
          /* Retargeted from /invoices/new (G1, 10.08.2026): an invoice is received, not entered. */
          <Link className="btn-primary inline-flex" to="/documents">
            <FileText size={ICON.sm} aria-hidden="true" /> {t('receiptDetail.uploadInvoiceReceived')}
          </Link>
        )} />

      <Card as="section" aria-labelledby="receipt-details-title">
        <h2 id="receipt-details-title" className="section-title">{t('receiptDetail.text_2')}</h2>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">{t('receiptDetail.text_3')}</dt>
            <dd className="mt-0.5 num" data-testid="receipt-detail-date">{fmtDate(receipt.received_at)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t('receiptDetail.text_4')}</dt>
            <dd className="mt-0.5 font-medium" data-testid="receipt-detail-supplier">{supplier.name}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t('receiptDetail.text_5')}</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2">
              {canOpenOrder
                ? <Link className="link inline-flex min-h-11 items-center" to={`/orders/${order.id}`} data-testid="receipt-detail-order">{t('receiptDetail.orderWord')} <span className="num">#{order.number}</span></Link>
                : <span data-testid="receipt-detail-order">{t('receiptDetail.text_6')} <span className="num">#{order.number}</span></span>}
              <StatusBadge meta={PO_STATUS[order.status]} />
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">{t('receiptDetail.text_7')}</dt>
            <dd className="mt-0.5"><StatusBadge meta={RECEIPT_STATUS[receipt.status]} /></dd>
          </div>
        </dl>
        {receipt.notes && <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-ink-soft">{t('receiptDetail.notesLabel')} {receipt.notes}</div>}
        {unsettledLines.length > 0 && (
          <div className="mt-3">
            <Note tone="await">
              <span>
                <span className="num">{unsettledLines.length}</span> {t('receiptDetail.unsettledLead')}
                {t('receiptDetail.text_8')}
              </span>
            </Note>
          </div>
        )}
        {/* REQ-06. The money the shortfall already put in motion, on the document that caused it.
            A partial or missing line is the ONE case in which the product raises a credit by
            itself (`0023:1619,:1638`), and the receipt said nothing about it — so the reader met
            the 42.00 ILS the supplier owes back only on a screen they had no reason to open.
            Rendered only when such a credit exists: a heading over an empty list would announce
            money nobody is owed. */}
        {credits.length > 0 && (
          <div className="mt-3">
            <Note tone="await">
              <span className="min-w-0 flex-1">
                {t('receiptDetail.creditsOpenedLead')}
                <ul className="mt-1 space-y-1">
                  {credits.map((credit) => (
                    <li key={credit.id}>
                      <Link className="link inline-flex min-h-11 items-center gap-1" to={`/credits?id=${credit.id}`}>
                        {t('receiptDetail.creditWord')} <span className="num">#{credit.number}</span>
                        <span className="num">{fmtMoneyExact(credit.amount, credit.currency)}</span>
                      </Link>
                      {' · '}<StatusBadge meta={CREDIT_STATUS[credit.status]} />
                    </li>
                  ))}
                </ul>
              </span>
            </Note>
          </div>
        )}
      </Card>

      <Card as="section" className="space-y-3" aria-labelledby="receipt-documents-title">
        <div>
          <h2 id="receipt-documents-title" className="section-title">{t('receiptDetail.text_9')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('receiptDetail.text_10')}</p>
        </div>
        <OfflineQueueStatus />
        <DocumentList entityType="goods_receipt" entityId={receipt.id} capture />
      </Card>

      <section className="card overflow-hidden" aria-labelledby="receipt-lines-title">
        <div className="border-b border-line-soft px-4 py-3">
          <h2 id="receipt-lines-title" className="section-title">{t('receiptDetail.text_11')}</h2>
        </div>
        {lines.length === 0 ? (
          <EmptyState title={t('receiptDetail.title')} />
        ) : (
          <ul className="divide-y divide-line-soft" data-testid="receipt-detail-lines">
            {lines.map((line) => (
              <li key={line.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words font-medium text-ink-body"><bdi>{line.product ? productLabel(line.product) : t('receiptDetail.productLabel')}</bdi></h3>
                    {/* REQ-06. "1 קרטון" alone is a figure with nothing to measure it against.
                        The ordered quantity is printed beside it whenever the order line came
                        back, and the remainder only when the ORDER is genuinely still owed
                        something — a "נותר 0" on a whole delivery would be noise, and a remainder
                        printed where the order line could not be read would be a claim about
                        data this screen did not receive. */}
                    <p className="mt-1 text-sm text-ink-muted">
                      {t('receiptDetail.quantityReceived')} <span className="num font-medium text-ink-mid">{formatQuantity(line.qty_received, line.product?.unit, locale)}</span>
                      {line.ordered != null && (
                        <> · {t('receiptDetail.quantityOrdered')} <span className="num text-ink-mid">{formatQuantity(line.ordered, line.product?.unit, locale)}</span></>
                      )}
                      {line.outstanding != null && line.outstanding > 0 && (
                        <> · {t('receiptDetail.quantityOutstanding')} <span className="num font-medium text-await-fg">{formatQuantity(line.outstanding, line.product?.unit, locale)}</span></>
                      )}
                    </p>
                  </div>
                  <StatusBadge meta={RECEIPT_LINE_STATUS[line.status]} />
                </div>
                {line.notes && <p className="mt-2 text-sm text-ink-soft">{t('receiptDetail.lineNoteLabel')} {line.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
