import { useEffect, useMemo, useState } from 'react';
import { fmtDate, fmtMoneyExact, formatQuantity } from '../lib/format';
import {
  PortalError,
  resolvePortalLink,
  submitPortalProposal,
  tokenFromLocation,
  type PortalProposalInput,
  type PortalSnapshotItem,
  type PortalView,
} from './api';

// One order, one token, one decision. The portal renders the snapshot the business issued —
// raw supplier-facing wording, snapshot prices — and lets the supplier either approve the
// order as sent or propose structured changes per line. It cannot see anything else, and it
// cannot change the order: a proposal is evidence the business decides on.

type Screen =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'locked' }
  | { kind: 'error' }
  | { kind: 'open'; view: PortalView }
  | { kind: 'submitted'; view: PortalView; justNow: boolean };

interface LineEdit {
  proposedQty: string;
  proposedPrice: string;
  unavailable: boolean;
  replacementNote: string;
}

const emptyEdit: LineEdit = { proposedQty: '', proposedPrice: '', unavailable: false, replacementNote: '' };

function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

function lineDelta(item: PortalSnapshotItem, edit: LineEdit): number {
  if (edit.unavailable) return -(item.qty * item.unit_price);
  const qty = parseAmount(edit.proposedQty) ?? item.qty;
  const price = parseAmount(edit.proposedPrice) ?? item.unit_price;
  return qty * price - item.qty * item.unit_price;
}

const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  submitted: 'ההצעה התקבלה וממתינה להחלטת העסק',
  accepted: 'ההצעה אושרה על ידי העסק',
  partially_accepted: 'ההצעה אושרה חלקית על ידי העסק',
  rejected: 'ההצעה נדחתה על ידי העסק',
};

