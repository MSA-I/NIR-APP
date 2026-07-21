import { useEffect, useId, useMemo, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ChevronLeft, Search, X, Loader2, Inbox, Bell, Check } from 'lucide-react';
import type { StatusMeta, Tone } from '../lib/status';
import { fmtMoney } from '../lib/format';

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
    <div className="flex items-center justify-center py-24 text-slate-400">
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
          <div className="flex items-center gap-2 p-3 border-b border-slate-100">
            <Skeleton className="h-9 w-full max-w-xs" />
          </div>
        )}
        <div className="bg-slate-50 border-b border-slate-100 flex gap-3 px-3 py-2.5">
          {Array.from({ length: cols }, (_, i) => <Skeleton key={i} className={`h-3 ${widths[i % widths.length]}`} />)}
        </div>
        <div className="divide-y divide-slate-100">
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
      <Inbox size={36} className="text-slate-300 mb-3" />
      <div className="text-slate-600 font-medium">{title}</div>
      {subtitle && <div className="text-sm text-slate-500 mt-1">{subtitle}</div>}
    </div>
  );
}

/* ---------- Note (shared alert box, §4.3) ---------- */
// One box for the four notice colours. `.note-*` lives in index.css so the whole
// system's success/warning/info/error boxes recolour from a single place. Only the
// four semantic tones make sense here; `violet`/`idle` are not notice colours.
export function Note({ tone, children, className = '' }: {
  tone: 'done' | 'await' | 'alert' | 'info'; children: ReactNode; className?: string;
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
  const toneCls = { slate: 'text-slate-900', green: 'text-done-fg', amber: 'text-await-fg', red: 'text-alert-fg', blue: 'text-info-fg' }[tone];
  return (
    <button onClick={onClick} disabled={!onClick}
      className="card card-pad text-start w-full hover:border-indigo-300 hover:shadow transition-all disabled:hover:border-slate-200 disabled:hover:shadow-sm cursor-pointer disabled:cursor-default">
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <div className={`text-xl font-bold mt-1 num text-start ${toneCls}`} dir="ltr" style={{ textAlign: 'right' }}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
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

/**
 * The control-center header (Nir sections 1–3). One card, dense one-line rows, ordered by
 * business importance by the caller. Two tiers inside the single card:
 *   A — count > 0: full rows, in the given order.
 *   B — count === 0: collapsed into one muted "✓ אין …" strip, so eight all-clear items do
 *       not shout as loudly as the things that need action ("calm", CLAUDE.md).
 * count === null (cannot be measured — e.g. no payment has a due date) is shown in NEITHER
 * tier: never rendered, never shown as 0 (CLAUDE.md:37). Rows are real <Link>s, so keyboard
 * focus, middle-click and "open in new tab" all work (Nir §2: the dashboard is also a hub).
 *
 * `totalLabel` (audit 2026-07-21): the header ₪ sum mixes credits (money owed to us) with
 * obligations (money we owe), so a bare figure is apples+oranges. The caller — which knows what
 * the mix means — may pass a short qualifier (e.g. "חשיפה"); we render it, we never invent it.
 */
export function AttentionZone({ items, totalLabel }: { items: AttentionItem[]; totalLabel?: string }) {
  const active = items.filter((i) => i.count != null && i.count > 0);
  const clear = items.filter((i) => i.count === 0);
  const totalAmount = active.reduce((s, i) => s + (i.amount ?? 0), 0);

  return (
    <section className="card card-pad">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h2 className="section-title flex items-center gap-2"><Bell size={18} className="text-await-fg" /> דורש טיפול היום</h2>
        <span className="text-xs text-slate-500">
          {active.length
            ? <>{active.length} פריטים{totalAmount > 0 && <> · {totalLabel ? <>{totalLabel} </> : null}<span className="num">{fmtMoney(totalAmount)}</span></>}</>
            : 'הכול תחת שליטה'}
        </span>
      </div>

      {active.length > 0 ? (
        <ul className="divide-y divide-slate-100">
          {active.map((i) => (
            <li key={i.key}>
              <Link to={i.to} className="flex items-center gap-3 py-2.5 -mx-2 px-2 rounded-lg hover:bg-slate-50 transition-colors">
                <span className={`badge-${i.tone} num justify-center min-w-8`}>{i.count}</span>
                <span className="flex-1 min-w-0 truncate">
                  <span className="text-slate-800 font-medium">{i.label}</span>
                  {i.hint && <span className="text-xs text-slate-500 ms-2">{i.hint}</span>}
                </span>
                {i.amount != null && i.amount > 0 && <span className="num text-sm font-semibold text-slate-700">{fmtMoney(i.amount)}</span>}
                <ChevronLeft size={16} className="text-slate-300 shrink-0" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-sm text-done-fg py-1">אין משימות דחופות כרגע</div>
      )}

      {clear.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500">
          {clear.map((i) => (
            <span key={i.key} className="inline-flex items-center gap-1"><Check size={13} className="text-done-solid shrink-0" /> {i.clearLabel ?? i.label}</span>
          ))}
        </div>
      )}
    </section>
  );
}

/* ---------- StatTile — a compact, navigable stat (dashboard money strip) ---------- */
// Uses section 6's fg surface (index.css comment: "fg → text/icon on white, KpiCard/money").
export function StatTile({ title, value, tone = 'idle', to, sub }: {
  title: string; value: string; tone?: Tone; to: string; sub?: string;
}) {
  // Keys are exactly the Tone union (audit 2026-07-21 removed the orphan `violet`, which Tone no
  // longer includes and no caller passed).
  const toneCls = { done: 'text-done-fg', await: 'text-await-fg', alert: 'text-alert-fg', info: 'text-info-fg', idle: 'text-slate-900' }[tone];
  return (
    <Link to={to} className="card card-pad block hover:border-indigo-300 hover:shadow transition-all">
      <div className="text-xs font-medium text-slate-500">{title}</div>
      <div className={`text-xl font-bold mt-1 num ${toneCls}`} dir="ltr" style={{ textAlign: 'right' }}>{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </Link>
  );
}

/* ---------- TaskLine — role-routed queue row (promoted from Dashboard, now a <Link>) ---------- */
export function TaskLine({ label, count, to }: { label: string; count: number; to: string }) {
  return (
    <li>
      <Link to={to} className="flex items-center justify-between -mx-2 px-2 py-1.5 rounded-lg hover:bg-slate-50">
        <span className="text-slate-600">{label}</span>
        <span className={`badge num ${count > 0 ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-100 text-slate-600'}`}>{count}</span>
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4" onClick={onClose}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={`bg-white rounded-t-2xl sm:rounded-2xl shadow-xl w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} max-h-[92vh] flex flex-col focus:outline-none`}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 id={titleId} className="font-semibold text-slate-900">{title}</h3>
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
      <p className="text-sm text-slate-600 mb-4">{message}</p>
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
            className={`rounded-lg px-4 py-2.5 text-sm text-white shadow-lg ${t.tone === 'success' ? 'bg-slate-800' : 'bg-rose-600'}`}>
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
}

export function DataTable<T extends { id: string }>({ rows, columns, onRowClick, searchable, searchFn, pageSize = 15, emptyTitle = 'אין נתונים להצגה', emptySubtitle, toolbar }: {
  rows: T[]; columns: Column<T>[]; onRowClick?: (row: T) => void;
  searchable?: boolean; searchFn?: (row: T, q: string) => boolean;
  pageSize?: number; emptyTitle?: string; emptySubtitle?: string; toolbar?: ReactNode;
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
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-slate-100">
          {searchable && (
            <div className="relative flex-1 min-w-44 max-w-xs">
              <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-slate-400" />
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
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-100">
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
                          <button type="button" className="inline-flex items-center gap-1 hover:text-slate-700 cursor-pointer"
                            onClick={() => setSort((s) => s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 })}>
                            {c.header}{active && (sort?.dir === 1 ? ' ↑' : ' ↓')}
                          </button>
                        ) : c.header}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pageRows.map((row) => (
                  <tr key={row.id} className={onRowClick ? 'hover:bg-indigo-50/40 cursor-pointer' : ''} onClick={() => onRowClick?.(row)}>
                    {columns.map((c) => <td key={c.key} className={`td ${c.className ?? ''}`}>{c.render(row)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 text-sm text-slate-500">
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
