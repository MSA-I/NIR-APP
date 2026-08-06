import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { EmptyState, ErrorNote, PageLoader, StatusBadge } from '../components/ui';
import { fmtDate, fmtNum } from '../lib/format';
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
  const canOpenOrder = profile?.role === 'owner' || profile?.role === 'office' || profile?.role === 'kitchen';

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

  if (loading) return <PageLoader />;
  if (!data) {
    return <div className="max-w-2xl" data-testid="receipt-detail-unavailable"><ErrorNote message={UNAVAILABLE_MESSAGE} /></div>;
  }

  const { receipt, order, supplier, lines } = data;
  return (
    <div className="max-w-3xl space-y-4" data-testid="receipt-detail">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="page-title" data-testid="receipt-detail-number">
            <span className="num">קבלה #{receipt.number}</span>
          </h1>
          <StatusBadge meta={RECEIPT_STATUS[receipt.status]} />
        </div>
        <p className="mt-1 text-sm text-ink-muted">{supplier.name} · התקבלה ב-{fmtDate(receipt.received_at)}</p>
      </header>

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
                      כמות שהתקבלה: <span className="num font-medium text-ink-mid">{fmtNum(line.qty_received)}</span>{line.product?.unit ? ` ${line.product.unit}` : ''}
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
