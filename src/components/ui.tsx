import { useEffect, useId, useMemo, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Search, X, Loader2, Inbox, Bell, Check } from 'lucide-react';
import type { StatusMeta, Tone } from '../lib/status';
import { fmtMoney } from '../lib/format';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';

/* ---------- StatusBadge ---------- */
export function StatusBadge({ meta }: { meta: StatusMeta | undefined }) {
  if (!meta) return null;
  return <span className={`badge-${meta.tone}`}>{meta.label}</span>;
}

/* ---------- Spinner / loaders ---------- */
// Kept for the auth gates and for regions with no content shape worth mirroring.
// Anything that resolves into a known layout should use a Skeleton* below instead —
// a centred spinner discards the page title and collapses the height, so the whole
// screen jumps when data lands.
export function PageLoader() {
  return (
    <div className="flex items-center justify-center py-24 text-ink-faint">
      <Loader2 className="animate-spin" size={28} />
    </div>
  );
}

/* ---------- Skeletons ---------- */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

// One wrapper for every skeleton: screen readers get a single "טוען" instead of
// narrating a wall of empty boxes.
function SkeletonRegion({ children }: { children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <span className="sr-only">טוען</span>
      {children}
    </div>
  );
}

function SkeletonTitle() {
  return <Skeleton className="h-7 w-48" />;
}

