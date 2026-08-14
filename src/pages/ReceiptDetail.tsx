import { Link, useParams } from 'react-router';
import { FileText } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { Breadcrumbs, EmptyState, ErrorNote, Note, RecordHeader, RecordSkeleton, StatusBadge } from '../components/ui';
import { DocumentList } from '../components/FileUpload';
import OfflineQueueStatus from '../components/OfflineQueueStatus';
import { fmtDate, formatQuantity } from '../lib/format';
import { isUuid } from '../lib/invoiceLinkedContext';
import { PO_STATUS, RECEIPT_LINE_STATUS, RECEIPT_STATUS } from '../lib/status';
import { supabase } from '../lib/supabase';
import type { GoodsReceipt, GoodsReceiptItem, Product, PurchaseOrder } from '../lib/types';
import { useQuery } from '../lib/useQuery';

type ReceiptRow = Pick<GoodsReceipt, 'id' | 'number' | 'order_id' | 'status' | 'received_at' | 'notes'>;
type ReceiptOrder = Pick<PurchaseOrder, 'id' | 'number' | 'supplier_id' | 'status'>;
type ReceiptLine = Pick<GoodsReceiptItem, 'id' | 'product_id' | 'qty_received' | 'status' | 'notes'> & {
  product: Pick<Product, 'id' | 'name' | 'unit'> | null;
};

interface ReceiptDetailData {
  receipt: ReceiptRow;
  order: ReceiptOrder;
  supplier: { id: string; name: string };
  lines: ReceiptLine[];
}

const UNAVAILABLE_MESSAGE = 'לא ניתן לטעון את הקבלה. ייתכן שהרשומה אינה קיימת או שאין לך הרשאה לצפות בה.';