export default function PortalApp() {
  const token = useMemo(() => tokenFromLocation(window.location.hash, window.location.search), []);
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [edits, setEdits] = useState<Record<string, LineEdit>>({});
  const [deliveryDate, setDeliveryDate] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setScreen({ kind: 'invalid' });
      return;
    }
    resolvePortalLink(token)
      .then((view) => {
        setScreen(view.state === 'submitted'
          ? { kind: 'submitted', view, justNow: false }
          : { kind: 'open', view });
      })
      .catch((error: unknown) => {
        if (error instanceof PortalError && error.code === 'link_invalid') setScreen({ kind: 'invalid' });
        else if (error instanceof PortalError && error.code === 'rate_limited') setScreen({ kind: 'locked' });
        else setScreen({ kind: 'error' });
      });
  }, [token]);

  if (screen.kind === 'loading') {
    return <Shell><p className="text-ink-muted">טוען את פרטי ההזמנה…</p></Shell>;
  }
  if (screen.kind === 'invalid') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-ink-strong">הקישור אינו פעיל</h1>
        <p className="mt-2 text-ink-muted">
          הקישור פג תוקף, בוטל או שגוי. יש לפנות לעסק שממנו התקבלה ההזמנה כדי לקבל קישור חדש.
        </p>
      </Shell>
    );
  }
  if (screen.kind === 'locked') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-ink-strong">הקישור ננעל זמנית</h1>
        <p className="mt-2 text-ink-muted">נרשמו יותר מדי ניסיונות. יש לנסות שוב מאוחר יותר.</p>
      </Shell>
    );
  }
  if (screen.kind === 'error') {
    return (
      <Shell>
        <h1 className="text-lg font-semibold text-ink-strong">שגיאה זמנית</h1>
        <p className="mt-2 text-ink-muted">לא ניתן לטעון את ההזמנה כרגע. יש לנסות שוב בעוד כמה דקות.</p>
      </Shell>
    );
  }

  const { view } = screen;
  const { snapshot } = view;

  if (screen.kind === 'submitted') {
    const proposal = view.proposal;
    return (
      <Shell orgName={snapshot.org_name}>
        <OrderHeader view={view} />
        <div className="card mt-4 p-4">
          <h2 className="font-semibold text-ink-strong">
            {screen.justNow ? 'התשובה נשלחה בהצלחה' : 'כבר נשלחה תשובה להזמנה זו'}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {proposal ? PROPOSAL_STATUS_LABEL[proposal.status] : 'ההזמנה אושרה כפי שנשלחה.'}
          </p>
          {proposal && proposal.total_delta !== 0 && (
            <p className="mt-1 text-sm text-ink-muted">
              הפרש כספי מוצע: <span className="num">{fmtMoneyExact(proposal.total_delta)}</span>
            </p>
          )}
        </div>
        <ItemsView items={snapshot.items} readOnly edits={edits} onEdit={() => {}} />
      </Shell>
    );
  }

  const totalDelta = snapshot.items.reduce(
    (sum, item) => sum + lineDelta(item, edits[item.order_item_id] ?? emptyEdit), 0);
  const hasChanges = deliveryDate !== '' || note.trim() !== ''
    || snapshot.items.some((item) => {
      const edit = edits[item.order_item_id] ?? emptyEdit;
      return edit.unavailable || parseAmount(edit.proposedQty) !== null
        || parseAmount(edit.proposedPrice) !== null || edit.replacementNote.trim() !== '';
    });

  const submit = async (approveAsIs: boolean) => {
    if (!token || sending) return;
    setSending(true);
    setSubmitError(null);
    const proposal: PortalProposalInput = approveAsIs
      ? { lines: snapshot.items.map((item) => ({ order_item_id: item.order_item_id, availability: 'available' })) }
      : {
          proposed_delivery_date: deliveryDate || null,
          supplier_note: note.trim() || null,
          lines: snapshot.items.map((item) => {
            const edit = edits[item.order_item_id] ?? emptyEdit;
            return {
              order_item_id: item.order_item_id,
              availability: edit.unavailable ? 'unavailable' as const : 'available' as const,
              proposed_qty: edit.unavailable ? null : parseAmount(edit.proposedQty),
              proposed_unit_price: edit.unavailable ? null : parseAmount(edit.proposedPrice),
              replacement_note: edit.unavailable ? (edit.replacementNote.trim() || null) : null,
            };
          }),
        };
    try {
      await submitPortalProposal(token, proposal);
      const refreshed = await resolvePortalLink(token).catch(() => null);
      setScreen({
        kind: 'submitted',
        view: refreshed ?? { ...view, state: 'submitted' },
        justNow: true,
      });
    } catch (error: unknown) {
      if (error instanceof PortalError && error.code === 'proposal_already_submitted') {
        const refreshed = await resolvePortalLink(token).catch(() => null);
        if (refreshed) setScreen({ kind: 'submitted', view: refreshed, justNow: false });
        else setSubmitError('כבר נשלחה תשובה להזמנה זו.');
      } else if (error instanceof PortalError && error.code === 'proposal_invalid') {
        setSubmitError('התשובה לא התקבלה. יש לבדוק את הערכים שהוזנו ולנסות שוב.');
      } else if (error instanceof PortalError && error.code === 'rate_limited') {
        setSubmitError('נרשמו יותר מדי ניסיונות. יש להמתין ולנסות שוב.');
      } else {
        setSubmitError('שגיאה זמנית בשליחה. יש לנסות שוב בעוד כמה דקות.');
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Shell orgName={snapshot.org_name}>
      <OrderHeader view={view} />

      <ItemsView
        items={snapshot.items}
        readOnly={false}
        edits={edits}
        onEdit={(id, edit) => setEdits((prev) => ({ ...prev, [id]: edit }))}
      />

      <div className="card mt-4 space-y-3 p-4">
        <div>
          <label className="label" htmlFor="portal-delivery-date">הצעה לתאריך אספקה אחר (לא חובה)</label>
          <input
            id="portal-delivery-date"
            type="date"
            className="input"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="portal-note">הערה כללית לעסק (לא חובה)</label>
          <textarea
            id="portal-note"
            className="input min-h-20"
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {totalDelta !== 0 && (
          <p className="text-sm text-ink-muted">
            סה״כ הפרש כספי מוצע: <span className="num font-medium">{fmtMoneyExact(totalDelta)}</span>
          </p>
        )}
        {submitError && (
          <p role="alert" className="text-sm text-alert-fg">{submitError}</p>
        )}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={sending}
            onClick={() => void submit(!hasChanges)}
          >
            {sending ? 'שולח…' : hasChanges ? 'שליחת השינויים המוצעים' : 'אישור ההזמנה כפי שנשלחה'}
          </button>
        </div>
        <p className="text-xs text-ink-faint">
          ניתן לשלוח תשובה אחת בלבד. לאחר השליחה העסק יבחן את התשובה ויחליט.
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children, orgName }: { children: React.ReactNode; orgName?: string }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <main className="mx-auto max-w-3xl px-4 py-6">
        <header className="mb-4">
          <p className="text-xs text-ink-faint">אישור הזמנת רכש</p>
          {orgName && <p className="text-lg font-semibold text-ink-strong"><bdi>{orgName}</bdi></p>}
        </header>
        {children}
      </main>
    </div>
  );
}