/** Mirrors the DataTable shell: card → optional toolbar → header row → body rows. */
export function SkeletonTable({ rows = 8, cols = 5, title = true, toolbar = true }: {
  rows?: number; cols?: number; title?: boolean; toolbar?: boolean;
}) {
  // Varied widths so the placeholder reads as text, not as a barcode.
  const widths = ['w-32', 'w-20', 'w-28', 'w-16', 'w-24', 'w-20'];
  return (
    <SkeletonRegion>
      {title && <SkeletonTitle />}
      <div className="card overflow-hidden">
        {toolbar && (
          <div className="flex items-center gap-2 p-3 border-b border-line-soft">
            <Skeleton className="h-9 w-full max-w-xs" />
          </div>
        )}
        <div className="bg-surface-sunken border-b border-line-soft flex gap-3 px-3 py-2.5">
          {Array.from({ length: cols }, (_, i) => <Skeleton key={i} className={`h-3 ${widths[i % widths.length]}`} />)}
        </div>
        <div className="divide-y divide-line-soft">
          {Array.from({ length: rows }, (_, r) => (
            <div key={r} className="flex gap-3 px-3 py-3.5">
              {Array.from({ length: cols }, (_, c) => <Skeleton key={c} className={`h-3.5 ${widths[(r + c) % widths.length]}`} />)}
            </div>
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

/** Mirrors a row of KpiCard / stat cards. `cols` matches the grid the page uses. */
export function SkeletonCards({ count = 4, cols = 4, title = false }: {
  count?: number; cols?: 3 | 4 | 5 | 6; title?: boolean;
}) {
  const grid = { 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4', 5: 'md:grid-cols-3 xl:grid-cols-5', 6: 'md:grid-cols-4 xl:grid-cols-6' }[cols];
  return (
    <SkeletonRegion>
      {title && <SkeletonTitle />}
      <div className={`grid grid-cols-2 ${grid} gap-3`}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="card card-pad">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-24 mt-2" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** Mirrors the stacked card-button lists (Receiving, PayerQueue) — not a table. */
export function SkeletonList({ rows = 5, title = true }: { rows?: number; title?: boolean }) {
  return (
    <SkeletonRegion>
      {title && <SkeletonTitle />}
      <div className="max-w-2xl space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="card card-pad">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="flex gap-3 mt-3">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-28" />
            </div>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Inbox size={36} className="text-ink-ghost mb-3" />
      <div className="text-ink-soft font-medium">{title}</div>
      {subtitle && <div className="text-sm text-ink-muted mt-1">{subtitle}</div>}
    </div>
  );
}

/* ---------- Note (shared alert box, §4.3) ---------- */
// One box for the notice colours. `.note-*` lives in index.css so the whole system's
// success/warning/info/error boxes recolour from a single place. The four semantic tones plus
// `idle` for a neutral notice — a statement with no claim (audit round 2); `violet` is gone.
export function Note({ tone, children, className = '' }: {
  tone: 'done' | 'await' | 'alert' | 'info' | 'idle'; children: ReactNode; className?: string;
}) {
  return <div className={`note-${tone} ${className}`}>{children}</div>;
}

// Kept as a named wrapper: its ~30 call sites stay untouched and all get their colour
// from Note → .note-alert. (Text is now -on-soft/-800, was rose-700 — §3.1 fix.)
export function ErrorNote({ message }: { message: string }) {
  return <Note tone="alert">{message}</Note>;
}

/* ---------- KpiCard ---------- */
export function KpiCard({ title, value, sub, tone = 'slate', onClick }: {
  title: string; value: string; sub?: string; tone?: 'slate' | 'green' | 'amber' | 'red' | 'blue'; onClick?: () => void;
}) {
  // Public prop API (tone: slate|green|amber|red|blue) is unchanged for callers; internally each
  // maps to a semantic token utility (audit 2026-07-21). amber→await-fg (=amber-700) also lifts
  // the small-size value off the failing contrast the raw amber-600 gave.
  const toneCls = { slate: 'text-ink', green: 'text-done-fg', amber: 'text-await-fg', red: 'text-alert-fg', blue: 'text-info-fg' }[tone];
  return (
    <button onClick={onClick} disabled={!onClick}
      className="card card-pad text-start w-full card-link-hover disabled:hover:border-line disabled:hover:shadow-sm cursor-pointer disabled:cursor-default">
      <div className="text-xs font-medium text-ink-muted">{title}</div>
      {/* .num already aligns to the logical end (text-align: end, unlayered → wins); the physical
          textAlign:right + dead text-start it replaces broke the RTL rule (audit round 2). */}
      <div className={`text-xl font-bold mt-1 num ${toneCls}`} dir="ltr">{value}</div>
      {sub && <div className="text-xs text-ink-muted mt-1">{sub}</div>}
    </button>
  );
}

/* ---------- AttentionZone — dashboard "requires attention today" (Nir §1–3) ---------- */
export interface AttentionItem {
  key: string;
  label: string;
  count: number | null;      // null = cannot be measured → never rendered, never shown as 0
  amount?: number | null;    // optional ₪ figure shown at the row end
  tone: Tone;                // shared tone vocabulary (badge-* in index.css)
  to: string;                // full path incl. query string — a real <Link>, not onClick
  hint?: string;             // e.g. "3 בחומרה גבוהה"
  clearLabel?: string;       // muted "all clear" phrasing, e.g. "אין חריגים"
}

// Tone severity for ranking the active rows (audit round 2): alert loudest → idle quietest.
// `done` isn't passed by any AttentionZone caller, but it is ranked last so the map stays total
// over the Tone union (TypeScript enforces every key).
const ATTENTION_TONE_ORDER: Record<Tone, number> = { alert: 0, await: 1, info: 2, idle: 3, done: 4 };

// One row, shared by both tiers so the action rows and the muted "לידיעה" rows keep identical
// anatomy: tone badge · label (+hint) · optional ₪ · chevron. `muted` only quiets the label/amount
// weight; the badge already carries the tone's own soft colour (audit round 2).
function AttentionRow({ item, muted }: { item: AttentionItem; muted?: boolean }) {
  const measured = item.count != null;
  return (
    <li>
      <Link to={item.to} className="flex min-h-11 items-center gap-3 py-2.5 -mx-2 px-2 rounded-lg hover:bg-surface-sunken active:bg-action-wash/70 transition-colors">
        <span className={`${measured ? `badge-${item.tone}` : 'badge-idle'} num justify-center min-w-8`}>{item.count ?? '—'}</span>
        <span className="flex-1 min-w-0 truncate">
          <span className={muted ? 'text-ink-soft' : 'text-ink-body font-medium'}>{item.label}</span>
          {item.hint && <span className="text-xs text-ink-muted ms-2">{item.hint}</span>}
        </span>
        {item.amount != null && item.amount > 0 && (
          <span className={`num text-sm ${muted ? 'font-medium text-ink-soft' : 'font-semibold text-ink-mid'}`}>{fmtMoney(item.amount)}</span>
        )}
        <ChevronLeft size={16} className="text-ink-ghost shrink-0" aria-hidden="true" />
      </Link>
    </li>
  );
}

/**
 * The control-center header (Nir sections 1–3). One card, dense one-line rows. Active rows
 * (count > 0) are ranked by tone severity (alert → await → info → idle), with the caller's
 * business order kept as the tiebreaker within a tone, then split into two tiers in the card:
 *   Action — alert + await rows: what needs us today, at full weight, on top.
 *   לידיעה  — info + idle rows live in a closed native disclosure with unknown and clear
 *            rows, so ambient awareness remains available without competing with today's work.
 *   count === 0: collapsed into the same muted disclosure, so eight all-clear items don't shout
 *            as loudly as one that needs action ("calm", CLAUDE.md).
 * count === null (cannot be measured — e.g. no payment has a due date) gets a neutral "—" tier;
 * it is never silently converted to 0 and it prevents a false all-clear (CLAUDE.md:37). Rows are
 * real <Link>s, so keyboard focus,
 * middle-click and "open in new tab" all work (Nir §2: the dashboard is also a hub).
 *
 * The header count + ₪ sum reflect the ACTION tier only (audit round 2) — the honest "needs
 * action today" figure; the לידיעה rows keep their own per-row amounts and are not summed in.
 * Tone drives the grouping; no business meaning is invented here.
 *
 * `totalLabel` (audit 2026-07-21): the header ₪ sum can still mix credits (money owed to us) with
 * obligations (money we owe), so a bare figure is apples+oranges. The caller — which knows what
 * the mix means — may pass a short qualifier (e.g. "חשיפה"); we render it, we never invent it.
 */
export function AttentionZone({ items, totalLabel }: { items: AttentionItem[]; totalLabel?: string }) {
  const clear = items.filter((i) => i.count === 0);
  const unknownRows = items.filter((i) => i.count == null);
  // Rank the active rows by tone severity; the original index is the tiebreaker, so same-tone
  // rows keep the caller's business order.
  const active = items
    .filter((i) => i.count != null && i.count > 0)
    .map((item, i) => ({ item, i }))
    .sort((a, b) => ATTENTION_TONE_ORDER[a.item.tone] - ATTENTION_TONE_ORDER[b.item.tone] || a.i - b.i)
    .map((x) => x.item);
  const isAction = (i: AttentionItem) => i.tone === 'alert' || i.tone === 'await';
  const actionRows = active.filter(isAction);
  const noticeRows = active.filter((i) => !isAction(i));
  const actionTotal = actionRows.reduce((s, i) => s + (i.amount ?? 0), 0);

  return (
    <section className="card card-pad">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="section-title flex items-center gap-2"><Bell size={18} className="text-await-fg" aria-hidden="true" /> דורש טיפול היום</h2>
        <span className="text-xs text-ink-muted">
          {actionRows.length} סוגי טיפול
          {actionTotal > 0 && <> · {totalLabel ? <>{totalLabel} </> : null}<span className="num">{fmtMoney(actionTotal)}</span></>}
        </span>
      </div>

      {actionRows.length > 0 ? (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
          {actionRows.map((i) => <AttentionRow key={i.key} item={i} />)}
        </ul>
      ) : noticeRows.length === 0 && unknownRows.length === 0 ? (
        <div className="text-sm text-done-fg py-1">אין משימות דחופות כרגע</div>
      ) : null}

      {(noticeRows.length > 0 || unknownRows.length > 0 || clear.length > 0) && (
        <details className="group mt-2 border-t border-line-soft">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm text-ink-muted hover:bg-surface-sunken active:bg-action-wash/70 focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
            <ChevronLeft size={16} className="shrink-0 transition-transform group-open:-rotate-90" aria-hidden="true" />
            <span className="font-medium text-ink-soft">מידע נוסף</span>
            <span className="num ms-auto">{noticeRows.length + unknownRows.length + clear.length}</span>
          </summary>

          {noticeRows.length > 0 && (
            <div className="pt-2">
              <div className="text-xs font-medium text-ink-muted mb-1">לידיעה</div>
              <ul className="divide-y divide-line-soft">
                {noticeRows.map((i) => <AttentionRow key={i.key} item={i} muted />)}
              </ul>
            </div>
          )}

          {unknownRows.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line-soft">
              <div className="text-xs font-medium text-ink-muted mb-1">לא ניתן למדידה</div>
              <ul className="divide-y divide-line-soft">
                {unknownRows.map((i) => <AttentionRow key={i.key} item={i} muted />)}
              </ul>
            </div>
          )}

          {clear.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line-soft flex flex-wrap gap-x-4 gap-y-1.5 pb-1 text-xs text-ink-muted">
              {clear.map((i) => (
                <span key={i.key} className="inline-flex items-center gap-1"><Check size={13} className="text-done-solid shrink-0" aria-hidden="true" /> {i.clearLabel ?? i.label}</span>
              ))}
            </div>
          )}
        </details>
      )}
    </section>
  );
}

/* ---------- TaskLine — role-routed queue row (promoted from Dashboard, now a <Link>) ---------- */
export function TaskLine({ label, count, to }: { label: string; count: number; to: string }) {
  return (
    <li>
      <Link to={to} className="flex min-h-11 items-center justify-between -mx-2 px-2 py-1.5 rounded-lg hover:bg-surface-sunken active:bg-action-wash/70 transition-colors">
        <span className="text-ink-soft">{label}</span>
        <span className={`badge num ${count > 0 ? 'bg-action-soft text-action-on-soft' : 'bg-idle-soft text-ink-soft'}`}>{count}</span>
      </Link>
    </li>
  );
}

/* ---------- Modal ---------- */
// Selector for the elements a Tab trap and initial focus should consider (audit 2026-07-21).
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, children, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Esc to close + a Tab focus trap (audit 2026-07-21): a keyboard user must not be able to Tab
  // out of the dialog into the page behind the backdrop. Mirrors the dialog contract GlobalSearch
  // already meets (role="dialog" + aria-modal + managed focus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Move focus into the dialog on open (the panel itself, so no destructive control is pre-armed
  // and the screen reader announces the dialog by its title), and restore it to the opener on
  // close (audit 2026-07-21).
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => openerRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-shell/50 p-0 sm:p-4" onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={`bg-surface rounded-t-2xl sm:rounded-2xl shadow-xl w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} max-h-[92vh] flex flex-col focus:outline-none`}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft">
          <h3 id={titleId} className="font-semibold text-ink">{title}</h3>
          <button className="btn-ghost p-1.5! min-w-11 min-h-11" onClick={onClose} aria-label="סגירה"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'אישור', danger, requireReason, busy }: {
  open: boolean; onClose: () => void; onConfirm: (reason?: string) => void;
  title: string; message: string; confirmLabel?: string; danger?: boolean; requireReason?: boolean; busy?: boolean;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-sm text-ink-soft mb-4">{message}</p>
      {requireReason && (
        <div className="mb-4">
          <label className="label">סיבה (חובה — נרשם ביומן הביקורת)</label>
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button className="btn-secondary" onClick={onClose}>ביטול</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy || (requireReason && !reason.trim())}
          onClick={() => onConfirm(requireReason ? reason.trim() : undefined)}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- Toast ---------- */
interface Toast { id: number; message: string; tone: 'success' | 'error' }
const ToastContext = createContext<(message: string, tone?: 'success' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (message: string, tone: 'success' | 'error' = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-20 sm:bottom-6 start-1/2 -translate-x-1/2 rtl:translate-x-1/2 z-[60] flex flex-col gap-2 items-center">
        {toasts.map((t) => (
          // Each toast is its own live region (audit 2026-07-21): success is polite, an error is
          // assertive so a screen reader interrupts to surface it. role follows suit (status/alert).
          <div key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
            className={`rounded-lg px-4 py-2.5 text-sm text-white shadow-lg ${t.tone === 'success' ? 'bg-ink-body' : 'bg-alert-solid'}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- DataTable ---------- */
export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  className?: string;
  /** Mobile cards view (only read when the table opts into mobile="cards"):
      1 = headline zone, 2 = detail grid (default), 3 = hidden on mobile. */
  priority?: 1 | 2 | 3;
  /** Label before the value in the card; null = self-describing value (badge, money) —
      render the value alone. Default: the column header. */
  mobileLabel?: string | null;
}

export function DataTable<T extends { id: string }>({ rows, columns, onRowClick, searchable, searchFn, pageSize = 15, emptyTitle = 'אין נתונים להצגה', emptySubtitle, toolbar, mobile = 'scroll', mobileTitle, mobileTrailing, rowActions }: {
  rows: T[]; columns: Column<T>[]; onRowClick?: (row: T) => void;
  searchable?: boolean; searchFn?: (row: T, q: string) => boolean;
  pageSize?: number; emptyTitle?: string; emptySubtitle?: string; toolbar?: ReactNode;
  /** 'cards' stacks rows as tappable cards below md; 'scroll' (default) keeps today's
      horizontal-scroll table everywhere. Search/filter/sort/pagination are shared. */
  mobile?: 'cards' | 'scroll';
  /** Card headline; default: the first visible column's render. */
  mobileTitle?: (row: T) => ReactNode;
  /** End-aligned slot on the headline (typically the status badge). */
  mobileTrailing?: (row: T) => ReactNode;
  /** Per-row ActionMenu items: a trailing non-sortable column on desktop, an end-aligned
      trigger next to the card body on mobile. Items handle their own role gating via hidden. */
  rowActions?: (row: T) => ActionMenuItem[];
}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  const filtered = useMemo(() => {
    let r = rows;
    if (q && searchFn) r = r.filter((row) => searchFn(row, q.toLowerCase()));
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortValue) {
        r = [...r].sort((a, b) => {
          const va = col.sortValue!(a); const vb = col.sortValue!(b);
          return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
        });
      }
    }
    return r;
  }, [rows, q, sort, columns, searchFn]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const pageRows = filtered.slice(page * pageSize, (page + 1) * pageSize);
  useEffect(() => { setPage(0); }, [q, rows.length]);

  return (
    <div className="card overflow-hidden">
      {(searchable || toolbar) && (
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-line-soft">
          {searchable && (
            <div className="relative flex-1 min-w-44 max-w-xs">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint" />
              <input className="input ps-9!" placeholder="חיפוש..." value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          )}
          {toolbar}
        </div>
      )}
      {filtered.length === 0 ? (
        <EmptyState title={emptyTitle} subtitle={emptySubtitle} />
      ) : (
        <>
          {mobile === 'cards' && (
            <ul className="md:hidden divide-y divide-line-soft">
              {pageRows.map((row) => {
                const title = mobileTitle ? mobileTitle(row) : columns[0]?.render(row);
                const details = columns.filter((c, i) => (c.priority ?? 2) <= 2 && !(i === 0 && !mobileTitle));
                const body = (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-medium text-ink-body min-w-0 truncate">{title}</div>
                      {mobileTrailing && <div className="shrink-0">{mobileTrailing(row)}</div>}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-sm text-ink-mid">
                      {details.map((c) => {
                        const v = c.render(row);
                        if (v == null || v === '' ) return null;
                        const label = c.mobileLabel === undefined ? c.header : c.mobileLabel;
                        return (
                          <span key={c.key} className="inline-flex items-baseline gap-1 min-w-0">
                            {label && <span className="text-xs text-ink-muted">{label}:</span>}
                            {v}
                          </span>
                        );
                      })}
                    </div>
                  </>
                );
                // With rowActions the card body cannot stay one big <button> holding the menu —
                // button-in-button is invalid HTML — so the <li> becomes a flex row: the same
                // clickable body shrunk to flex-1 plus the menu as a sibling at the logical end.
                // Without rowActions the original markup is untouched (zero regression).
                return (
                  <li key={row.id} className={rowActions ? 'flex items-start' : undefined}>
                    {rowActions ? (
                      <>
                        {onRowClick ? (
                          <button type="button" onClick={() => onRowClick(row)}
                            className="flex-1 min-w-0 text-start p-4 row-hover cursor-pointer focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2">
                            {body}
                          </button>
                        ) : (
                          <div className="flex-1 min-w-0 p-4">{body}</div>
                        )}
                        <div className="shrink-0 pe-2 pt-3">
                          <ActionMenu items={rowActions(row)} />
                        </div>
                      </>
                    ) : onRowClick ? (
                      <button type="button" onClick={() => onRowClick(row)}
                        className="w-full text-start p-4 row-hover cursor-pointer focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2">
                        {body}
                      </button>
                    ) : (
                      <div className="p-4">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className={mobile === 'cards' ? 'overflow-x-auto hidden md:block' : 'overflow-x-auto'}>
            <table className="w-full">
              <thead className="bg-surface-sunken border-b border-line-soft">
                <tr>
                  {columns.map((c) => {
                    // Sortable headers are real <button>s (audit 2026-07-21): keyboard focus,
                    // Enter/Space activation and the hover affordance come for free, and aria-sort
                    // exposes the active direction to a screen reader. Visual layout is unchanged —
                    // the button inherits .th's type via Tailwind's button reset.
                    const active = sort?.key === c.key;
                    const ariaSort = !c.sortValue ? undefined : active ? (sort?.dir === 1 ? 'ascending' : 'descending') : 'none';
                    return (
                      <th key={c.key} className="th" aria-sort={ariaSort}>
                        {c.sortValue ? (
                          <button type="button" className="inline-flex items-center gap-1 hover:text-ink-mid cursor-pointer"
                            onClick={() => setSort((s) => s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 })}>
                            {c.header}{active && (sort?.dir === 1 ? ' ↑' : ' ↓')}
                          </button>
                        ) : c.header}
                      </th>
                    );
                  })}
                  {rowActions && <th className="th w-12"><span className="sr-only">פעולות</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {pageRows.map((row) => (
                  // A clickable row is keyboard operable (audit round 2): in ~10 screens the row is
                  // the ONLY way to open the record, but a bare onClick <tr> is mouse-only. When
                  // onRowClick exists we make the row a button — focusable, role="button", Enter/Space
                  // to activate (preventDefault on Space so the page doesn't scroll) — with the house
                  // focus-visible indigo outline (inset offset so overflow-hidden can't clip it, unlike
                  // a box-shadow ring). WCAG 2.1.1 (A).
                  <tr key={row.id}
                    className={onRowClick ? 'row-hover cursor-pointer focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2' : ''}
                    role={onRowClick ? 'button' : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } } : undefined}>
                    {columns.map((c) => <td key={c.key} className={`td ${c.className ?? ''}`}>{c.render(row)}</td>)}
                    {rowActions && (
                      <td className="td w-12 py-0.5!">
                        {/* stopPropagation on click AND keydown: the row itself is a button
                            (Enter/Space activate it), and opening the menu must not also
                            navigate the row. */}
                        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                          <ActionMenu items={rowActions(row)} />
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-line-soft text-sm text-ink-muted">
              <span>{filtered.length} רשומות</span>
              <div className="flex items-center gap-1">
                <button className="btn-ghost p-1.5! min-w-11 min-h-11" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="הקודם"><ChevronRight size={16} /></button>
                <span className="px-2">{page + 1} / {pages}</span>
                <button className="btn-ghost p-1.5! min-w-11 min-h-11" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)} aria-label="הבא"><ChevronLeft size={16} /></button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
