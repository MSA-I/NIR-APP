import { useEffect, useMemo, useState } from 'react';
import {
  PortalError,
  resolvePortalLink,
  submitPortalProposal,
  tokenFromLocation,
  type PortalProposalInput,
  type PortalSnapshotItem,
  type PortalView,
} from './api';
import {
  formatPortalDate,
  formatPortalMoney,
  formatPortalQuantity,
  portalLocaleFromLocation,
  PORTAL_COPY,
  type PortalLocale,
} from './i18n';

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

export default function PortalApp() {
  const token = useMemo(() => tokenFromLocation(window.location.hash, window.location.search), []);
  const [locale, setLocale] = useState<PortalLocale>(() =>
    portalLocaleFromLocation(window.location.search, window.navigator.language));
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' });
  const [edits, setEdits] = useState<Record<string, LineEdit>>({});
  const [deliveryDate, setDeliveryDate] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const copy = PORTAL_COPY[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = locale === 'he' ? 'rtl' : 'ltr';
    document.title = copy.pageTitle;
  }, [copy.pageTitle, locale]);

  const switchLocale = () => {
    const next: PortalLocale = locale === 'he' ? 'en' : 'he';
    const url = new URL(window.location.href);
    url.searchParams.set('lang', next);
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
    setLocale(next);
    setSubmitError(null);
  };

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
    return <Shell locale={locale} onSwitchLocale={switchLocale}><p className="text-ink-muted">{copy.loading}</p></Shell>;
  }
  if (screen.kind === 'invalid') {
    return (
      <Shell locale={locale} onSwitchLocale={switchLocale}>
        <h1 className="text-lg font-semibold text-ink-strong">{copy.invalidTitle}</h1>
        <p className="mt-2 text-ink-muted">{copy.invalidBody}</p>
      </Shell>
    );
  }
  if (screen.kind === 'locked') {
    return (
      <Shell locale={locale} onSwitchLocale={switchLocale}>
        <h1 className="text-lg font-semibold text-ink-strong">{copy.lockedTitle}</h1>
        <p className="mt-2 text-ink-muted">{copy.lockedBody}</p>
      </Shell>
    );
  }
  if (screen.kind === 'error') {
    return (
      <Shell locale={locale} onSwitchLocale={switchLocale}>
        <h1 className="text-lg font-semibold text-ink-strong">{copy.errorTitle}</h1>
        <p className="mt-2 text-ink-muted">{copy.errorBody}</p>
      </Shell>
    );
  }

  const { view } = screen;
  const { snapshot } = view;

  if (screen.kind === 'submitted') {
    const proposal = view.proposal;
    return (
      <Shell orgName={snapshot.org_name} locale={locale} onSwitchLocale={switchLocale}>
        <OrderHeader view={view} locale={locale} />
        <div className="card mt-4 p-4">
          <h2 className="font-semibold text-ink-strong">
            {screen.justNow ? copy.sentNow : copy.alreadySent}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {proposal ? copy.proposalStatus[proposal.status] : copy.approvedAsSent}
          </p>
          {proposal && proposal.total_delta !== 0 && (
            <p className="mt-1 text-sm text-ink-muted">
              {copy.proposedMoneyDelta} <span className="num">{formatPortalMoney(locale, proposal.total_delta)}</span>
            </p>
          )}
        </div>
        <ItemsView items={snapshot.items} readOnly edits={edits} onEdit={() => {}} locale={locale} />
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
        else setSubmitError(copy.submitAlready);
      } else if (error instanceof PortalError && error.code === 'proposal_invalid') {
        setSubmitError(copy.submitInvalid);
      } else if (error instanceof PortalError && error.code === 'rate_limited') {
        setSubmitError(copy.submitRateLimited);
      } else {
        setSubmitError(copy.submitTemporary);
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Shell orgName={snapshot.org_name} locale={locale} onSwitchLocale={switchLocale}>
      <OrderHeader view={view} locale={locale} />

      <ItemsView
        items={snapshot.items}
        readOnly={false}
        edits={edits}
        onEdit={(id, edit) => setEdits((prev) => ({ ...prev, [id]: edit }))}
        locale={locale}
      />

      <div className="card mt-4 space-y-3 p-4">
        <div>
          <label className="label" htmlFor="portal-delivery-date">{copy.deliveryDateLabel}</label>
          <input
            id="portal-delivery-date"
            type="date"
            className="input"
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="portal-note">{copy.noteLabel}</label>
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
            {copy.totalDelta} <span className="num font-medium">{formatPortalMoney(locale, totalDelta)}</span>
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
            {sending ? copy.sending : hasChanges ? copy.sendChanges : copy.approveAsSent}
          </button>
        </div>
        <p className="text-xs text-ink-faint">{copy.oneResponse}</p>
      </div>
    </Shell>
  );
}