export default function ReceiptDetail() {
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
        supabase.from('goods_receipt_items').select('id, product_id, qty_received, status, notes')
          .eq('receipt_id', receipt.id).eq('org_id', orgId).order('id'),
      ]);
      if (orderResult.error || !orderResult.data || linesResult.error) return null;
      const order = orderResult.data as ReceiptOrder;
      const rawLines = (linesResult.data ?? []) as Array<Pick<GoodsReceiptItem, 'id' | 'product_id' | 'qty_received' | 'status' | 'notes'>>;

      const supplierResult = await supabase.from('suppliers').select('id, name')
        .eq('id', order.supplier_id).eq('org_id', orgId).maybeSingle();
      if (supplierResult.error || !supplierResult.data) return null;

      const productIds = [...new Set(rawLines.map(({ product_id }) => product_id))];
      let products: Array<Pick<Product, 'id' | 'name' | 'unit'>> = [];
      if (productIds.length > 0) {
        const productsResult = await supabase.from('products').select('id, name, unit')
          .eq('org_id', orgId).in('id', productIds).order('id');
        if (productsResult.error) return null;
        products = (productsResult.data ?? []) as Array<Pick<Product, 'id' | 'name' | 'unit'>>;
      }
      const productsById = new Map(products.map((product) => [product.id, product]));

      return {
        receipt,
        order,
        supplier: supplierResult.data as { id: string; name: string },
        lines: rawLines.map((line) => ({ ...line, product: productsById.get(line.product_id) ?? null })),
      };
    } catch {
      // Missing and cross-tenant rows deliberately share one non-disclosing state.
      return null;
    }
  }, [receiptId, orgId]);

  if (loading) return <RecordSkeleton />;
  if (!data) {
    return <div className="max-w-2xl" data-testid="receipt-detail-unavailable"><ErrorNote message={UNAVAILABLE_MESSAGE} /></div>;
  }

  const { receipt, order, supplier, lines } = data;
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
        breadcrumbs={<Breadcrumbs items={[{ label: 'קבלת סחורה', to: '/receiving' }, { label: `קבלה #${receipt.number}` }]} />}
        title={<span className="num" data-testid="receipt-detail-number">קבלה #{receipt.number}</span>}
        status={<StatusBadge meta={RECEIPT_STATUS[receipt.status]} />}
        meta={`${supplier.name} · התקבלה ב-${fmtDate(receipt.received_at)}`}
        primaryAction={canOpenOrder && (
          /* Retargeted from /invoices/new (G1, 10.08.2026): an invoice is received, not entered. */
          <Link className="btn-primary inline-flex" to="/documents">
            <FileText size={15} aria-hidden="true" /> העלאת החשבונית שהתקבלה
          </Link>
        )} />

      <section className="card card-pad" aria-labelledby="receipt-details-title">
        <h2 id="receipt-details-title" className="section-title">פרטי הקבלה</h2>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-ink-muted">תאריך קבלה</dt>
            <dd className="mt-0.5 num" data-testid="receipt-detail-date">{fmtDate(receipt.received_at)}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">ספק</dt>
            <dd className="mt-0.5 font-medium" data-testid="receipt-detail-supplier">{supplier.name}</dd>
          </div>
          <div>
            <dt className="text-ink-muted">הזמנת רכש</dt>
            <dd className="mt-0.5 flex flex-wrap items-center gap-2">
              {canOpenOrder
                ? <Link className="link num inline-flex min-h-11 items-center" to={`/orders/${order.id}`} data-testid="receipt-detail-order">הזמנה #{order.number}</Link>
                : <span className="num" data-testid="receipt-detail-order">הזמנה #{order.number}</span>}
              <StatusBadge meta={PO_STATUS[order.status]} />
            </dd>
          </div>
          <div>
            <dt className="text-ink-muted">מצב הקבלה</dt>
            <dd className="mt-0.5"><StatusBadge meta={RECEIPT_STATUS[receipt.status]} /></dd>
          </div>
        </dl>
        {receipt.notes && <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2 text-sm text-ink-soft">הערות: {receipt.notes}</div>}
        {unsettledLines.length > 0 && (
          <div className="mt-3">
            <Note tone="await">
              <span>
                <span className="num">{unsettledLines.length}</span> פריטים סומנו כפגומים או שהוחזרו. עבורם לא נפתחה דרישת זיכוי אוטומטית —
                זיכוי אוטומטי נפתח לחוסר בכמות בלבד. דרישת זיכוי עליהם נפתחת מתוך החשבונית של הספק, לאחר שתיקלט למערכת.
              </span>
            </Note>
          </div>
        )}
      </section>

      <section className="card card-pad space-y-3" aria-labelledby="receipt-documents-title">
        <div>
          <h2 id="receipt-documents-title" className="section-title">מסמכי הקבלה</h2>
          <p className="mt-1 text-sm text-ink-muted">אפשר לצלם גם ללא חיבור; הקובץ נשמר במכשיר ונשלח כשהרשת חוזרת.</p>
        </div>
        <OfflineQueueStatus />
        <DocumentList entityType="goods_receipt" entityId={receipt.id} capture />
      </section>

      <section className="card overflow-hidden" aria-labelledby="receipt-lines-title">
        <div className="border-b border-line-soft px-4 py-3">
          <h2 id="receipt-lines-title" className="section-title">פריטי הקבלה</h2>
        </div>
        {lines.length === 0 ? (
          <EmptyState title="לא נמצאו פריטים בקבלה" />
        ) : (
          <ul className="divide-y divide-line-soft" data-testid="receipt-detail-lines">
            {lines.map((line) => (
              <li key={line.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="break-words font-medium text-ink-body">{line.product?.name ?? 'מוצר לא זמין'}</h3>
                    <p className="mt-1 text-sm text-ink-muted">
                      כמות שהתקבלה: <span className="num font-medium text-ink-mid">{formatQuantity(line.qty_received, line.product?.unit)}</span>
                    </p>
                  </div>
                  <StatusBadge meta={RECEIPT_LINE_STATUS[line.status]} />
                </div>
                {line.notes && <p className="mt-2 text-sm text-ink-soft">הערה: {line.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