function OrderHeader({ view }: { view: PortalView }) {
  const { snapshot } = view;
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink-strong">
          הזמנה <span className="num">#{snapshot.order_number}</span>
          {snapshot.revision_number > 1 && (
            <span className="ms-2 badge bg-action-wash text-ink-mid">
              גרסה <span className="num">{snapshot.revision_number}</span>
            </span>
          )}
        </h1>
        <p className="text-sm text-ink-muted">
          בתוקף עד <span className="num">{fmtDate(view.expires_at)}</span>
        </p>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
        {snapshot.supplier_name && (
          <div className="flex gap-1">
            <dt className="text-ink-faint">לכבוד:</dt>
            <dd className="text-ink-body"><bdi>{snapshot.supplier_name}</bdi></dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt className="text-ink-faint">תאריך אספקה מבוקש:</dt>
          <dd className="text-ink-body num">{fmtDate(snapshot.expected_date)}</dd>
        </div>
      </dl>
      {snapshot.notes && (
        <p className="mt-2 text-sm text-ink-muted"><bdi>{snapshot.notes}</bdi></p>
      )}
    </div>
  );
}

function ItemsView({
  items, readOnly, edits, onEdit,
}: {
  items: PortalSnapshotItem[];
  readOnly: boolean;
  edits: Record<string, LineEdit>;
  onEdit: (id: string, edit: LineEdit) => void;
}) {
  return (
    <section className="mt-4" aria-label="שורות ההזמנה">
      <ul className="space-y-3">
        {items.map((item) => {
          const edit = edits[item.order_item_id] ?? emptyEdit;
          const delta = lineDelta(item, edit);
          return (
            <li key={item.order_item_id} className={`card p-4 ${edit.unavailable ? 'opacity-80' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium text-ink-strong"><bdi>{item.product_name}</bdi></p>
                <p className="text-sm text-ink-muted num whitespace-nowrap">
                  {formatQuantity(item.qty, item.unit)} × {fmtMoneyExact(item.unit_price)}
                </p>
              </div>
              {!readOnly && (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label" htmlFor={`qty-${item.order_item_id}`}>כמות מוצעת</label>
                      <input
                        id={`qty-${item.order_item_id}`}
                        className="input num"
                        inputMode="decimal"
                        placeholder={String(item.qty)}
                        disabled={edit.unavailable}
                        value={edit.proposedQty}
                        onChange={(e) => onEdit(item.order_item_id, { ...edit, proposedQty: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="label" htmlFor={`price-${item.order_item_id}`}>מחיר יחידה מוצע</label>
                      <input
                        id={`price-${item.order_item_id}`}
                        className="input num"
                        inputMode="decimal"
                        placeholder={String(item.unit_price)}
                        disabled={edit.unavailable}
                        value={edit.proposedPrice}
                        onChange={(e) => onEdit(item.order_item_id, { ...edit, proposedPrice: e.target.value })}
                      />
                    </div>
                  </div>
                  <label className="flex min-h-11 items-center gap-2 text-sm text-ink-body">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={edit.unavailable}
                      onChange={(e) => onEdit(item.order_item_id, { ...edit, unavailable: e.target.checked })}
                    />
                    הפריט אינו זמין
                  </label>
                  {edit.unavailable && (
                    <div>
                      <label className="label" htmlFor={`replacement-${item.order_item_id}`}>
                        הצעת תחליף (טקסט חופשי, לא חובה)
                      </label>
                      <input
                        id={`replacement-${item.order_item_id}`}
                        className="input"
                        maxLength={500}
                        value={edit.replacementNote}
                        onChange={(e) => onEdit(item.order_item_id, { ...edit, replacementNote: e.target.value })}
                      />
                    </div>
                  )}
                  {delta !== 0 && (
                    <p className="text-xs text-ink-muted">
                      הפרש לשורה: <span className="num">{fmtMoneyExact(delta)}</span>
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
