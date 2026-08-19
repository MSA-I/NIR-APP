import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { ChevronRight, ChevronLeft, ChevronDown, Search, X, Loader2, Inbox, Bell, Check, Columns3, SlidersHorizontal, AlertTriangle } from 'lucide-react';
import {
  useReactTable, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel,
  type ColumnDef, type SortingState,
} from '@tanstack/react-table';
import type { StatusMeta, Tone } from '../lib/status';
import type { ServerSort } from '../lib/serverList';
import { fmtMoneyRounded } from '../lib/format';
import { OPTIONAL_REASON_LABEL, reasonOr } from '../lib/reason';
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
    <div role="status" aria-live="polite" className="flex items-center justify-center py-24 text-ink-faint">
      <Loader2 className="animate-spin" size={28} aria-hidden="true" />
      <span className="sr-only">טוען</span>
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
        <div className="table-head border-b border-line-soft flex gap-3 px-3 py-2.5">
          {Array.from({ length: cols }, (_, i) => <Skeleton key={i} className={`h-3 opacity-40 ${widths[i % widths.length]}`} />)}
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

/** Mirrors the stacked card-button lists (Receiving, AccountantPaymentQueue) — not a table. */
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

/** Mirrors a record page: identity, facts/actions, then the main content surface. */
export function RecordSkeleton() {
  return (
    <SkeletonRegion>
      <div className="space-y-3">
        <Skeleton className="h-3 w-28" />
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-5 w-20 rounded-full" />
        </div>
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
      <div className="card card-pad space-y-4">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </SkeletonRegion>
  );
}

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export function Breadcrumbs({ items }: { items: readonly BreadcrumbItem[] }) {
  return (
    <nav aria-label="פירורי לחם" className="text-xs text-ink-muted">
      <ol className="flex min-w-0 items-center gap-1.5">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
              {item.to && !current ? (
                <Link to={item.to} className="rounded-sm hover:text-ink-body hover:underline focus-visible:outline-2 focus-visible:outline-focus">
                  {item.label}
                </Link>
              ) : (
                <span aria-current={current ? 'page' : undefined} className={current ? 'truncate text-ink-soft' : undefined}>
                  {item.label}
                </span>
              )}
              {!current && <ChevronLeft size={13} aria-hidden="true" className="shrink-0 text-ink-ghost" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The section mark — a 28×3px rule under the page title in the accent of the work domain the
 * screen belongs to (מסמכים · רכש · כספים). There is deliberately no prop: it reads
 * `--section-accent`, which only `Layout`'s `<main data-section>` sets, and only from the URL. A
 * caller cannot make it say "approved" or "overdue" because a caller cannot address it at all.
 * On a screen with no work domain the rule is `display: none` and nothing is reserved for it.
 * `aria-hidden` because the `h1` immediately above already names the place in words.
 */
function SectionMark() {
  return <span className="section-mark" aria-hidden="true" />;
}

export function PageHeader({ title, meta, breadcrumbs, actions, className = '' }: {
  title: ReactNode;
  meta?: ReactNode;
  breadcrumbs?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between ${className}`}>
      <div className="min-w-0 space-y-1">
        {breadcrumbs}
        <h1 className="page-title break-words">{title}</h1>
        <SectionMark />
        {meta && <div className="text-sm text-ink-muted">{meta}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function RecordHeader({ title, status, meta, breadcrumbs, primaryAction, secondaryActions, lifecycle, className = '' }: {
  title: ReactNode;
  status?: ReactNode;
  meta?: ReactNode;
  breadcrumbs?: ReactNode;
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  lifecycle?: ReactNode;
  className?: string;
}) {
  const hasActions = primaryAction || secondaryActions;
  return (
    <header className={`space-y-4 ${className}`}>
      {breadcrumbs}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2.5">
            <h1 className="page-title break-words">{title}</h1>
            {status}
          </div>
          <SectionMark />
          {meta && <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-muted">{meta}</div>}
        </div>
        {hasActions && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {primaryAction}
            {secondaryActions}
          </div>
        )}
      </div>
      {lifecycle}
    </header>
  );
}

export interface LifecycleStep {
  key: string;
  label: string;
}

export function LifecycleStrip({ steps, current, nextAction, failed = false, detail, progress }: {
  steps: readonly LifecycleStep[];
  current: string;
  nextAction?: ReactNode;
  /** The current step stopped instead of continuing. Recolours that one marker alert. */
  failed?: boolean;
  /** What the current step is doing, in the caller's words. */
  detail?: ReactNode;
  /**
   * A determinate bar for the current step. Omit it entirely when nothing real is known —
   * a zero-width bar and a looping indeterminate one are both claims the data does not support
   * (DESIGN.md: "אנימציה שאינה מצב — אסור בחוקה").
   */
  progress?: { done: number; total: number; label: string };
}) {
  const currentIndex = steps.findIndex((step) => step.key === current);
  const percent = progress && progress.total > 0
    ? Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
    : null;
  return (
    <div className="rounded-xl border border-line-soft bg-surface-sunken px-3 py-3">
      <ol aria-label="שלבי התהליך" className="flex min-w-0 flex-wrap items-center gap-y-2 overflow-x-auto pb-1">
        {steps.map((step, index) => {
          const isCurrent = index === currentIndex;
          const isComplete = currentIndex >= 0 && index < currentIndex;
          const isStopped = isCurrent && failed;
          const text = isStopped ? 'text-alert-fg' : isCurrent ? 'text-info-fg' : isComplete ? 'text-done-fg' : 'text-ink-muted';
          const marker = isStopped
            ? 'border-alert-line bg-alert-soft'
            : isCurrent ? 'border-info-line bg-info-soft' : isComplete ? 'border-done-line bg-done-soft' : 'border-line-strong bg-surface';
          return (
            // `relative` is load-bearing, not styling. The sr-only span below is
            // `position: absolute`, so without a positioned ancestor inside the scroller its
            // containing block sits ABOVE the `ol` -- and an absolutely positioned box is not
            // clipped by a scroller that is merely its DOM ancestor. In RTL it then landed 33px past
            // the left viewport edge and widened the whole document, which the browser gate caught
            // at 390px as `horizontal overflow 33px`. It only showed once the LAST step became the
            // current one (a review-stage document); with an earlier step current the same span sat
            // 3px out and stayed inside the tolerance.
            <li key={step.key} aria-current={isCurrent ? 'step' : undefined} className="relative flex min-w-fit items-center sm:flex-1">
              <span className={`flex items-center gap-1.5 text-xs font-medium ${text}`}>
                <span className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${marker}`} aria-hidden="true">
                  {isStopped ? <AlertTriangle size={12} /> : isComplete ? <Check size={12} /> : index + 1}
                </span>
                {step.label}
                {isCurrent && <span className="sr-only">{isStopped ? ' — השלב שנעצר' : ' — השלב הנוכחי'}</span>}
              </span>
              {index < steps.length - 1 && <ChevronLeft size={14} className="mx-2 shrink-0 text-ink-ghost" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      {progress && percent !== null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-valuetext={progress.label}
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line"
        >
          {/* Petrol is structure here, never a verdict: the fill says how much, not whether it
              went well. Width only, so reduced-motion cancels it with the shared transition rule. */}
          <div className="h-full rounded-full bg-action transition-[width] duration-200 ease-out" style={{ width: `${percent}%` }} />
        </div>
      )}
      {detail && <div className="mt-2 text-xs text-ink-soft">{detail}</div>}
      {nextAction && (
        <div className="mt-2 border-t border-line-soft pt-2 text-sm text-ink-body">
          <span className="font-semibold">הפעולה הבאה:</span> {nextAction}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ title, subtitle, action, icon }: { title: string; subtitle?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <span aria-hidden="true" className="mb-3 text-ink-ghost">{icon ?? <Inbox size={36} />}</span>
      <div className="text-ink-soft font-medium">{title}</div>
      {subtitle && <div className="text-sm text-ink-muted mt-1">{subtitle}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/* ---------- Disclosure — the one staged-disclosure control ---------- */
/**
 * One folded section, in the shape the dashboard's operations card already established: a native
 * `<details>`/`<summary>`, a 44px summary row, a count badge in the shared Tone vocabulary, and a
 * chevron that turns. Native on purpose — the browser owns open/close, find-in-page still reaches
 * inside a closed section, and no ARIA has to be hand-wired.
 *
 * `onToggle` reports the open state so a caller can build expensive children only once someone has
 * asked for them. That matters more than it looks: a closed `<details>` still renders its children
 * into the DOM, so collapsing alone saves paint and scroll, never React work. The precedent is
 * DocumentReviewWorkspace's "פרטים טכניים", which gates its per-block rows on exactly this flag.
 *
 * DESIGN.md, חוק החשיפה המדורגת: this folds secondary detail. It never folds an error, an amount,
 * a value the machine changed, or an irreversible action.
 */
export function Disclosure({ title, count, tone = 'idle', summary, name, className = '', onToggle, children }: {
  title: string;
  /** Rendered as a badge on the summary row. Omit when there is nothing honest to count. */
  count?: number;
  /** Tone of the count badge — `done|await|alert|info|idle` only, never a palette name. */
  tone?: Tone;
  /** Short end-aligned qualifier on the summary row. */
  summary?: ReactNode;
  /** A shared `name` makes sibling disclosures mutually exclusive (native accordion). */
  name?: string;
  className?: string;
  /** Fires with the new open state; use it to gate a heavy child behind the fold. */
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details name={name} className={`group ${className}`} onToggle={(event) => onToggle?.(event.currentTarget.open)}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5 text-sm hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden sm:px-4">
        <span className="font-medium text-ink-body">{title}</span>
        {count != null && <span className={`badge-${tone} num`}>{count}</span>}
        {summary != null && <span className="ms-auto min-w-0 text-end text-xs text-ink-muted">{summary}</span>}
        <ChevronDown size={16} aria-hidden="true"
          className={`shrink-0 text-ink-ghost transition-transform duration-200 ease-out group-open:rotate-180 motion-reduce:transition-none ${summary == null ? 'ms-auto' : ''}`} />
      </summary>
      <div className="border-t border-line-soft px-3 pb-4 pt-3 sm:px-4">{children}</div>
    </details>
  );
}

/* ---------- Note (shared alert box, §4.3) ---------- */
// One box for the notice colours. `.note-*` lives in index.css so the whole system's
// success/warning/info/error boxes recolour from a single place. The four semantic tones plus
// `idle` for a neutral notice — a statement with no claim (audit round 2); `violet` is gone.
/**
 * A toned notice box. It is a flex ROW, so every child is a flex item -- including each run of
 * raw text between two inline tags. Prose passed straight in is therefore shredded into
 * one-word columns (measured on the settings screen at 390px, four columns of single words).
 * Pass prose as a SINGLE child: `<Note tone="info"><span className="min-w-0 flex-1">…</span></Note>`.
 * The row itself is for the icon / text / action layout the ~15 call sites that use it rely on.
 */
export function Note({ tone, children, className = '', role }: {
  tone: 'done' | 'await' | 'alert' | 'info' | 'idle'; children: ReactNode; className?: string; role?: 'alert' | 'status';
}) {
  return <div className={`note-${tone} ${className}`} role={role}>{children}</div>;
}

// Kept as a named wrapper: its ~30 call sites stay untouched and all get their colour
// from Note → .note-alert. (Text is now -on-soft/-800, was rose-700 — §3.1 fix.)
export function ErrorNote({ message }: { message: string }) {
  return <Note tone="alert" role="alert">{message}</Note>;
}

/* ---------- KpiCard ---------- */
export function KpiCard({ title, value, sub, tone = 'idle', onClick }: {
  title: string; value: string; sub?: string; tone?: Tone; onClick?: () => void;
}) {
  // Takes the shared Tone vocabulary (polish sweep 2026-08-02). The prop used to be keyed by colour
  // name (slate|green|amber|red|blue) while every badge, note and attention row already spoke
  // done/await/alert/info/idle — one component, two languages for the same five meanings. The class
  // each maps to is unchanged; await-fg also lifts the small value off the contrast raw amber-600 failed.
  const toneCls = { idle: 'text-ink', done: 'text-done-fg', await: 'text-await-fg', alert: 'text-alert-fg', info: 'text-info-fg' }[tone];
  const className = `card card-pad text-start w-full ${onClick ? 'card-link-hover cursor-pointer' : ''}`;
  const content = (
    <>
      <div className="text-xs font-medium text-ink-muted">{title}</div>
      {/* .num already aligns to the logical end (text-align: end, unlayered → wins); the physical
          textAlign:right + dead text-start it replaces broke the RTL rule (audit round 2). */}
      <div className={`kpi-value mt-1 num ${toneCls}`}>{value}</div>
      {sub && <div className="text-xs text-ink-muted mt-1">{sub}</div>}
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className={className}>{content}</button>
    : <div className={className}>{content}</div>;
}

/* ---------- AttentionZone — dashboard "requires attention today" ---------- */
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
// T7.3: the row CLUSTERS at the logical start instead of stretching content to both edges — a
// wide card no longer leaves a chevron orphaned across an empty gulf (owner report). The hover
// wash still spans the full row, so the tap surface did not shrink.
function AttentionRow({ item, muted }: { item: AttentionItem; muted?: boolean }) {
  const measured = item.count != null;
  return (
    <li>
      <Link to={item.to} className="flex min-h-11 items-center gap-3 py-2.5 -mx-2 px-2 rounded-lg hover:bg-surface-hover active:bg-surface-selected transition-colors">
        <span className={`${measured ? `badge-${item.tone}` : 'badge-idle'} num justify-center min-w-8`}>{item.count ?? '—'}</span>
        <span className="min-w-0 leading-snug">
          <span className={muted ? 'text-ink-soft' : 'text-ink-body font-medium'}>{item.label}</span>
          {item.hint && <span className="ms-2 text-xs text-ink-muted max-sm:block max-sm:ms-0 max-sm:mt-0.5">{item.hint}</span>}
        </span>
        {item.amount != null && item.amount > 0 && (
          <span className={`num text-sm ${muted ? 'font-medium text-ink-soft' : 'font-semibold text-ink-mid'}`}>{fmtMoneyRounded(item.amount)}</span>
        )}
        <ChevronLeft size={16} className="text-ink-ghost shrink-0" aria-hidden="true" />
      </Link>
    </li>
  );
}

/**
 * The control-center header. One card, dense one-line rows. Active rows
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
 * middle-click and "open in new tab" all work because the dashboard is also a hub.
 *
 * The header count + ₪ sum reflect the ACTION tier only (audit round 2) — the honest "needs
 * action today" figure; the לידיעה rows keep their own per-row amounts and are not summed in.
 * Tone drives the grouping; no business meaning is invented here.
 *
 * `totalLabel` (audit 2026-07-21): the header ₪ sum can still mix credits (money owed to us) with
 * obligations (money we owe), so a bare figure is apples+oranges. The caller — which knows what
 * the mix means — may pass a short qualifier (e.g. "חשיפה"); we render it, we never invent it.
 */
export function AttentionZone({ items, totalLabel, className = '' }: {
  items: AttentionItem[];
  totalLabel?: string;
  /** Caller-supplied classes on the card root. The owner dashboard uses it to declare this zone's
   *  entrance step, which differs between phone and desktop since the money band moves. */
  className?: string;
}) {
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
  // The header's own tone, from the rows it is counting rather than from a constant. The bell used
  // to be `text-await-fg` unconditionally, so it went on claiming "something is waiting" while the
  // card underneath said "אין משימות דחופות כרגע" — colour asserting the opposite of the sentence
  // beside it. `alert` wins over `await` for the same reason ATTENTION_TONE_ORDER ranks it first.
  const headlineTone: Tone = actionRows.some((i) => i.tone === 'alert') ? 'alert' : 'await';

  return (
    <section className={`card card-pad ${className}`}>
      {/* One count, one element. The heading and a separate "N סוגי טיפול" sentence were two
          renderings of the same fact a few pixels apart; the number now rides ON the heading it
          describes, and the end-aligned slot carries only the ₪ exposure, which is a different
          fact. The unit stays in the accessible name so nothing is lost to a screen reader.
          (Dashboard.tsx carried a third copy in its `meta` line; that one is already gone.) */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title flex items-center gap-2">
          <Bell size={18} aria-hidden="true"
            className={actionRows.length === 0 ? 'text-ink-ghost' : headlineTone === 'alert' ? 'text-alert-fg' : 'text-await-fg'} />
          דורש טיפול היום
          {actionRows.length > 0 && (
            <span className={`${headlineTone === 'alert' ? 'badge-alert' : 'badge-await'} num`}>
              {actionRows.length}<span className="sr-only"> סוגי טיפול</span>
            </span>
          )}
        </h2>
        {actionTotal > 0 && (
          <span className="text-xs text-ink-muted">
            {totalLabel ? <>{totalLabel} </> : null}<span className="num">{fmtMoneyRounded(actionTotal)}</span>
          </span>
        )}
      </div>

      {actionRows.length > 0 ? (
        /* T7: one column. The zone now lives in a half-width tile of the dashboard grid (the
           reference's side list), where two columns of long Hebrew labels wrapped every row. */
        <ul className="grid grid-cols-1">
          {actionRows.map((i) => <AttentionRow key={i.key} item={i} />)}
        </ul>
      ) : unknownRows.length > 0 ? (
        /* Not everything could be measured, so the green all-clear is a claim we are not entitled
           to make (an undated payment request may well be overdue) — but silence was worse: a
           brand-new organization has two unmeasurable rows by design, so the largest card on its
           first screen used to render a heading above nothing at all. Neutral ink, and no number:
           the count already rides the disclosure badge four lines below. */
        <div className="text-sm text-ink-soft py-1">אין משימות דחופות מבין המדדים שנמדדו — מדדים שאין להם נתונים מרוכזים תחת „מידע נוסף”.</div>
      ) : (
        <div className="text-sm text-done-fg py-1">אין משימות דחופות כרגע</div>
      )}

      {(noticeRows.length > 0 || unknownRows.length > 0 || clear.length > 0) && (
        <details className="group mt-2 border-t border-line-soft">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm text-ink-muted hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
            <ChevronLeft size={16} className="shrink-0 transition-transform group-open:-rotate-90" aria-hidden="true" />
            <span className="font-medium text-ink-soft">מידע נוסף</span>
            {/* The count rides its label — a badge orphaned at the far edge reads as debris. */}
            <span className="badge-idle num">{noticeRows.length + unknownRows.length + clear.length}</span>
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
                <span key={i.key} className="inline-flex items-center gap-1"><Check size={13} className="text-done-fg shrink-0" aria-hidden="true" /> {i.clearLabel ?? i.label}</span>
              ))}
            </div>
          )}
        </details>
      )}
    </section>
  );
}

/* TaskLine lived here until T7 (18.08.2026): the role queues it rendered moved into the
   dashboard's dark Onyx card (RoleQueueCard in Dashboard.tsx), its only consumer. Deleted rather
   than left exported — dead code is how a removed surface comes back by accident. */

/* ---------- Modal ---------- */
// One dialog stack for Modal, the mobile drawer and mobile search. A nested layer owns Escape
// and Tab until it closes; background layers stay inert. The selector excludes hidden controls,
// while the runtime filter also catches CSS-hidden ancestors.
const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const dialogStack: symbol[] = [];
let bodyLockDepth = 0;
let previousBodyOverflow = '';

function focusableWithin(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) =>
    !node.hidden
    && !node.closest('[hidden], [aria-hidden="true"]')
    && node.getClientRects().length > 0
    && getComputedStyle(node).visibility !== 'hidden');
}

function lockBody() {
  if (bodyLockDepth++ === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
}

function unlockBody() {
  bodyLockDepth = Math.max(0, bodyLockDepth - 1);
  if (bodyLockDepth === 0) document.body.style.overflow = previousBodyOverflow;
}

export function useDialogLayer<T extends HTMLElement>({ open, onClose, busy = false, allowCloseWhileBusy = false, initialFocus }: {
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  allowCloseWhileBusy?: boolean;
  initialFocus?: (panel: T) => HTMLElement | null;
}) {
  const panelRef = useRef<T>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const tokenRef = useRef(Symbol('dialog'));
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const allowCloseRef = useRef(allowCloseWhileBusy);
  const initialFocusRef = useRef(initialFocus);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  allowCloseRef.current = allowCloseWhileBusy;
  initialFocusRef.current = initialFocus;

  const isTop = useCallback(() => dialogStack.at(-1) === tokenRef.current, []);
  const requestClose = useCallback(() => {
    if (!isTop() || (busyRef.current && !allowCloseRef.current)) return false;
    onCloseRef.current();
    return true;
  }, [isTop]);

  useEffect(() => {
    if (!open) return;
    const token = tokenRef.current;
    openerRef.current = document.activeElement as HTMLElement | null;
    dialogStack.push(token);
    lockBody();

    const focusFrame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel) (initialFocusRef.current?.(panel) ?? panel).focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const nodes = focusableWithin(panelRef.current);
      if (!nodes.length) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!panelRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      const index = dialogStack.lastIndexOf(token);
      if (index >= 0) dialogStack.splice(index, 1);
      unlockBody();
      const opener = openerRef.current;
      requestAnimationFrame(() => {
        if (opener?.isConnected && !opener.hidden && opener.getClientRects().length > 0) opener.focus();
      });
    };
  }, [open, isTop, requestClose]);

  return { panelRef, requestClose, isTop };
}

export function Modal({ open, onClose, title, children, wide, busy = false, allowCloseWhileBusy = false, description, statusMessage }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
  busy?: boolean;
  allowCloseWhileBusy?: boolean;
  description?: string;
  statusMessage?: string;
}) {
  const { panelRef, requestClose, isTop } = useDialogLayer<HTMLDivElement>({ open, onClose, busy, allowCloseWhileBusy });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const previousStatusRef = useRef<string | undefined | null>(null);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    if (!open) { previousStatusRef.current = null; return; }
    const previous = previousStatusRef.current;
    previousStatusRef.current = statusMessage;
    if (previous !== null && statusMessage && statusMessage !== previous && isTop()) {
      setAnnouncement(statusMessage);
      requestAnimationFrame(() => titleRef.current?.focus());
    }
  }, [open, statusMessage, isTop]);

  // A wizard step may remove the focused control. Recover to the dialog heading instead of
  // leaving focus on document.body, and announce the new step when the caller supplied one.
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const observer = new MutationObserver(() => queueMicrotask(() => {
      const active = document.activeElement as HTMLElement | null;
      if (isTop() && (!active || active === document.body || !active.isConnected)) {
        titleRef.current?.focus();
        setAnnouncement(statusMessage ?? title);
      }
    }));
    observer.observe(panelRef.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, panelRef, isTop, statusMessage, title]);

  if (!open) return null;
  const closeDisabled = busy && !allowCloseWhileBusy;
  // Portaled to <body>: a modal rendered in place inherits its ancestor's stacking context, and
  // the sticky header is z-40 — so a dialog opened from the header (FeedbackButton) painted its
  // z-50 *inside* a z-40 context and the mobile action bar (also z-40, later in the DOM) sat on
  // top of the send button. The browser gate caught it: the tap landed on 'פעולות מהירות'.
  return createPortal(
    <div className="dialog-backdrop-safe fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-shell/50 p-0 sm:p-4" onClick={() => requestClose()}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined} aria-busy={busy || undefined} tabIndex={-1}
        className={`dialog-panel-safe bg-surface rounded-t-2xl sm:rounded-2xl shadow-xl w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} flex flex-col focus:outline-none`}
        onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft">
          <h3 ref={titleRef} id={titleId} tabIndex={-1} className="font-semibold text-ink focus:outline-none">{title}</h3>
          <button type="button" className="btn-ghost p-1.5! min-w-11 min-h-11" disabled={closeDisabled}
            onClick={() => requestClose()} aria-label="סגירה"><X size={18} /></button>
        </div>
        <div className="dialog-safe-body p-5 overflow-y-auto">
          {description && <p id={descriptionId} className="text-sm text-ink-soft mb-4">{description}</p>}
          {children}
        </div>
        <div aria-live="polite" className="sr-only">{announcement}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'אישור', reasonLabel = OPTIONAL_REASON_LABEL, danger, requireReason, busy }: {
  open: boolean; onClose: () => void; onConfirm: (reason?: string) => void;
  title: string; message: string; confirmLabel?: string; reasonLabel?: string; danger?: boolean; requireReason?: boolean; busy?: boolean;
}) {
  const [reason, setReason] = useState('');
  const reasonId = useId();
  useEffect(() => { if (open) setReason(''); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title} description={message} busy={busy}>
      {requireReason && (
        <div className="mb-4">
          <label className="label" htmlFor={reasonId}>{reasonLabel}</label>
          {/* maxLength matches every other audited reason field in the app (document-review's three
              forms, the type-review decision). The column is unbounded text, so this is a consistency
              and sanity bound on a justification — free-form `notes` fields stay uncapped on purpose,
              since truncating business content would be worse than an unbounded box. */}
          <textarea id={reasonId} className="input" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
        {/* The reason no longer blocks the button (owner, 11.08.2026). `requireReason` now means
            "this action records a reason", not "this action interrogates the user" — when the box
            is empty the ledger gets a sentence naming the action instead of a forced "asdf". */}
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy}
          onClick={() => onConfirm(requireReason ? reasonOr(reason, title) : undefined)}>
          {busy ? <><Loader2 size={16} className="animate-spin" aria-hidden="true" /><span>מעבד…</span></> : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* ---------- Toast ---------- */
interface Toast { id: number; message: string; tone: 'success' | 'error' }
const ToastContext = createContext<(message: string, tone?: 'success' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children, bottomNotice }: { children: ReactNode; bottomNotice?: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (message: string, tone: 'success' | 'error' = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  };
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="mobile-overlay-stack fixed z-[60] start-4 end-4 flex flex-col items-center gap-2 pointer-events-none no-print sm:start-6 sm:end-6">
        {toasts.length > 0 && (
          <div className="mobile-toast-offset flex flex-col gap-2 items-center pointer-events-auto">
            {toasts.map((t) => (
              // Each toast is its own live region (audit 2026-07-21): success is polite, an error is
              // assertive so a screen reader interrupts to surface it. role follows suit (status/alert).
              <div key={t.id}
                role={t.tone === 'error' ? 'alert' : 'status'}
                aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
                className={`rounded-lg px-4 py-2.5 text-sm text-on-solid shadow-lg ${t.tone === 'success' ? 'bg-ink-body' : 'bg-alert-solid'}`}>
                {t.message}
              </div>
            ))}
          </div>
        )}
        {bottomNotice}
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

/** Column shape in server mode. `sortValue` is a compile error rather than an ignored prop:
    a client comparator over one fetched page would sort the page, not the result (ADR-0007). */
export interface ServerColumn<T> extends Omit<Column<T>, 'sortValue'> {
  sortValue?: never;
}

/**
 * The opt-in server mode of DataTable (ADR-0007). Presence of this prop is the switch:
 * the table stops filtering, sorting and slicing entirely and renders `rows` as the one page
 * the screen fetched via `fetchServerList`. Page reset on a sort/search/filter change is the
 * screen's job in this mode — the table only reports the interaction.
 */
export interface DataTableServer {
  /** `ServerListResult.total` — the RLS-filtered COUNT. Never a page length. */
  total: number;
  /** Zero-based, mirroring `ServerListRequest.page`. */
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  /** null = no user sort; the screen decides its default order in the request. */
  sort: readonly ServerSort[] | null;
  onSortChange: (sort: readonly ServerSort[] | null) => void;
  /** Only a column whose key is in this set renders a sort button; the rest are plain text. */
  sortableColumns: ReadonlySet<string>;
  /** Server-mode search box. The table debounces (>=300ms — every keystroke would pay a
      filtered COUNT) and emits the settled value only. */
  search?: { value: string; onChange: (value: string) => void };
  /** True while a request is in flight. Drives the subtle indicator + aria-busy; never blanks rows. */
  fetching: boolean;
}

interface DataTableCommonProps<T> {
  rows: T[];
  onRowClick?: (row: T) => void;
  searchLabel?: string;
  emptyTitle?: string;
  emptySubtitle?: string;
  emptyAction?: ReactNode;
  emptyIcon?: ReactNode;
  toolbar?: ReactNode;
  /** 'cards' (default) stacks rows below md; reserve 'scroll' for true matrix previews.
      Search/filter/sort/pagination are shared. */
  mobile?: 'cards' | 'scroll';
  /** Card headline; default: the first visible column's render. */
  mobileTitle?: (row: T) => ReactNode;
  /** End-aligned slot on the headline (typically the status badge). */
  mobileTrailing?: (row: T) => ReactNode;
  /** Per-row ActionMenu items: a trailing non-sortable column on desktop, an end-aligned
      trigger next to the card body on mobile. Items handle their own role gating via hidden. */
  rowActions?: (row: T) => ActionMenuItem[];
  /** Human-readable identity used in row action names, e.g. "חשבונית 123 — ספק א". */
  rowLabel?: (row: T) => string;
  /** Hebrew error text. When set, the body renders an alert Note — a failed result must never
      fall through to EmptyState and read as "no data" (gate B30). */
  error?: string | null;
  /** How many toolbar-slot filters are active. The table cannot see the screen's filters, and
      without this a filtered-to-empty screen would lie "אין נתונים". Also the trigger badge
      of the mobile filter sheet. */
  activeFilters?: number;
  /** Renders "נקה סינון" (toolbar + filtered-empty state). The table clears the search it owns
      first, then calls this so the screen clears its own filters. */
  onClearFilters?: () => void;
  /** Per-screen localStorage key for the column picker (e.g. 'invoices'). Presence enables the
      picker. localStorage on purpose and declared temporary — OPEN-DECISIONS #80. */
  columnPicker?: string;
}

export interface DataTableClientProps<T> extends DataTableCommonProps<T> {
  columns: Column<T>[];
  server?: never;
  searchable?: boolean;
  searchFn?: (row: T, q: string) => boolean;
  pageSize?: number;
}

export interface DataTableServerProps<T> extends DataTableCommonProps<T> {
  columns: ServerColumn<T>[];
  server: DataTableServer;
  /** In server mode search exists only through `server.search` — a client-side `searchFn`
      would filter one page and report a wrong count, so the type forbids it. */
  searchable?: never;
  searchFn?: never;
  /** Page size comes only from `server.pageSize`. */
  pageSize?: never;
}

/** Discriminated on `server` so a page-local filter/sort cannot compile in server mode. */
export type DataTableProps<T> = DataTableClientProps<T> | DataTableServerProps<T>;

/** Every keystroke in server mode costs a filtered COUNT; emit only the settled value. */
const SEARCH_DEBOUNCE_MS = 300;

/** OPEN-DECISIONS #80: column preferences live in localStorage per screen, declared temporary
    until saved views exist. Reads are validated against the current column keys so a stale or
    hand-edited entry cannot hide a column that no longer exists. */
const COLUMN_PREFS_PREFIX = 'sf.columns.';

function readHiddenColumns(storageKey: string | undefined, validKeys: readonly string[]): Record<string, boolean> {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(COLUMN_PREFS_PREFIX + storageKey);
    if (!raw) return {};
    const hidden: unknown = JSON.parse(raw);
    if (!Array.isArray(hidden)) return {};
    const valid = new Set(validKeys);
    const state: Record<string, boolean> = {};
    for (const key of hidden) if (typeof key === 'string' && valid.has(key)) state[key] = false;
    return state;
  } catch {
    return {};
  }
}

/**
 * The enterprise toolbar needs to know which of its two layouts is live. The table body itself
 * keeps both DOM branches mounted and CSS-hidden (`lg:hidden` / `hidden lg:block` — the browser
 * gate measures `:visible` on that model and it must not change), but the toolbar cannot do the
 * same: rendering the screen's `toolbar` slot twice would duplicate every id inside it (gate B6).
 * Defaults to desktop where matchMedia is unavailable (jsdom).
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : true);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

interface ColumnPickerOption {
  key: string;
  header: string;
  visible: boolean;
  /** The last visible column cannot be hidden — a table with zero columns is not a state. */
  disabled: boolean;
  onToggle: (visible: boolean) => void;
}

/** Native checkboxes inside their labels: accessible names and state announcements for free,
    no ids to collide between the picker's popover and sheet renderings (only one is mounted). */
function ColumnChecklist({ options }: { options: ColumnPickerOption[] }) {
  return (
    <div role="group" aria-label="בחירת עמודות" className="flex flex-col">
      {options.map((o) => (
        <label key={o.key}
          className={`flex min-h-11 items-center gap-2.5 rounded-lg px-2 text-sm ${o.disabled ? 'text-ink-faint cursor-default' : 'text-ink-body cursor-pointer hover:bg-surface-hover'}`}>
          <input type="checkbox" className="size-4 shrink-0 accent-action" checked={o.visible} disabled={o.disabled}
            onChange={(event) => o.onToggle(event.target.checked)} />
          {o.header}
        </label>
      ))}
    </div>
  );
}

/** Desktop column picker. Portals to body for the same reason ActionMenu does — the DataTable
    card is overflow-hidden — and reuses its measure-then-place pattern (end-edge aligned,
    flipped above when the viewport has no room below, clamped inside). */
function ColumnPickerPopover({ options }: { options: ColumnPickerOption[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((focusTrigger = false) => {
    setOpen(false);
    setPos(null);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const rect = trigger.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    const rtl = document.documentElement.dir === 'rtl';
    let left = rtl ? rect.left : rect.right - pw;
    left = Math.min(Math.max(left, 8), window.innerWidth - pw - 8);
    let top = rect.bottom + 4;
    if (top + ph > window.innerHeight - 8 && rect.top - ph - 4 >= 8) top = rect.top - ph - 4;
    top = Math.min(Math.max(top, 8), window.innerHeight - ph - 8);
    setPos({ top, left });
    panel.querySelector<HTMLElement>('input:not(:disabled)')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation(); // an open popover consumes Escape — a Modal underneath must not also close
      close(true);
    };
    // The page scrolling moves the anchor — close rather than chase it (same call as ActionMenu).
    // The panel's own overflow scroll is exempt, or scrolling the checklist would dismiss it.
    const onScroll = (event: Event) => {
      if (panelRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close]);

  return (
    <>
      <button ref={triggerRef} type="button" className="btn-secondary" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}>
        <Columns3 size={15} aria-hidden="true" /> עמודות
      </button>
      {open && createPortal(
        <div ref={panelRef} role="dialog" aria-label="בחירת עמודות" tabIndex={-1}
          style={{ position: 'fixed', top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
          className="z-50 min-w-44 max-w-64 max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain border border-line bg-surface p-2 shadow-menu">
          <ColumnChecklist options={options} />
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * The system's work table, now driven by @tanstack/react-table 8 internally (ADR-0007).
 *
 * The engine owns the row model — filter, then sort, then paginate, exactly the old order —
 * while the markup stays this file's: both the mobile-cards branch and the desktop table are
 * rendered from the same `visibleColumns` array as before, kept mounted and CSS-hidden.
 * The existing prop contract is preserved for every current call site; everything enterprise
 * (server mode, error surface, filter accounting, column picker) is additive and opt-in.
 * `tsc` over the unchanged pages is the compatibility proof.
 */
export function DataTable<T extends { id: string }>(props: DataTableProps<T>) {
  const {
    rows, columns, onRowClick, searchLabel = 'חיפוש בטבלה',
    emptyTitle = 'אין נתונים להצגה', emptySubtitle, emptyAction, emptyIcon, toolbar, mobile = 'cards',
    mobileTitle, mobileTrailing, rowActions, rowLabel,
    error = null, activeFilters = 0, onClearFilters, columnPicker,
  } = props;
  const server = props.server;
  const searchFn = props.searchFn;
  const searchable = props.searchable ?? false;
  const pageSize = server ? server.pageSize : (props.pageSize ?? 15);

  const [q, setQ] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);

  // Server-mode search: the input is live per keystroke, the emit is debounced. A value pushed
  // from outside (URL restore, back navigation) syncs in; the ref keeps the two directions from
  // fighting over the box while a debounce is pending.
  const serverSearch = server?.search;
  const serverSearchRef = useRef(serverSearch);
  serverSearchRef.current = serverSearch;
  const [searchText, setSearchText] = useState(serverSearch?.value ?? '');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSearchValue = useRef(serverSearch?.value ?? '');
  useEffect(() => {
    const value = serverSearchRef.current?.value ?? '';
    if (value !== lastSearchValue.current) {
      lastSearchValue.current = value;
      setSearchText(value);
    }
  }, [serverSearch?.value]);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);
  const emitSearch = (value: string) => {
    setSearchText(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      lastSearchValue.current = value;
      serverSearchRef.current?.onChange(value);
    }, SEARCH_DEBOUNCE_MS);
  };

  // Column visibility is presentation state, owned here (not by the engine): the picker is
  // declared temporary (#80) and hiding a column must not disturb the row model.
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(
    () => readHiddenColumns(columnPicker, columns.map((c) => c.key)),
  );
  const setColumnVisible = (key: string, visible: boolean) => {
    setColumnVisibility((prev) => {
      const next = { ...prev, [key]: visible };
      if (columnPicker) {
        try {
          const hidden = columns.map((c) => c.key).filter((k) => next[k] === false);
          localStorage.setItem(COLUMN_PREFS_PREFIX + columnPicker, JSON.stringify(hidden));
        } catch { /* storage unavailable — the session still works, the preference just is not kept */ }
      }
      return next;
    });
  };

  const columnDefs = useMemo<ColumnDef<T>[]>(() => columns.map((c) => {
    const sortValue = c.sortValue as ((row: T) => string | number) | undefined;
    return {
      id: c.key,
      // The identity accessor exists for the engine's benefit: table-core refuses to include a
      // column in the global-filter pass unless it has an accessorFn, however getColumnCanGlobalFilter
      // answers. The value itself is never read — searchFn and sortingFn work on row.original.
      accessorFn: (row: T) => row,
      enableSorting: !!sortValue,
      // The exact comparator the old client sort used; react-table negates it for desc,
      // which is the same arithmetic as the old `* sort.dir`.
      ...(sortValue ? {
        sortingFn: (a: { original: T }, b: { original: T }) => {
          const va = sortValue(a.original);
          const vb = sortValue(b.original);
          return va < vb ? -1 : va > vb ? 1 : 0;
        },
      } : {}),
    };
  }), [columns]);

  // Sorting state only ever names a column that has a client comparator — same guard the old
  // `filtered` memo applied before sorting.
  const sorting = useMemo<SortingState>(() => {
    if (server || !sort) return [];
    const col = columns.find((candidate) => candidate.key === sort.key);
    return col?.sortValue ? [{ id: sort.key, desc: sort.dir === -1 }] : [];
  }, [server, sort, columns]);

  const table = useReactTable<T>({
    data: rows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: (row) => row.id,
    state: {
      sorting,
      pagination: { pageIndex: server ? server.page : page, pageSize },
      globalFilter: !server && q && searchFn ? q.toLowerCase() : undefined,
    },
    // In server mode the engine is told, in its own vocabulary, that every row model is manual:
    // the rows it holds are one already-filtered, already-sorted, already-sliced page.
    manualFiltering: !!server,
    manualSorting: !!server,
    manualPagination: !!server,
    rowCount: server ? server.total : undefined,
    // The caller's searchFn examines the whole row, so it must run once per row: only the first
    // column participates in the global filter pass.
    globalFilterFn: (row, _columnId, filterValue) =>
      searchFn ? searchFn(row.original, String(filterValue)) : true,
    getColumnCanGlobalFilter: (column) => column.id === columns[0]?.key,
  });

  const visibleColumns = useMemo(
    () => columns.filter((c) => columnVisibility[c.key] !== false),
    [columns, columnVisibility],
  );

  const filteredCount = server ? server.total : table.getFilteredRowModel().rows.length;
  const pageRows: T[] = server ? rows : table.getRowModel().rows.map((r) => r.original);
  const pages = server ? Math.max(1, Math.ceil(server.total / pageSize)) : Math.max(1, table.getPageCount());
  const currentPage = server ? server.page : page;

  // ADR-0007 fix: the old effect listened to [q, rows.length] and missed sort, so sorting while
  // on page 4 showed the wrong rows. In server mode the page is screen-owned URL state and this
  // effect's inputs never move.
  useEffect(() => { setPage(0); }, [q, rows.length, sort]);

  const hasActiveFilters =
    (server ? searchText !== '' || (serverSearch?.value ?? '') !== '' : q !== '') || activeFilters > 0;
  const isEmpty = filteredCount === 0;

  const clearFilters = () => {
    if (server) {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (serverSearch && (searchText !== '' || serverSearch.value !== '')) {
        lastSearchValue.current = '';
        setSearchText('');
        serverSearch.onChange('');
      }
    } else if (q !== '') {
      setQ('');
    }
    onClearFilters?.();
  };

  // Any screen that offers filtering gets the filter sheet. This used to read
  // `!!server || columnPicker !== undefined`, which meant a screen passing only `toolbar` and
  // `activeFilters` — orders, suppliers, credits, payment requests, exceptions, products,
  // inventory, price lists, documents — fell through to the legacy branch below, where the
  // toolbar renders inline at every width and the "סינון ותצוגה" sheet does not exist at all.
  // On a 390px phone that is filtering the user cannot reach. The trigger for the sheet is
  // having something to put in it, not which optional prop the screen happened to adopt.
  const enterprise = !!server || columnPicker !== undefined || !!toolbar || activeFilters > 0;
  // lg, not md. DESIGN.md:224-230 already unified the cards↔table swap with the app shell at `lg`
  // (owner ruling 09.08.2026) because a desktop table inside the phone frame is a tablet-in-
  // portrait bug; this toolbar kept the old `md` and so re-created the same split from the other
  // side — between 768 and 1023 the sheet vanished while the body was still cards.
  const isDesktop = useMediaQuery('(min-width: 64rem)');
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => { if (isDesktop) setSheetOpen(false); }, [isDesktop]);

  const visibleCount = visibleColumns.length;
  const pickerOptions: ColumnPickerOption[] | null = columnPicker === undefined ? null : columns.map((c) => {
    const visible = columnVisibility[c.key] !== false;
    return {
      key: c.key,
      header: c.header || c.key,
      visible,
      disabled: visible && visibleCount === 1,
      onToggle: (v: boolean) => setColumnVisible(c.key, v),
    };
  });

  const searchBox = (server ? !!serverSearch : searchable) && (
    <div className="relative flex-1 min-w-44 max-w-xs">
      <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint" />
      {server ? (
        <input className="input ps-9!" aria-label={searchLabel} placeholder="חיפוש..." value={searchText}
          onChange={(e) => emitSearch(e.target.value)} />
      ) : (
        <input className="input ps-9!" aria-label={searchLabel} placeholder="חיפוש..." value={q}
          onChange={(e) => setQ(e.target.value)} />
      )}
    </div>
  );

  const sheetHasContent = !!toolbar || pickerOptions !== null;

  const tableBody = error ? (
    // A failed fetch is a failed fetch. It must never render as "אין נתונים" (gate B30).
    <div className="p-4"><Note tone="alert" role="alert">{error}</Note></div>
  ) : isEmpty ? (
    hasActiveFilters ? (
      <EmptyState title="אין תוצאות לסינון הנוכחי" subtitle="שנה את הסינון או נקה אותו כדי לראות רשומות"
        action={<button type="button" className="btn-secondary" onClick={clearFilters}>נקה סינון</button>} />
    ) : (
      <EmptyState title={emptyTitle} subtitle={emptySubtitle} action={emptyAction} icon={emptyIcon} />
    )
  ) : (
    <>
          {mobile === 'cards' && (
            <ul className="lg:hidden divide-y divide-line-soft">
              {pageRows.map((row) => {
                const title = mobileTitle ? mobileTitle(row) : visibleColumns[0]?.render(row);
                const details = visibleColumns.filter((c, i) => (c.priority ?? 2) <= 2 && !(i === 0 && !mobileTitle));
                const body = (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 break-words font-medium text-ink-body">{title}</div>
                      {mobileTrailing && <div className="shrink-0">{mobileTrailing(row)}</div>}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-sm text-ink-mid">
                      {details.map((c) => {
                        const v = c.render(row);
                        if (v == null || v === '' ) return null;
                        const label = c.mobileLabel === undefined ? c.header : c.mobileLabel;
                        return (
                          <span key={c.key} className="inline-flex min-w-0 flex-wrap items-baseline gap-1">
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
                  <li key={row.id} className={`mobile-data-card ${rowActions ? 'flex items-start' : ''}`}>
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
                          <ActionMenu items={rowActions(row)} label={`פעולות עבור ${rowLabel?.(row) ?? row.id}`} />
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
          {/* A wide table is a keyboard-scrollable region, not a mouse-only viewport. tabIndex is
              intentionally on the scroller (not the table), so arrow keys move the clipped area. */}
          {/* The cards-to-table switch stays at `lg`, matching the shell (readiness package 5):
              at `md` the desktop table rendered inside the phone frame. */}
          <div className={mobile === 'cards' ? 'table-scroll overflow-x-auto hidden lg:block' : 'table-scroll overflow-x-auto'}
            role="region" aria-label="טבלת נתונים — ניתן לגלול אופקית" tabIndex={0}>
            <table className="w-full">
              <thead className="table-head border-b border-line-soft">
                <tr>
                  {visibleColumns.map((c) => {
                    // Sortable headers are real <button>s (audit 2026-07-21): keyboard focus,
                    // Enter/Space activation and the hover affordance come for free, and aria-sort
                    // exposes the active direction to a screen reader. Visual layout is unchanged —
                    // the button inherits .th's type via Tailwind's button reset. In server mode
                    // sortability comes from server.sortableColumns, and a click only reports the
                    // requested order — rows are never re-ordered locally.
                    let ariaSort: 'ascending' | 'descending' | 'none' | undefined;
                    let onSortClick: (() => void) | undefined;
                    if (server) {
                      if (server.sortableColumns.has(c.key)) {
                        const current = server.sort?.[0];
                        const active = current?.column === c.key ? current : undefined;
                        ariaSort = active ? ((active.ascending ?? true) ? 'ascending' : 'descending') : 'none';
                        onSortClick = () => server.onSortChange(active
                          ? [{ column: c.key, ascending: !(active.ascending ?? true) }]
                          : [{ column: c.key, ascending: true }]);
                      }
                    } else if (c.sortValue) {
                      const active = sort?.key === c.key;
                      ariaSort = active ? (sort?.dir === 1 ? 'ascending' : 'descending') : 'none';
                      onSortClick = () => setSort((s) => s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 });
                    }
                    return (
                      <th key={c.key} scope="col" className="th" aria-sort={ariaSort}>
                        {onSortClick ? (
                          <button type="button" className="inline-flex min-h-11 min-w-11 items-center gap-1 hover:text-shell-ink cursor-pointer focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2"
                            onClick={onSortClick}>
                            {c.header}{ariaSort === 'ascending' ? ' ↑' : ariaSort === 'descending' ? ' ↓' : ''}
                          </button>
                        ) : c.header}
                      </th>
                    );
                  })}
                  {rowActions && <th scope="col" className="th w-12"><span className="sr-only">פעולות</span></th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {pageRows.map((row) => {
                  return (
                    <tr key={row.id}
                      className={onRowClick ? 'row-hover cursor-pointer' : ''}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}>
                      {visibleColumns.map((c, index) => (
                        <td key={c.key} className={`td ${c.className ?? ''}`}>
                          {index === 0 && onRowClick ? (
                            <button type="button" className="min-h-11 w-full text-start focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2"
                              aria-label={rowLabel ? `פתיחת ${rowLabel(row)}` : undefined}
                              onClick={(event) => { event.stopPropagation(); onRowClick(row); }}>
                              {c.render(row)}
                            </button>
                          ) : c.render(row)}
                        </td>
                      ))}
                      {rowActions && (
                        <td className="td w-12 py-0.5!">
                          {/* stopPropagation on click: the row still navigates on mouse click, and
                              opening the menu must not also navigate. keydown is stopped too so
                              menu keys stay self-contained even if a row handler returns later. */}
                          <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                            <ActionMenu items={rowActions(row)} label={`פעולות עבור ${rowLabel?.(row) ?? row.id}`} />
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
    </>
  );

  return (
    <>
      <div className="card overflow-hidden" aria-busy={server?.fetching || undefined}>
        {enterprise ? (
          (searchBox || sheetHasContent || hasActiveFilters) ? (
            <div className="flex flex-wrap items-center gap-2 p-3 border-b border-line-soft">
              {searchBox}
              {isDesktop ? (
                <>
                  {toolbar}
                  {pickerOptions && <ColumnPickerPopover options={pickerOptions} />}
                  {hasActiveFilters && (
                    <button type="button" className="btn-ghost" onClick={clearFilters}>נקה סינון</button>
                  )}
                </>
              ) : sheetHasContent ? (
                // Below md the screen's filters, the column picker and the clear action live in
                // one sheet (UI-PLAN §2). The `toolbar` slot is mounted in exactly one of the two
                // places at a time, so no id inside it can duplicate (gate B6).
                <button type="button" className="btn-secondary" aria-haspopup="dialog" aria-expanded={sheetOpen}
                  onClick={() => setSheetOpen(true)}>
                  <SlidersHorizontal size={15} aria-hidden="true" /> סינון ותצוגה
                  {activeFilters > 0 && <span className="badge num bg-action-soft text-action-on-soft">{activeFilters}</span>}
                </button>
              ) : null}
            </div>
          ) : null
        ) : (searchable || toolbar) ? (
          <div className="flex flex-wrap items-center gap-2 p-3 border-b border-line-soft">
            {searchBox}
            {toolbar}
          </div>
        ) : null}
        {tableBody}
        {!error && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-line-soft text-sm text-ink-muted">
            {/* Unconditional and a live region (ADR-0007): the count is the filtered total —
                the server's COUNT in server mode — never a page length, and the element persists
                across states so a screen reader hears it change, including down to a true 0.
                An unavailable count never reaches here: it throws upstream (queryResult.ts). */}
            <span className="flex items-center gap-2">
              <span aria-live="polite">{filteredCount} רשומות</span>
              {server?.fetching && <Loader2 size={14} className="animate-spin text-ink-faint" aria-hidden="true" />}
            </span>
            {pages > 1 && (
              <div className="flex items-center gap-1">
                <button className="btn-ghost p-1.5! min-w-11 min-h-11" disabled={currentPage === 0}
                  onClick={() => (server ? server.onPageChange(server.page - 1) : setPage((p) => p - 1))}
                  aria-label="הקודם"><ChevronRight size={16} /></button>
                <span className="px-2">{currentPage + 1} / {pages}</span>
                <button className="btn-ghost p-1.5! min-w-11 min-h-11" disabled={currentPage >= pages - 1}
                  onClick={() => (server ? server.onPageChange(server.page + 1) : setPage((p) => p + 1))}
                  aria-label="הבא"><ChevronLeft size={16} /></button>
              </div>
            )}
          </div>
        )}
      </div>
      {enterprise && !isDesktop && (
        // The one mobile sheet, over the existing dialog layer (extracted, not rewritten):
        // Modal already runs on useDialogLayer and renders as a bottom sheet on phones.
        <Modal open={sheetOpen} onClose={() => setSheetOpen(false)} title="סינון ותצוגה">
          <div className="space-y-5">
            {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
            {pickerOptions && (
              <div>
                <div className="label">עמודות</div>
                <ColumnChecklist options={pickerOptions} />
              </div>
            )}
            {hasActiveFilters && (
              <button type="button" className="btn-secondary w-full" onClick={() => { clearFilters(); setSheetOpen(false); }}>
                נקה סינון
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
