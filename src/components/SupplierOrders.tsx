import { useState } from 'react';
import { CheckCircle2, ClipboardList } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toHebrewError } from '../lib/errors';
import { fmtDate, fmtDateTime, fmtMoneyExact } from '../lib/format';
import { PO_STATUS } from '../lib/status';
import type { PoStatus } from '../lib/types';
import { Modal, Note, StatusBadge, useToast } from './ui';

export interface SupplierPortalOrderItem {
  id: string;
  product_name: string;
  unit: string;
  supplier_sku: string | null;
  qty: number;
  unit_price: number;
  received_qty: number;
}

export interface SupplierPortalOrder {
  id: string;
  number: number;
  status: PoStatus;
  expected_date: string | null;
  sent_at: string;
  confirmed_at: string | null;
  items: SupplierPortalOrderItem[];
}

export function SupplierOrders({ orders, canWrite, onChanged }: {
  orders: SupplierPortalOrder[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [confirming, setConfirming] = useState<SupplierPortalOrder | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirmOrder() {
    if (!confirming) return;
    setBusy(true);
    const result = await supabase.rpc('transition_purchase_order_status', {
      p_purchase_order_id: confirming.id,
      p_target_status: 'confirmed',
      p_reason: 'אישור קבלת הזמנה בפורטל הספק',
      p_confirmation_note: note.trim() || null,
      p_expected_date: null,
    });
    setBusy(false);
    if (result.error) {
      toast(toHebrewError(result.error.message), 'error');
      return;
    }
    setConfirming(null);
    setNote('');
    toast('קבלת ההזמנה אושרה');
    onChanged();
  }

  return (
    <section className="card overflow-hidden" aria-labelledby="supplier-orders-heading">
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
        <ClipboardList size={18} className="text-action" aria-hidden="true" />
        <div>
          <h2 id="supplier-orders-heading" className="section-title">הזמנות הרכש שלי</h2>
          <p className="mt-0.5 text-xs text-ink-muted">רק הזמנות שנשלחו אליך מוצגות כאן</p>
        </div>
      </div>

      {orders.length ? (
        <div className="divide-y divide-line-soft">
          {orders.map((order) => {
            const total = order.items.reduce((sum, item) => sum + item.qty * item.unit_price, 0);
            return (
              <article key={order.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="font-semibold text-ink num">הזמנה #{order.number}</div>
                  <StatusBadge meta={PO_STATUS[order.status]} />
                  <div className="text-xs text-ink-muted sm:text-sm">
                    נשלחה {fmtDateTime(order.sent_at)}
                    {order.expected_date && <> · אספקה מבוקשת {fmtDate(order.expected_date)}</>}
                  </div>
                  <div className="ms-auto text-sm font-semibold text-ink num">{fmtMoneyExact(total)}</div>
                </div>

                <details className="mt-3">
                  <summary className="link w-fit cursor-pointer">צפייה בפריטי ההזמנה</summary>
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full min-w-[640px]">
                      <thead className="border-b border-line-soft bg-surface-sunken">
                        <tr>
                          <th scope="col" className="th">מוצר</th>
                          <th scope="col" className="th">מק״ט ספק</th>
                          <th scope="col" className="th">יחידה</th>
                          <th scope="col" className="th">כמות</th>
                          <th scope="col" className="th">מחיר יחידה</th>
                          <th scope="col" className="th">סה״כ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line-soft">
                        {order.items.map((item) => (
                          <tr key={item.id}>
                            <td className="td font-medium text-ink-body">{item.product_name}</td>
                            <td className="td num">{item.supplier_sku ?? '—'}</td>
                            <td className="td">{item.unit}</td>
                            <td className="td num">{item.qty}</td>
                            <td className="td num">{fmtMoneyExact(item.unit_price)}</td>
                            <td className="td num">{fmtMoneyExact(item.qty * item.unit_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>

                {order.confirmed_at && (
                  <Note tone="done" className="mt-3">
                    <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
                    קבלת ההזמנה אושרה ב־{fmtDateTime(order.confirmed_at)}
                  </Note>
                )}
                {canWrite && order.status === 'sent' && (
                  <button type="button" className="btn-primary mt-3" onClick={() => setConfirming(order)}>
                    <CheckCircle2 size={15} aria-hidden="true" /> אישור קבלת ההזמנה
                  </button>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="px-4 py-6 text-sm text-ink-muted">עדיין לא נשלחו אליך הזמנות רכש.</p>
      )}

      <Modal open={!!confirming} onClose={() => { setConfirming(null); setNote(''); }}
        title={confirming ? `אישור קבלת הזמנה #${confirming.number}` : 'אישור קבלת הזמנה'}
        busy={busy} statusMessage={busy ? 'שומר את האישור' : undefined}>
        <p className="text-sm text-ink-soft">
          האישור מציין שהזמנת הרכש התקבלה אצלך. הוא אינו מאשר אספקת סחורה ואינו משנה את תאריך האספקה.
        </p>
        <label className="label mt-4" htmlFor="supplier-order-confirmation-note">הערה (לא חובה)</label>
        <input id="supplier-order-confirmation-note" className="input" value={note}
          onChange={(event) => setNote(event.target.value)} />
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy}
            onClick={() => { setConfirming(null); setNote(''); }}>ביטול</button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void confirmOrder()}>
            <CheckCircle2 size={15} aria-hidden="true" /> אישור
          </button>
        </div>
      </Modal>
    </section>
  );
}