function Shell({ children, orgName, locale, onSwitchLocale }: {
  children: React.ReactNode;
  orgName?: string;
  locale: PortalLocale;
  onSwitchLocale: () => void;
}) {
  const copy = PORTAL_COPY[locale];
  return (
    <div className="min-h-dvh bg-canvas" dir={locale === 'he' ? 'rtl' : 'ltr'}>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <header className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-ink-faint">{copy.pageTitle}</p>
            {orgName && <p className="text-lg font-semibold text-ink-strong"><bdi>{orgName}</bdi></p>}
          </div>
          <button
            type="button"
            className="btn-secondary min-h-11 shrink-0 px-3 py-2 text-sm"
            aria-label={copy.switchLanguageLabel}
            lang={locale === 'he' ? 'en' : 'he'}
            onClick={onSwitchLocale}
          >
            {copy.switchLanguage}
          </button>
        </header>
        {children}
      </main>
    </div>
  );
}

function OrderHeader({ view, locale }: { view: PortalView; locale: PortalLocale }) {
  const { snapshot } = view;
  const copy = PORTAL_COPY[locale];
  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-lg font-semibold text-ink-strong">
          {copy.order} <span className="num">#{snapshot.order_number}</span>
          {snapshot.revision_number > 1 && (
            <span className="ms-2 badge bg-action-wash text-ink-mid">
              {copy.revision} <span className="num">{snapshot.revision_number}</span>
            </span>
          )}
        </h1>
        <p className="text-sm text-ink-muted">
          {copy.validUntil} <span className="num">{formatPortalDate(locale, view.expires_at)}</span>
        </p>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
        {snapshot.supplier_name && (
          <div className="flex gap-1">
            <dt className="text-ink-faint">{copy.addressee}</dt>
            <dd className="text-ink-body"><bdi>{snapshot.supplier_name}</bdi></dd>
          </div>
        )}
        <div className="flex gap-1">
          <dt className="text-ink-faint">{copy.requestedDelivery}</dt>
          <dd className="text-ink-body num">{formatPortalDate(locale, snapshot.expected_date)}</dd>
        </div>
      </dl>
      {snapshot.notes && (
        <p className="mt-2 text-sm text-ink-muted"><bdi>{snapshot.notes}</bdi></p>
      )}
    </div>
  );
}

function ItemsView({
  items, readOnly, edits, onEdit, locale,
}: {
  items: PortalSnapshotItem[];
  readOnly: boolean;
  edits: Record<string, LineEdit>;
  onEdit: (id: string, edit: LineEdit) => void;
  locale: PortalLocale;
}) {
  const copy = PORTAL_COPY[locale];
  return (
    <section className="mt-4" aria-label={copy.orderLines}>
      <ul className="space-y-3">
        {items.map((item) => {
          const edit = edits[item.order_item_id] ?? emptyEdit;
          const delta = lineDelta(item, edit);
          return (
            <li key={item.order_item_id} className={`card p-4 ${edit.unavailable ? 'opacity-80' : ''}`}>
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium text-ink-strong"><bdi>{item.product_name}</bdi></p>
                <p className="text-sm text-ink-muted num whitespace-nowrap">
                  {formatPortalQuantity(locale, item.qty, item.unit)} × {formatPortalMoney(locale, item.unit_price)}
                </p>
              </div>
              {!readOnly && (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="label" htmlFor={`qty-${item.order_item_id}`}>{copy.proposedQty}</label>
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
                      <label className="label" htmlFor={`price-${item.order_item_id}`}>{copy.proposedUnitPrice}</label>
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
                    {copy.unavailable}
                  </label>
                  {edit.unavailable && (
                    <div>
                      <label className="label" htmlFor={`replacement-${item.order_item_id}`}>
                        {copy.replacement}
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
                      {copy.lineDelta} <span className="num">{formatPortalMoney(locale, delta)}</span>
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
