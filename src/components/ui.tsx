import { useT } from '../lib/i18n/LocaleProvider';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, createContext, useContext, type ElementType, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Link, useLocation } from 'react-router';
import { ChevronRight, ChevronLeft, ChevronDown, ChevronUp, Search, X, Loader2, Inbox, Bell, Check, Columns3, SlidersHorizontal, AlertTriangle, Minus, Plus, TrendingUp, TrendingDown } from 'lucide-react';
import {
  useReactTable, getCoreRowModel, getFilteredRowModel, getPaginationRowModel, getSortedRowModel,
  type ColumnDef, type SortingState,
} from '@tanstack/react-table';
import type { StatusMeta, Tone } from '../lib/status';
import type { ServerSort } from '../lib/serverList';
import { MoneyByCurrency, totalsByCurrency } from './Money';
import type { MoneyAmount } from '../lib/types';
import { OPTIONAL_REASON_LABEL_KEY, reasonOr } from '../lib/reason';
import { routePresentationDescription } from '../lib/routePresentation';
import { pluralCategory } from '../lib/i18n/t';
import { INTL_LOCALE } from '../lib/i18n/locale';
import { ActionMenu, type ActionMenuItem } from './ActionMenu';

/* ---------- StatusBadge ---------- */
/**
 * Accepts either shape, and the second one is TRANSITIONAL. `StatusMeta` carries a dictionary key
 * — that is the extracted vocabulary. `{ label, tone }` is a badge whose text is composed at
 * runtime and has no fixed key to name it with: `documentUiStatus` builds one out of a stage, an
 * elapsed time and an entity. Those surfaces get their own extraction pass; until then this keeps
 * one badge component instead of two, and the `'key' in meta` test says out loud which is which.
 */
export function StatusBadge({ meta }: { meta: StatusMeta | { label: string; tone: Tone } | undefined }) {
  const { statusLabel } = useT();
  if (!meta) return null;
  return <span className={`badge-${meta.tone}`}>{'key' in meta ? statusLabel(meta) : meta.label}</span>;
}

/* ---------- The icon scale ---------- */
/**
 * lucide sizes, named. The audit counted nine different values in use — 15×158, 16×104, 17×59,
 * 13×41, 14×32, 18×26, 22×18, 19×8, 20×5 — with the same concept regularly appearing at three of
 * them: `Trash2` at 13/14/15/22, `Plus` at 12/14/15/16. That is not a taste problem, it is the
 * absence of a scale: with nothing to name, every author picks a plausible number.
 *
 * The six rungs are chosen to cost almost nothing to adopt: `sm`, `md` and `xs` are literally the
 * three most-used values today, so 258 of the existing sites land on a rung without moving a
 * pixel. Pass `ICON.sm`, never a bare number.
 */
export const ICON = {
  /** dense operator rows, inline meta lines */
  xs: 13,
  /** the default: buttons, row actions, menu items */
  sm: 15,
  /** section headings, panel titles */
  md: 17,
  /** mobile action bar, prominent controls */
  lg: 20,
  /** shell chrome — the phone header cluster */
  xl: 22,
  /** empty states and other single large marks */
  hero: 36,
} as const;

/* ---------- Card / SubPanel ---------- */
/**
 * `.card` and `.card-pad` are CSS utilities (index.css), and for a long time that was the whole
 * API: every screen composed the class string by hand. The audit found 161 uses spread across 65
 * distinct strings — `card card-pad`, `card card-pad space-y-4`, `card p-4`, `card card-pad
 * space-y-3`, `card overflow-hidden` — which is five different paddings and rhythms for what a
 * reader sees as one object. This is that object.
 *
 * `clip` is for a card whose child paints to the edge (a table, an image strip); without it the
 * child's corners escape the 24px radius.
 *
 * `as` exists because a card is a look, not a role. Plenty of them are really a `<section>` with
 * an `aria-labelledby`, or an `<li>` inside a list — and a primitive that could only emit a bare
 * `<div>` would have forced every one of those to opt out and go on composing the class string by
 * hand, which is the drift this component exists to end. Remaining props are spread onto the
 * element, so `aria-*`, `id` and handlers all pass through.
 */
export function Card({ pad = true, clip = false, as: Tag = 'div', className = '', children, ...rest }: {
  /** `false` for a card that supplies its own padding, e.g. one wrapping a table. */
  pad?: boolean;
  /** Clip children to the card's radius. */
  clip?: boolean;
  /**
   * The element or component to render. `section` and `li` keep a landmark or a list item; a
   * router `Link` makes the whole tile the target, which is what the dashboard's stat tiles and
   * the report's metric tiles actually are. Defaults to `div`.
   */
  as?: ElementType;
  className?: string;
  children: ReactNode;
} & Record<string, unknown>) {
  return <Tag className={`card ${pad ? 'card-pad' : ''} ${clip ? 'overflow-hidden' : ''} ${className}`} {...rest}>{children}</Tag>;
}

/**
 * The quiet panel *inside* a card — a recessed group that is part of the card, not a second card.
 * It had no primitive at all, so `rounded-2xl bg-surface-sunken p-3` was copy-pasted into 19
 * places. Deliberately not a `Card`: nesting a surface inside a surface reads as two objects.
 *
 * `as` for the same reason `Card` has it: four of the nine sites this replaced were an `<article>`
 * wrapping an `<h4>`, and a primitive that could only emit a `<div>` would have quietly stripped
 * their role. Remaining props spread onto the element.
 */
export function SubPanel({ as: Tag = 'div', className = '', children, ...rest }: {
  /** The element or component to render — `article`, `section`, `li`… Defaults to `div`. */
  as?: ElementType;
  className?: string;
  children: ReactNode;
} & Record<string, unknown>) {
  return <Tag className={`rounded-2xl bg-surface-sunken p-3 sm:p-4 ${className}`} {...rest}>{children}</Tag>;
}

/* ---------- Loading ----------
 * There is no page spinner, deliberately. It existed until 26.08.2026 and the owner removed it:
 * "אם יש לי כבר שלד אין צורך בסמל הזה". The argument the old component's own comment was making
 * against itself — a centred spinner throws away the page title and collapses the height, so the
 * whole screen jumps when data lands — turned out to apply to every one of its twenty call sites,
 * including the auth gates it claimed to exist for. Each became the Skeleton* that mirrors the
 * shape the screen is about to be, and the component and its figure were deleted rather than left
 * as an option, because an option is an invitation.
 * Nothing here needs to be replaced. Pick the shape: SkeletonTable, SkeletonCards, SkeletonList,
 * RecordSkeleton — or write the shape the screen actually has.
 */

/* ---------- Skeletons ---------- */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden />;
}

// One wrapper for every skeleton: screen readers get a single "טוען" instead of
// narrating a wall of empty boxes.
function SkeletonRegion({ children }: { children: ReactNode }) {
  const { t } = useT();
  return (
    <div role="status" aria-busy="true" className="space-y-4">
      <span className="sr-only">{t('ui.text')}</span>
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
  const { t } = useT();
  return (
    <nav aria-label={t('ui.aria_label')} className="text-xs text-ink-muted">
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
              {!current && <ChevronLeft size={ICON.xs} aria-hidden="true" className="shrink-0 text-ink-ghost" />}
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

export function PageHeader({ title, description, meta, breadcrumbs, actions, className = '' }: {
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  breadcrumbs?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  // Omitting the prop opts INTO the catalogue; `description={null}` is the explicit opt-out. JSX
  // cannot tell an absent prop from `description={undefined}`, so the opt-out has to be a value
  // that is not `undefined` — hence the identity check rather than a falsy one.
  const { pathname } = useLocation();
  const { t } = useT();
  // The catalogue hands back a KEY, and this line used to render it. `TKey` is a string and
  // `description` is a `ReactNode`, so `tsc` was clean while every catalogued screen printed
  // `nav.routeDesc_inventory` under its title, in both languages. A screenshot found it.
  const catalogued = routePresentationDescription(pathname);
  const resolvedDescription = description === undefined ? (catalogued && t(catalogued)) : description;
  return (
    <header className={`flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between ${className}`}>
      <div className="min-w-0 space-y-1">
        {breadcrumbs}
        <h1 className="page-title break-words">{title}</h1>
        <SectionMark />
        {resolvedDescription && <div className="text-sm text-ink-muted">{resolvedDescription}</div>}
        {meta && <div className="text-sm text-ink-soft">{meta}</div>}
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
  const { t } = useT();
  const currentIndex = steps.findIndex((step) => step.key === current);
  const percent = progress && progress.total > 0
    ? Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
    : null;
  // How far the process itself has come, in steps. Owner ruling 25.08.2026: "instead of numbers,
  // show a progress bar". The numbered discs were the wrong instrument twice over — a reader does
  // not care that reading is step two, and „4" on the last disc invited the same off-by-one the
  // setup screen had. A filled track answers the question the numbers were standing in for (how
  // much is left) without asking anyone to count. It is derived, never animated for effect: a
  // stopped process shows the ground it actually covered and no more.
  const stepPercent = currentIndex < 0 || steps.length === 0
    ? 0
    : Math.round(((failed ? currentIndex : currentIndex + 1) / steps.length) * 100);
  return (
    <div className="rounded-2xl bg-surface-sunken p-3">
      {/* aria-hidden: the <ol> below already exposes the same fact to a screen reader through
          aria-current, and a second announcement of it would be noise, not redundancy. */}
      <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-line-soft" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${failed ? 'bg-alert-solid' : 'bg-action'}`}
          style={{ width: `${stepPercent}%` }}
        />
      </div>
      <ol aria-label={t('ui.aria_label_2')} className="flex min-w-0 flex-wrap items-center gap-y-2 overflow-x-auto pb-1">
        {steps.map((step, index) => {
          const isCurrent = index === currentIndex;
          const isComplete = currentIndex >= 0 && index < currentIndex;
          const isStopped = isCurrent && failed;
          // One hue on the strip instead of three. The current step is the only SOLID mark, so it
          // already says "here" -- repeating that in a third label colour beside it only competes
          // with the marker. Done and future therefore share the quiet label; the marker (check vs
          // number) carries the difference, so meaning never rests on hue alone.
          const text = isStopped ? 'text-alert-fg' : isCurrent ? 'text-ink-body' : 'text-ink-muted';
          // The current marker is OCEANIC, not sky (owner ruling 25.08.2026, from a live phone
          // screenshot: „this doesn't look like the app — not the design and not the colours").
          // `info` is spoken for: DESIGN.md gives sky exactly one meaning, „the ball is with an
          // outside party", and a document being read is the system working, not somebody else's
          // turn. Sky also appears nowhere else in the operator surfaces, so the bright disc read
          // as a foreign element rather than as a state. `bg-action` is the same mark the setup
          // wizard already puts on its active step — one language for „you are here".
          const marker = isStopped
            ? 'border-alert-line bg-alert-soft'
            : isCurrent ? 'border-transparent bg-action text-on-solid' : isComplete ? 'border-done-line bg-done-soft' : 'border-line-strong bg-surface text-ink-muted';
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
                {/* No number. The mark says which of four states this step is in — stopped, done,
                    here, not yet — and the bar above says how far along the process is. A digit
                    said neither, and on the last step it said „4" beside a heading that promised
                    something else. `size-5` because a dot needs less room than a digit did. */}
                <span className={`flex size-5 shrink-0 items-center justify-center rounded-full border ${marker}`} aria-hidden="true">
                  {isStopped ? <AlertTriangle size={11} /> : isComplete ? <Check size={11} /> : null}
                </span>
                {step.label}
                {isCurrent && <span className="sr-only">{isStopped ? t('ui.text_2') : t('ui.text_3')}</span>}
              </span>
              {index < steps.length - 1 && <ChevronLeft size={ICON.sm} className="mx-2 shrink-0 text-ink-ghost" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      {detail && <div className="mt-2 text-xs text-ink-soft">{detail}</div>}
      {/* Below `detail` on purpose, so the strip reads step -> what it is doing -> how far. */}
      {progress && percent !== null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-valuetext={progress.label}
          className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line"
        >
          {/* Petrol is structure here, never a verdict: the fill says how much, not whether it
              went well. Width only, so reduced-motion cancels it with the shared transition rule. */}
          <div className="h-full rounded-full bg-action transition-[width] duration-200 ease-out" style={{ width: `${percent}%` }} />
        </div>
      )}
      {nextAction && (
        <div className="mt-2 border-t border-line-soft pt-2 text-sm text-ink-body">
          {/* The label steps back; the action itself keeps the body ink from the wrapper. */}
          <span className="font-medium text-ink-muted">{t('ui.text_4')}</span> {nextAction}
        </div>
      )}
    </div>
  );
}

/**
 * `compact` is for an empty state inside something — a panel in a dialog, a sub-section of a card.
 * The page-sized form spends 128px of padding and a 36px mark saying nothing is here, which is
 * right when the empty thing IS the screen and far too heavy when it is one block within it.
 * `className` is the escape hatch for the print rule: the monthly report is also the page the
 * accountant receives, and a large centred mark is not what belongs on A4.
 */
export function EmptyState({ title, subtitle, action, icon, compact = false, className = '' }: {
  title: string; subtitle?: string; action?: ReactNode; icon?: ReactNode; compact?: boolean; className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'py-6' : 'py-16'} ${className}`}>
      <span aria-hidden="true" className={compact ? 'mb-2 text-ink-ghost' : 'mb-3 text-ink-ghost'}>{icon ?? <Inbox size={compact ? ICON.lg : ICON.hero} />}</span>
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
export function Disclosure({ title, count, tone = 'idle', summary, name, id, className = '', onToggle, children }: {
  title: string;
  /** Stable handle for a screen that has to open the fold on the reader's behalf. */
  id?: string;
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
    <details name={name} id={id} className={`group ${className}`} onToggle={(event) => onToggle?.(event.currentTarget.open)}>
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5 text-sm hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden sm:px-4">
        <span className="font-medium text-ink-body">{title}</span>
        {count != null && <span className={`badge-${tone} num`}>{count}</span>}
        {summary != null && <span className="ms-auto min-w-0 text-end text-xs text-ink-muted">{summary}</span>}
        <ChevronDown size={ICON.sm} aria-hidden="true"
          className={`shrink-0 text-ink-ghost transition-transform duration-200 ease-out group-open:rotate-180 motion-reduce:transition-none ${summary == null ? 'ms-auto' : ''}`} />
      </summary>
      <div className="border-t border-line-soft px-3 pb-4 pt-3 sm:px-4">{children}</div>
    </details>
  );
}

/* ---------- Tabs ---------- */
export interface TabItem { key: string; label: ReactNode }

/** `tabId`/`panelId` are exported so a caller wiring its own panels cannot drift from the list. */
export const tabId = (prefix: string, key: string) => `${prefix}-tab-${key}`;
export const panelId = (prefix: string, key: string) => `${prefix}-panel-${key}`;

/**
 * The app's one tablist. Until now there was none, so the single tab set in the product (the
 * supplier card) hand-rolled it, and three *other* screens hand-rolled segmented controls that are
 * not tabs at all — see ToggleGroup below for those.
 *
 * Roving tabindex per WAI-ARIA: exactly one tab is in the tab order and the arrows move between
 * them. The arrows are swapped for RTL on purpose — ArrowLeft advances, because in a right-to-left
 * strip the next tab is the one to the left.
 *
 * FOCUS MOVES SYNCHRONOUSLY, and that is a correction (26.08.2026). It used to move in a
 * `requestAnimationFrame`, on the stated grounds that "the element being focused may not exist
 * until the state change has rendered" — which was never true here: this strip renders EVERY tab
 * on every render, and `value` only decides which one is selected. Nothing appears or disappears,
 * so there was never a missing element to wait for.
 *
 * What the frame delay did produce was a race, and not only in tests. `onKeyDown` closes over the
 * pressed tab's `index`, and keys land on `document.activeElement`. Between the press and the
 * frame, focus is still on the OLD tab — so a second key arriving inside that window runs the old
 * closure with the old index and moves to the wrong tab. A person holding an arrow key, or a
 * screen-reader user stepping quickly, generates keys faster than one per frame. The unit test
 * that caught this on a loaded runner was reporting a product defect, not test flake.
 *
 * `flushSync` is what makes the synchronous focus honest rather than merely fast: it commits the
 * new `aria-selected`/`tabIndex` BEFORE focus lands, so a screen reader announces the tab as
 * selected instead of announcing the state the strip is about to leave. Focusing first and
 * committing after would have closed the race and opened that one.
 *
 * Renders the strip only. Panels stay with the caller, wired through panelId, so a heavy panel is
 * still the caller's to mount or skip.
 */
export function Tabs({ items, value, onChange, label, idPrefix, className = '' }: {
  items: readonly TabItem[];
  value: string;
  onChange: (key: string) => void;
  /** Names the strip for a screen reader, e.g. "מידע עבור ספק X". */
  label: string;
  /** Namespaces the generated ids; must match what the caller passes to panelId. */
  idPrefix: string;
  className?: string;
}) {
  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index;
    if (event.key === 'ArrowLeft') next = (index + 1) % items.length;
    else if (event.key === 'ArrowRight') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    flushSync(() => onChange(items[next].key));
    document.getElementById(tabId(idPrefix, items[next].key))?.focus();
  }
  return (
    <div role="tablist" aria-label={label} className={`no-print flex gap-1 overflow-x-auto border-b border-line ${className}`}>
      {items.map((item, index) => (
        <button key={item.key} id={tabId(idPrefix, item.key)} role="tab" type="button"
          aria-selected={value === item.key} aria-controls={panelId(idPrefix, item.key)}
          tabIndex={value === item.key ? 0 : -1}
          onKeyDown={(event) => onKeyDown(event, index)} onClick={() => onChange(item.key)}
          className={`-mb-px min-h-11 border-b-2 px-4 py-2 text-sm whitespace-nowrap ${value === item.key ? 'border-action-solid font-medium text-action' : 'border-transparent text-ink-muted hover:text-ink-mid'}`}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** The panel half of Tabs. Render it only for the active key; it carries the aria wiring. */
export function TabPanel({ idPrefix, tabKey, className = '', children }: {
  idPrefix: string; tabKey: string; className?: string; children: ReactNode;
}) {
  return <div role="tabpanel" id={panelId(idPrefix, tabKey)} aria-labelledby={tabId(idPrefix, tabKey)} className={className}>{children}</div>;
}

/* ---------- ToggleGroup ---------- */
/**
 * Pick one of N, where nothing swaps a panel: a status filter, a billing interval, a decision on a
 * receiving line. Not Tabs — a tab controls a region and owes it aria-controls; this owes nothing
 * and simply reports which option is pressed.
 *
 * The audit found fifteen implementations of this control across thirteen distinct class strings.
 * Seven of them applied chip-filter-active INSTEAD of chip-filter, and since the base rule is where
 * min-h-11, the radius, the padding and the focus ring live, those seven had the *selected* chip be
 * the one with no height floor and no focus ring. Here the modifier can only ever add.
 *
 * Two modes, because two of the fifteen were never pick-one at all — a supplier's delivery days is
 * a set, not a choice. Pass a `T` for single select, a `readonly T[]` for multi; `onChange` reports
 * the key that was pressed either way, and the caller owns the set arithmetic. `aria-pressed` is
 * correct for both: these are toggle buttons reporting their own state, not radios owning a region.
 *
 * Not every pick-one control belongs here. A group whose selected item is coloured by MEANING —
 * a receiving line that is full / partial / missing — must keep its tone map: this paints the
 * selection in the one action colour, which would flatten five statuses into one.
 */
export function ToggleGroup<T extends string>({ items, value, onChange, label, className = '' }: {
  /**
   * `className` is per-item on purpose: a filter strip may hide a rare chip below `sm`.
   * `testId` is here because converting a hand-rolled control should never cost its selectors —
   * a primitive that forces every caller to rewrite its tests is a primitive people route around.
   */
  items: readonly { key: T; label: ReactNode; disabled?: boolean; className?: string; testId?: string }[];
  /** A key for pick-one; an array of keys for multi-select. */
  value: T | readonly T[];
  onChange: (key: T) => void;
  label: string;
  className?: string;
}) {
  const selected = (key: T) => (Array.isArray(value) ? (value as readonly T[]).includes(key) : value === key);
  return (
    <div role="group" aria-label={label} className={`flex flex-wrap gap-2 ${className}`}>
      {items.map((item) => (
        <button key={item.key} type="button" data-testid={item.testId} disabled={item.disabled} aria-pressed={selected(item.key)}
          onClick={() => onChange(item.key)}
          className={`chip-filter ${selected(item.key) ? 'chip-filter-active' : ''} disabled:cursor-not-allowed disabled:opacity-50 ${item.className ?? ''}`}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- MonthPicker ---------- */
/**
 * A month chosen in the reader's language, because `<input type="month">` is not.
 *
 * WHY THIS EXISTS AND THE NATIVE CONTROL DOES NOT DO. `<input type="month">` renders a month NAME,
 * and Chrome draws it in CHROME's UI language — not the page's `lang`, not `navigator.language`.
 * Measured across three browser locales on a `lang="en"` page and it printed `אוגוסט 2026` in all
 * three (`artifacts/i18n-audit-20260830/DATE-PICKER.md`). Its sibling `<input type="date">` is
 * fine — it renders digits — which is exactly why the first audit looked past this one.
 *
 * So the month name has to come from us. `Intl.DateTimeFormat(INTL_LOCALE[locale])` is the same
 * door `fmtMonth` walks through after Stage 6, and for the same reason.
 *
 * THE VALUE IS UNCHANGED: `YYYY-MM`, or `''` where a filter means "every month". Every caller
 * keeps its query, its `safeMonthISO`, its `monthRange` and its URL parameter untouched — this
 * replaces a control, not a contract.
 *
 * WHY TWO SELECTS AND NOT A CALENDAR. A month is two independent choices and a calendar is a grid
 * of days; the native control's own popup is a month grid for exactly that reason. Two selects are
 * also the one shape that needs no new keyboard contract: a `<select>` already opens on Alt+Down,
 * types-to-select, and announces itself.
 */
export function MonthPicker({
  value, onChange, label, id, disabled = false, allowEmpty = false, className = '',
}: {
  /** `YYYY-MM`, or `''` when `allowEmpty` and no month is chosen. */
  value: string;
  onChange: (value: string) => void;
  /** The accessible name of the pair. Each select gets its own name derived from it. */
  label: string;
  id?: string;
  disabled?: boolean;
  /** Filters allow "no month"; a report that must have one does not. */
  allowEmpty?: boolean;
  className?: string;
}) {
  const { t, locale } = useT();
  const generatedId = useId();
  const base = id ?? generatedId;

  const months = useMemo(() => {
    const format = new Intl.DateTimeFormat(INTL_LOCALE[locale], { month: 'long', timeZone: 'UTC' });
    return Array.from({ length: 12 }, (_, index) => ({
      value: String(index + 1).padStart(2, '0'),
      label: format.format(new Date(Date.UTC(2000, index, 1))),
    }));
  }, [locale]);

  const [chosenYear, chosenMonth] = value ? value.split('-') : ['', ''];

  /**
   * Six years back and one forward, and ALWAYS the year already chosen. Without that last clause a
   * stored filter older than the window would silently vanish from its own control — the reader
   * would see a blank where their choice was, and changing the month would move the year too.
   */
  const years = useMemo(() => {
    const current = new Date().getUTCFullYear();
    const span = new Set<string>();
    for (let year = current - 6; year <= current + 1; year += 1) span.add(String(year));
    if (chosenYear) span.add(chosenYear);
    return [...span].sort((a, b) => Number(b) - Number(a));
  }, [chosenYear]);

  // One half emptied means no month at all: a year without a month is not a filter this app has.
  const emit = (year: string, month: string) => onChange(year && month ? `${year}-${month}` : '');

  return (
    <div role="group" aria-label={label} className={`flex items-center gap-2 ${className}`}>
      <select id={`${base}-month`} className="input w-auto!" disabled={disabled}
        aria-label={t('common.monthOf', { label })}
        value={chosenMonth} onChange={(event) => emit(chosenYear || String(new Date().getUTCFullYear()), event.target.value)}>
        {allowEmpty && <option value="">{t('common.anyMonth')}</option>}
        {months.map((month) => <option key={month.value} value={month.value}>{month.label}</option>)}
      </select>
      <select id={`${base}-year`} className="input w-auto! num" disabled={disabled}
        aria-label={t('common.yearOf', { label })}
        value={chosenYear} onChange={(event) => emit(event.target.value, chosenMonth || '01')}>
        {allowEmpty && <option value="">{t('common.anyYear')}</option>}
        {years.map((year) => <option key={year} value={year}>{year}</option>)}
      </select>
    </div>
  );
}


/* ---------- Stepper ---------- */
/**
 * Press-and-hold cadence on the ± buttons, at the values react-aria's NumberField has measured
 * into its own steppers: 400ms before the first repeat, then one every 60ms.
 *
 * Adopted as behaviour, not as a dependency. The candidate
 * (originui/input/number-input-with-plus-minus-buttons) gets this by delegating to
 * `react-aria-components`' NumberField — which would have brought its own DOM, its own focus
 * ring and its own 36px sizing to replace a control that already clamps at both bounds, already
 * holds the 44px floor, already carries `inputRef`/`inputStep`/`inputClassName` for two live call
 * sites, and is already tested. The repeat loop is the only part of it we did not have.
 */
const HOLD_REPEAT_DELAY_MS = 400;
const HOLD_REPEAT_TICK_MS = 60;

/**
 * One quantity control. There were two, sharing no code: the cart used a raw size-11 grid with 14px
 * icons and a read-only span, receiving used btn-secondary p-3! with 18px icons and a number input
 * — and neither disabled at the floor, so the minus key kept firing at zero.
 *
 * The value stays an input: typing 24 beats pressing plus twenty-four times, and the read-only
 * variant was the smaller of the two behaviours. Clamping is expressed as disabled rather than
 * silently swallowed in the handler, because a control that accepts a press and does nothing
 * teaches the user that the app is unreliable.
 */
export function Stepper({ value, onChange, min = 0, max, step = 1, inputStep, label, decrementLabel, incrementLabel, disabled = false, inputRef, inputClassName = '', className = '' }: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** The button increment. Fractional steps are fine. */
  step?: number;
  /**
   * The input's own `step` attribute, when it differs from the button increment. Receiving weighs
   * goods — ק"ג, ליטר — so its field must accept 2.5 while the buttons still move by 1. Without
   * this the field declares a constraint the domain does not have: the value is still accepted and
   * saved, but `checkValidity()` reports false, which stays latent only until someone wraps the
   * control in a `<form>` or styles `:invalid`. Pass `'any'` for a continuous quantity.
   */
  inputStep?: number | 'any';
  /** Names the group and the number input for a screen reader, e.g. "כמות עבור עגבניות". */
  label: string;
  /**
   * The two button names, when the call site has a better SENTENCE than a composition can build.
   *
   * The default — `הפחתה — ${label}` / `הוספה — ${label}` — is a fallback, not the target. Hebrew
   * puts a verbal noun into the construct state to take an object (‏הפחתה → הפחתת), and no prefix
   * template can perform that inflection: the composed name is a fragment plus an em dash plus a
   * second fragment, where the hand-written one is a sentence. Receiving and the cart both HAD the
   * sentence — „הגדלת הכמות שהתקבלה עבור עגבניות", „הוספת כמות עגבניות" — and converging on the
   * shared control silently traded it for the fragment. Convergence removes accidental difference;
   * a name a screen-reader user has been hearing for months is not accidental.
   *
   * Passing one and not the other is a mistake the type cannot catch, so pass both or neither.
   */
  decrementLabel?: string;
  incrementLabel?: string;
  disabled?: boolean;
  /**
   * A handle on the number input. Receiving needs it: a barcode scan that matches a line scrolls to
   * that line and focuses its quantity field. A primitive with no handle would have killed that
   * silently — the control would still look right and the scanner would just stop working.
   */
  inputRef?: Ref<HTMLInputElement>;
  /**
   * Extra classes for the number input itself. `className` lands on the wrapper, and the one
   * legitimate reason to reach past it is emphasis: on the receiving screen this figure is read at
   * arm's length by someone holding a crate, so it is `w-24! text-lg! font-semibold` there and the
   * shared default everywhere else. Convergence removes accidental difference, not deliberate
   * difference — and the alternative, an arbitrary descendant variant on the wrapper, would bake
   * this component's internal DOM into a call site and resolve by an important-vs-important
   * specificity race.
   */
  inputClassName?: string;
  className?: string;
}) {
  const { t } = useT();
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min, n));
  const atMin = value <= min;
  const atMax = max != null && value >= max;

  // Set only while the person has the field open and empty — see the input's onChange below.
  const [emptied, setEmptied] = useState(false);
  // Any press of ± is a new number, so it also closes an empty field: without this, stepping while
  // the field is blank would move the real quantity behind a box that still looks empty.
  const stepTo = (next: number) => { setEmptied(false); onChange(next); };

  // The repeat loop reads the value from a ref rather than from the closure: a tick fires every
  // 60ms and must see the value the previous tick produced, not the one captured when the press
  // began. Synced on every render so a parent that clamps differently — or refuses the change —
  // stalls the loop instead of running away from the truth.
  const valueRef = useRef(value);
  valueRef.current = value;
  const holdTimers = useRef<{ delay?: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval> }>({});
  const stopHold = useCallback(() => {
    clearTimeout(holdTimers.current.delay);
    clearInterval(holdTimers.current.tick);
    holdTimers.current = {};
  }, []);
  useEffect(() => stopHold, [stopHold]);

  /**
   * `onClick` still owns the single step, so a tap is exactly one step and keyboard activation —
   * which produces a click with no pointerdown at all — is untouched. The hold adds only the
   * REPEATS, and only after the delay. Release is listened for on the window because the button
   * disables itself the instant the value reaches its bound, and a disabled button fires no
   * pointerup: without this, holding minus down to zero would leave the loop running.
   */
  const startHold = (delta: number) => {
    if (disabled) return;
    setEmptied(false);
    stopHold();
    const end = () => {
      stopHold();
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    holdTimers.current.delay = setTimeout(() => {
      holdTimers.current.tick = setInterval(() => {
        const next = clamp(valueRef.current + delta);
        if (next === valueRef.current) { end(); return; }
        valueRef.current = next;
        onChange(next);
      }, HOLD_REPEAT_TICK_MS);
    }, HOLD_REPEAT_DELAY_MS);
  };

  /*
   * The GROUP carries no name, and that is deliberate. It used to repeat `label`, which the input
   * below also carries — so a screen reader announced the same words twice, once on entering the
   * group and once on reaching the field. That is the defect `PlanBadge` had with an identical
   * `aria-label` and `title`, in a second place.
   * Nothing is lost by dropping it: since 26.08.2026 both buttons carry full sentences of their
   * own (`הגדלת הכמות שהתקבלה עבור X`), so no child depends on the group for context. The role
   * stays — it still binds the three controls together as one widget.
   * It also made every `[aria-label="כמות X"]` selector ambiguous, which is how this surfaced:
   * the browser gate resolved two elements and refused to guess.
   */
  return (
    <div role="group" className={`flex items-center gap-1.5 ${className}`}>
      {/* `select-none touch-manipulation`: a press-and-hold on a phone is also the gesture for
          select-text and the callout menu, and neither belongs on a quantity button. */}
      <button type="button" className="btn-secondary btn-icon select-none touch-manipulation" disabled={disabled || atMin}
        aria-label={decrementLabel ?? t('uiTail.decrement', { label })} onPointerDown={() => startHold(-step)} onClick={() => stepTo(clamp(value - step))}>
        <Minus size={ICON.sm} aria-hidden="true" />
      </button>
      <input ref={inputRef} type="number" className={`input num w-20! text-center ${inputClassName}`} value={emptied ? '' : value} min={min} max={max} step={inputStep ?? step}
        inputMode="decimal" disabled={disabled} aria-label={label}
        onChange={(event) => {
          /*
           * An empty field is not a number, and `Number('')` is 0 — not NaN. The old guard tested
           * only for NaN, so clearing the field reported a real zero, which the clamp turned into
           * `min`: someone who cleared the quantity to type 24 got `min` the instant the field
           * emptied and then typed into a value they never chose.
           *
           * Refusing to report the empty string is necessary but NOT sufficient, and this is the
           * part that is easy to get wrong — React re-syncs a controlled input's DOM value back to
           * `value` after an input event that produced no state change, so a handler that merely
           * returns leaves the field refilling itself with the old number, caret after it, and the
           * same trap one keystroke later. Measured before `emptied` existed: clearing a field
           * showing 5 and typing "24" reported 524.
           *
           * `emptied` is that one keystroke of local truth. While it is set the field renders
           * empty; a real number clears it, and so does blur — a field left blank returns to the
           * quantity rather than staying a hole. Genuine out-of-range input is still clamped;
           * the clamp was never the defect. A `type="number"` input also reports '' for a value
           * the browser cannot parse yet ("2e", "-"), so those hold the field open too.
           */
          const raw = event.target.value;
          if (raw.trim() === '') { setEmptied(true); return; }
          setEmptied(false);
          const next = Number(raw);
          if (!Number.isNaN(next)) onChange(clamp(next));
        }}
        onBlur={() => setEmptied(false)} />
      <button type="button" className="btn-secondary btn-icon select-none touch-manipulation" disabled={disabled || atMax}
        aria-label={incrementLabel ?? t('uiTail.increment', { label })} onPointerDown={() => startHold(step)} onClick={() => stepTo(clamp(value + step))}>
        <Plus size={ICON.sm} aria-hidden="true" />
      </button>
    </div>
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
  /**
   * Optional money figure at the row end, and it is a LIST because a row can be about two
   * currencies at once (0217, #277): "4 invoices awaiting approval" can be ₪12,400 and $3,100,
   * and adding them would be the false total this product exists not to print. One entry renders
   * exactly as the single figure always did.
   */
  amounts?: readonly MoneyAmount[] | null;
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
function AttentionRow({ item, muted, baseCurrency }: {
  item: AttentionItem; muted?: boolean; baseCurrency: string | null | undefined;
}) {
  const measured = item.count != null;
  return (
    <li>
      <Link to={item.to} className="flex min-h-11 items-center gap-3 py-2.5 -mx-2 px-2 rounded-lg hover:bg-surface-hover active:bg-surface-selected transition-colors">
        <span className={`${measured ? `badge-${item.tone}` : 'badge-idle'} num justify-center min-w-8`}>{item.count ?? '—'}</span>
        <span className="min-w-0 leading-snug">
          <span className={muted ? 'text-ink-soft' : 'text-ink-body font-medium'}>{item.label}</span>
          {item.hint && <span className="ms-2 text-xs text-ink-muted max-sm:block max-sm:ms-0 max-sm:mt-0.5">{item.hint}</span>}
        </span>
        {(item.amounts?.length ?? 0) > 0 && (
          <MoneyByCurrency
            amounts={item.amounts}
            baseCurrency={baseCurrency}
            shape="rounded"
            empty=""
            className={`text-sm ${muted ? 'font-medium text-ink-soft' : 'font-semibold text-ink-mid'}`}
          />
        )}
        <ChevronLeft size={ICON.sm} className="text-ink-ghost shrink-0" aria-hidden="true" />
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
export function AttentionZone({ items, totalLabel, baseCurrency, className = '' }: {
  items: AttentionItem[];
  totalLabel?: string;
  /** The organisation's own currency — the ORDER money is listed in, never a conversion target. */
  baseCurrency: string | null | undefined;
  /** Caller-supplied classes on the card root. The owner dashboard uses it to declare this zone's
   *  entrance step, which differs between phone and desktop since the money band moves. */
  className?: string;
}) {
  const { t } = useT();
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
  // Summed WITHIN each currency and never across them. Two currencies produce two lines in the
  // header, which is the only honest shape for "what needs action today" when the answer is in
  // two kinds of money.
  const actionTotals = totalsByCurrency(actionRows.flatMap((i) => i.amounts ?? []));
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
          <Bell size={ICON.md} aria-hidden="true"
            className={actionRows.length === 0 ? 'text-ink-ghost' : headlineTone === 'alert' ? 'text-alert-fg' : 'text-await-fg'} />
          {t('ui.text_5')}
          {actionRows.length > 0 && (
            <span className={`${headlineTone === 'alert' ? 'badge-alert' : 'badge-await'} num`}>
              {actionRows.length}<span className="sr-only"> {t('ui.text_6')}</span>
            </span>
          )}
        </h2>
        {actionTotals.length > 0 && (
          <span className="text-xs text-ink-muted">
            {totalLabel ? <>{totalLabel} </> : null}
            <MoneyByCurrency amounts={actionTotals} baseCurrency={baseCurrency} shape="rounded" empty="" />
          </span>
        )}
      </div>

      {actionRows.length > 0 ? (
        /* T7: one column. The zone now lives in a half-width tile of the dashboard grid (the
           reference's side list), where two columns of long Hebrew labels wrapped every row. */
        <ul className="grid grid-cols-1">
          {actionRows.map((i) => <AttentionRow key={i.key} item={i} baseCurrency={baseCurrency} />)}
        </ul>
      ) : unknownRows.length > 0 ? (
        /* Not everything could be measured, so the green all-clear is a claim we are not entitled
           to make (an undated payment request may well be overdue) — but silence was worse: a
           brand-new organization has two unmeasurable rows by design, so the largest card on its
           first screen used to render a heading above nothing at all. Neutral ink, and no number:
           the count already rides the disclosure badge four lines below. */
        <div className="text-sm text-ink-soft py-1">{t('ui.text_7')}</div>
      ) : (
        <div className="text-sm text-done-fg py-1">{t('ui.text_8')}</div>
      )}

      {(noticeRows.length > 0 || unknownRows.length > 0 || clear.length > 0) && (
        <details className="group mt-2 border-t border-line-soft">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-sm text-ink-muted hover:bg-surface-hover active:bg-surface-selected focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
            <ChevronLeft size={ICON.sm} className="shrink-0 transition-transform group-open:-rotate-90" aria-hidden="true" />
            <span className="font-medium text-ink-soft">{t('ui.text_9')}</span>
            {/* The count rides its label — a badge orphaned at the far edge reads as debris. */}
            <span className="badge-idle num">{noticeRows.length + unknownRows.length + clear.length}</span>
          </summary>

          {noticeRows.length > 0 && (
            <div className="pt-2">
              <div className="text-xs font-medium text-ink-muted mb-1">{t('ui.text_10')}</div>
              <ul className="divide-y divide-line-soft">
                {noticeRows.map((i) => <AttentionRow key={i.key} item={i} muted baseCurrency={baseCurrency} />)}
              </ul>
            </div>
          )}

          {unknownRows.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line-soft">
              <div className="text-xs font-medium text-ink-muted mb-1">{t('ui.text_11')}</div>
              <ul className="divide-y divide-line-soft">
                {unknownRows.map((i) => <AttentionRow key={i.key} item={i} muted baseCurrency={baseCurrency} />)}
              </ul>
            </div>
          )}

          {clear.length > 0 && (
            <div className="mt-2 pt-2 border-t border-line-soft flex flex-wrap gap-x-4 gap-y-1.5 pb-1 text-xs text-ink-muted">
              {clear.map((i) => (
                <span key={i.key} className="inline-flex items-center gap-1"><Check size={ICON.xs} className="text-done-fg shrink-0" aria-hidden="true" /> {i.clearLabel ?? i.label}</span>
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

export function useDialogLayer<T extends HTMLElement>({ open, onClose, busy = false, allowCloseWhileBusy = false, initialFocus, modal = true }: {
  open: boolean;
  onClose: () => void;
  busy?: boolean;
  allowCloseWhileBusy?: boolean;
  initialFocus?: (panel: T) => HTMLElement | null;
  /** False keeps the layer focusable and closeable without locking or trapping the page. */
  modal?: boolean;
}) {
  const panelRef = useRef<T>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const tokenRef = useRef(Symbol('dialog'));
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  const allowCloseRef = useRef(allowCloseWhileBusy);
  const initialFocusRef = useRef(initialFocus);
  const modalRef = useRef(modal);
  onCloseRef.current = onClose;
  busyRef.current = busy;
  allowCloseRef.current = allowCloseWhileBusy;
  initialFocusRef.current = initialFocus;
  modalRef.current = modal;

  const isTop = useCallback(() => dialogStack.at(-1) === tokenRef.current, []);
  const requestClose = useCallback(() => {
    if (
      (modalRef.current ? !isTop() : dialogStack.length > 0) ||
      (busyRef.current && !allowCloseRef.current)
    ) return false;
    onCloseRef.current();
    return true;
  }, [isTop]);

  // Opener ownership and initial focus belong to the layer itself, not to its current responsive
  // modality. Crossing 1024px while open must not pretend the layer closed and steal focus twice.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;

    const focusFrame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (panel) (initialFocusRef.current?.(panel) ?? panel).focus();
    });

    return () => {
      cancelAnimationFrame(focusFrame);
      const opener = openerRef.current;
      requestAnimationFrame(() => {
        if (opener?.isConnected && !opener.hidden && opener.getClientRects().length > 0) opener.focus();
      });
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const token = tokenRef.current;
    if (modal) {
      dialogStack.push(token);
      lockBody();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (modal ? !isTop() : dialogStack.length > 0) return;
      if (event.key === 'Escape') {
        if (!modal && !panelRef.current?.contains(document.activeElement)) return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (!modal || event.key !== 'Tab' || !panelRef.current) return;
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
      document.removeEventListener('keydown', onKeyDown);
      if (modal) {
        const index = dialogStack.lastIndexOf(token);
        if (index >= 0) dialogStack.splice(index, 1);
        unlockBody();
      }
    };
  }, [open, modal, isTop, requestClose]);

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
  const { t } = useT();
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
    <div className="dialog-backdrop-safe fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-scrim p-0 sm:p-4" onClick={() => requestClose()}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined} aria-busy={busy || undefined} tabIndex={-1}
        className={`dialog-panel-safe bg-surface rounded-t-2xl sm:rounded-2xl shadow-dialog w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} flex flex-col focus:outline-none`}
        onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-line-soft">
          <h3 ref={titleRef} id={titleId} tabIndex={-1} className="font-semibold text-ink focus:outline-none">{title}</h3>
          <button type="button" className="btn-ghost p-1.5! min-w-11 min-h-11" disabled={closeDisabled}
            onClick={() => requestClose()} aria-label={t('ui.aria_label_3')}><X size={ICON.md} /></button>
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

/**
 * The one bound on a typed reason, declared once for every screen that asks for one.
 *
 * Deliberately not exported: a caller that can read it is a caller that can re-state it, and
 * re-stating it per screen is exactly the drift this replaced. `reasonField.spec.tsx` asserts it
 * from the rendered DOM instead.
 */
const REASON_MAX_LENGTH = 1000;

/**
 * The reason box an audited action carries, in one place.
 *
 * Five screens had grown their own copy — this dialog, `ReauthModal`, the document-review decision,
 * the exception resolution note and the role-change dialog. Four were the same six lines; the fifth
 * had drifted twice. `Settings.tsx` used a single-line `<input>` with NO bound at all, so the one
 * reason in the product that could take an essay was the one attached to changing a person's role,
 * and the document-review box carried a hand-written class list with no focus ring instead of
 * `.input`. Neither was a decision — that is just the shape a copy takes when nobody owns it.
 *
 * `maxLength` is declared HERE and nowhere else among the callers, which is the whole point. The
 * column is unbounded `text`, so the bound is a sanity limit on a justification rather than a
 * schema constraint — and a limit that is re-typed per screen is a limit that drifts per screen.
 * It already had.
 *
 * A free-form `notes` field (an invoice's note, a supplier's note) is NOT a reason and stays
 * uncapped on purpose: truncating business content is worse than an unbounded box. This component
 * is for the sentence that lands in `audit_logs`, and `reasonOr` is what fills it when nobody typed
 * one (#299 — the box does not hold the button).
 */
export function ReasonField({ label, value, onChange, id, placeholder }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A stable id where a test or the browser gate names the field; generated otherwise. */
  id?: string;
  placeholder?: string;
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  return (
    <div>
      <label className="label" htmlFor={fieldId}>{label}</label>
      <textarea id={fieldId} className="input" rows={2} maxLength={REASON_MAX_LENGTH}
        placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel, reasonLabel, danger, requireReason, busy }: {
  open: boolean; onClose: () => void; onConfirm: (reason?: string) => void;
  title: string; message: string; confirmLabel?: string; reasonLabel?: string; danger?: boolean; requireReason?: boolean; busy?: boolean;
}) {
  const { t } = useT();
  const confirmText = confirmLabel ?? t('ui.ConfirmDialog');
  // Same rule as `confirmText`: the fallback belongs in the body, where there is a reader.
  const reasonText = reasonLabel ?? t(OPTIONAL_REASON_LABEL_KEY);
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title} description={message} busy={busy}>
      {requireReason && (
        <div className="mb-4">
          <ReasonField label={reasonText} value={reason} onChange={setReason} />
        </div>
      )}
      <div className="flex gap-2 justify-end">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>{t('ui.text_12')}</button>
        {/* The reason no longer blocks the button (owner, 11.08.2026). `requireReason` now means
            "this action records a reason", not "this action interrogates the user" — when the box
            is empty the ledger gets a sentence naming the action instead of a forced "asdf". */}
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy}
          onClick={() => onConfirm(requireReason ? reasonOr(reason, title) : undefined)}>
            {busy ? <><Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /><span>{t('ui.text_13')}</span></> : confirmText}
        </button>
      </div>
    </Modal>
  );
}

/**
 * What a figure is being compared against — the half a percentage never says on its own.
 *
 * THE FAILURE THIS REPLACES. The dashboard carried three hand-carved comparisons: month-to-date
 * against the same days last month (twice, once for money paid and once for money purchased) and
 * month-over-month on invoices. Each re-derived the same rule, each spelled its own null handling,
 * and each said "against the same days last month" — a sentence that names a RELATIONSHIP but not
 * the two periods, so a reader on the 17th cannot tell whether the baseline is a full month (it is
 * not) or the same seventeen days (it is). Three copies of a rule are three chances to drift, and
 * the wording was already the weakest part of all three.
 *
 * NO BASIS IS SAID OUT LOUD. When the previous period is null, zero or negative there is no
 * percentage to compute, and the old code simply omitted the chip — which reads as "no change".
 * This says "no basis for comparison" instead. A missing baseline is a fact about the DATA, and
 * hiding it is the same class of error as printing `0`: both let the reader draw a conclusion the
 * figures do not support.
 *
 * DIRECTION IS NEUTRAL INK, ALWAYS. Buying more is not good and not bad, and `DESIGN.md:421-423`
 * settles it: a change without a business verdict wears `ink-mid`, never the trend hues. The
 * arrow is the carrier, not the colour — which is also what keeps it readable under deuteranopia.
 *
 * ONE UNIT ONLY. `basis.currency` names the single currency both figures are in; the caller does
 * not get to hand in two. Comparing across currencies would require a rate, and the constitution
 * forbids one.
 */
export interface ComparisonBasis {
  /** The period the figure covers, in words a reader can check: "1–17.8". */
  currentLabel: string;
  /** What it is measured against, in the same shape: "1–17.7". */
  previousLabel: string;
  /** True when the current period is still running, so the baseline was cut to match it. */
  partial: boolean;
  /** Where the figure comes from — "orders that were sent", not "the orders table". */
  sourceLabel: string;
  unit: 'count' | 'money' | 'percent';
  /** The one currency both figures are in. Null for a count. */
  currency?: string | null;
}

export function PeriodComparison({ current, previous, basis }: {
  current: number | null;
  previous: number | null;
  basis: ComparisonBasis;
}) {
  const { t } = useT();
  /* A figure that was not measured has nothing to compare, and the tile above it already says so
     with a dash. A second sentence here would be the same absence stated twice. */
  if (current == null) return null;

  const comparable = previous != null && previous > 0;
  const percent = comparable ? Math.round(((current - previous) / previous) * 100) : null;

  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
      {percent == null ? (
        <span>{t('comparison.noBasis')}</span>
      ) : (
        <span className="inline-flex items-center gap-1 font-medium text-ink-mid">
          {percent > 0 && <TrendingUp size={ICON.xs} aria-hidden="true" />}
          {percent < 0 && <TrendingDown size={ICON.xs} aria-hidden="true" />}
          <span className="num" dir="ltr">{percent > 0 ? '+' : ''}{percent}%</span>
        </span>
      )}
      <span>
        {basis.partial
          ? t('comparison.againstPartial', { current: basis.currentLabel, previous: basis.previousLabel })
          : t('comparison.against', { current: basis.currentLabel, previous: basis.previousLabel })}
      </span>
      <span className="text-ink-ghost">·</span>
      <span>{basis.sourceLabel}</span>
    </span>
  );
}

/* ---------- Toast ---------- */
/**
 * The optional third argument of `toast(...)` — an action the message OFFERS rather than a
 * question the app asked first (0225). Two confirmation dialogs existed only because the action
 * behind them could not be taken back; a reversible action does not need to be interrogated
 * beforehand, it needs a way back afterwards.
 */
export interface ToastAction {
  /** Imperative, short — this sits inside a pill: 'ביטול'. */
  label: string;
  /** Runs after the toast has already dismissed itself, so the reversal owns the next message. */
  onAct: () => void;
}
export type ToastPush = (message: string, tone?: 'success' | 'error', action?: ToastAction) => void;

interface Toast { id: number; message: string; tone: 'success' | 'error'; action?: ToastAction }

/** A plain notice says its piece and leaves. Unchanged since the first toast shipped. */
const TOAST_MS = 4000;
/**
 * A toast carrying a control has to be readable AND reachable: the reader has to finish the
 * sentence, decide, and travel to the button. Four seconds is the time it takes to read
 * "המוצר הושבת" — it is not the time it takes to change your mind about it.
 */
const TOAST_ACTION_MS = 8000;

const ToastContext = createContext<ToastPush>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children, bottomNotice }: { children: ReactNode; bottomNotice?: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** id → pending dismissal. Held in a ref so hover/focus can cancel and rearm one toast's timer
      without re-rendering the stack, and so unmount can clear every one of them. */
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: number) => {
    const pending = timers.current.get(id);
    if (pending !== undefined) { clearTimeout(pending); timers.current.delete(id); }
  }, []);

  const arm = useCallback((id: number, ms: number) => {
    clearTimer(id);
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      setToasts((list) => list.filter((x) => x.id !== id));
    }, ms));
  }, [clearTimer]);

  const dismiss = useCallback((id: number) => {
    clearTimer(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, [clearTimer]);

  const push = useCallback<ToastPush>((message, tone = 'success', action) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone, action }]);
    arm(id, action ? TOAST_ACTION_MS : TOAST_MS);
  }, [arm]);

  // The timers used to outlive the provider: every `setTimeout` was fired and forgotten, so a
  // route change mid-toast left a callback that would `setState` on an unmounted tree.
  useEffect(() => {
    const pending = timers.current;
    return () => { for (const handle of pending.values()) clearTimeout(handle); pending.clear(); };
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="mobile-overlay-stack fixed z-[60] start-4 end-4 flex flex-col items-center gap-2 pointer-events-none no-print sm:start-6 sm:end-6">
        {toasts.length > 0 && (
          <div className="mobile-toast-offset flex flex-col gap-2 items-center pointer-events-auto">
            {toasts.map((t) => {
              const action = t.action;
              // A toast with a control must not be yanked out from under the hand or the caret
              // reaching for it. Hover and focus suspend the countdown; leaving restarts it whole.
              const hold = action ? () => clearTimer(t.id) : undefined;
              const resume = action ? () => arm(t.id, TOAST_ACTION_MS) : undefined;
              return (
                <div key={t.id}
                  onMouseEnter={hold} onMouseLeave={resume}
                  // onFocus/onBlur on the container: React maps them to focusin/focusout, so
                  // focusing the button inside suspends the timer that would remove it.
                  onFocus={hold} onBlur={resume}
                  className={`flex items-center gap-3 rounded-lg text-sm text-on-solid shadow-toast ${
                    action ? 'ps-4 pe-2 py-1.5' : 'px-4 py-2.5'
                  } ${t.tone === 'success' ? 'bg-ink-body' : 'bg-alert-solid'}`}>
                  {/* The live region is the SENTENCE, not the pill (0225). When the pill itself
                      carried role=status, a screen reader announced the button's label as part of
                      the message and re-announced the whole thing on every state change inside it.
                      Success is polite, an error assertive so a reader interrupts to surface it. */}
                  <span role={t.tone === 'error' ? 'alert' : 'status'}
                    aria-live={t.tone === 'error' ? 'assertive' : 'polite'}>
                    {t.message}
                  </span>
                  {action && (
                    // A light secondary pill on a solid dark ground — the existing utility pair,
                    // no new colour. `btn`'s min-h-11 is untouched: this is a real tap target.
                    <button type="button" className="btn-secondary btn-sm shrink-0"
                      onClick={() => { dismiss(t.id); action.onAct(); }}>
                      {action.label}
                    </button>
                  )}
                </div>
              );
            })}
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
  /**
   * Names this table's scroll region. A screen with more than one table produced that many
   * identically-named regions, which is worse than no name: a screen reader offers the user a
   * choice between three things called the same thing. Pass what the table holds — `'משתמשים'`,
   * `'הזמנות'` — and it becomes `"<label> — ניתן לגלול אופקית"`.
   */
  tableLabel?: string;
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
  const { t } = useT();
  return (
    <div role="group" aria-label={t('ui.aria_label_4')} className="flex flex-col">
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
    flipped above when the viewport has no room below, clamped inside).
 *
 * KEYBOARD CONTRACT, and it is written down because the previous version had none and the gap was
 * invisible to the unit tests. Measured in Chrome on /invoices, 03.09.2026:
 *   · opening the picker left `document.activeElement` on the TRIGGER — the focus call at the end
 *     of the measuring layout effect ran while `pos` was still `null`, so the panel was
 *     `visibility: hidden`, and a `visibility: hidden` element cannot take focus. jsdom does not
 *     implement that rule, so `expect(checkbox).toHaveFocus()` passed while the browser did not;
 *   · because the panel is portalled to the END of `<body>`, Tab from the trigger walked into the
 *     table BEHIND the open dialog instead of into it;
 *   · from inside, the eighth Tab dropped focus onto `<body>` with the dialog still open — and the
 *     next Tab restarted at "דלג לתוכן", i.e. the whole application, with a dialog covering it.
 *
 * So the contract is: Tab from the trigger ENTERS the panel; Tab past the last control (or
 * Shift+Tab past the first) CLOSES and returns focus to the trigger, so the next Tab continues
 * through the toolbar; Escape does the same; and focus landing anywhere else closes it. This is a
 * popover and not a modal, so it deliberately does not run on `useDialogLayer` — that locks body
 * scroll and holds the Escape stack, which a column checklist has no business doing. */
function ColumnPickerPopover({ options }: { options: ColumnPickerOption[] }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback((focusTrigger = false) => {
    // Focus is never abandoned on a node that is about to unmount. It used to be: a close from the
    // scroll or pointer handler left `document.activeElement` inside the removed panel, which the
    // browser resolves to `<body>` — and from `<body>` the next Tab starts the page over.
    const focusWasInside = !!panelRef.current?.contains(document.activeElement);
    setOpen(false);
    setPos(null);
    if (focusTrigger || focusWasInside) triggerRef.current?.focus();
  }, []);

  /** The panel's own controls, in tab order. Disabled boxes are not focusable and not in it. */
  const focusablesInPanel = useCallback(
    () => Array.from(panelRef.current?.querySelectorAll<HTMLElement>('input:not(:disabled)') ?? []),
    [],
  );

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
  }, [open]);

  /**
   * Initial focus waits for the POSITION, not merely for `open`.
   *
   * This call used to be the last line of the effect above, and in a browser it did nothing: until
   * `pos` is measured the panel renders `visibility: hidden`, and `visibility: hidden` makes an
   * element unfocusable. Keying it on `pos` moves it to the first render in which the panel is
   * actually visible. Measured before/after on /invoices: activeElement was the trigger, now it is
   * the first enabled checkbox.
   */
  useEffect(() => {
    if (!open || !pos) return;
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>('input:not(:disabled)') ?? panel)?.focus();
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation(); // an open popover consumes Escape — a Modal underneath must not also close
        close(true);
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      const trigger = triggerRef.current;
      if (!panel || !trigger) return;
      const nodes = focusablesInPanel();
      const active = document.activeElement;

      // Tab from the trigger ENTERS the panel. Without this the portal's position at the end of
      // <body> sends the caret into the page behind an open dialog.
      if (trigger.contains(active) && nodes.length > 0) {
        event.preventDefault();
        (event.shiftKey ? nodes[nodes.length - 1] : nodes[0]).focus();
        return;
      }
      if (!panel.contains(active)) return;

      // Tab past the end (or Shift+Tab past the start) LEAVES — closing and handing focus back to
      // the trigger, so the next Tab carries on through the toolbar. That is the exit; the panel
      // is never a place the keyboard can be stranded outside of or inside.
      const leaving = event.shiftKey
        ? active === nodes[0] || active === panel
        : active === nodes[nodes.length - 1] || nodes.length === 0;
      if (!leaving) return;
      event.preventDefault();
      close(true);
    };
    /** Any other route out — a click elsewhere, a focus() from another component — closes it too,
        without stealing focus back: the user chose where to go. */
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
      setPos(null);
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
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, close, focusablesInPanel]);

  return (
    <>
      <button ref={triggerRef} type="button" className="btn-secondary" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}>
        <Columns3 size={ICON.sm} aria-hidden="true" /> {t('ui.text_19')}
      </button>
      {open && createPortal(
        <div ref={panelRef} role="dialog" aria-label={t('ui.aria_label_5')} tabIndex={-1}
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
  const { locale, t } = useT();
  const {
    rows, columns, onRowClick, searchLabel = t('ui.text_14'), tableLabel,
    emptyTitle = t('ui.text_15'), emptySubtitle, emptyAction, emptyIcon, toolbar, mobile = 'cards',
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
      <Search size={ICON.sm} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint" />
      {server ? (
        <input className="input ps-9!" aria-label={searchLabel} placeholder={t('ui.placeholder')} value={searchText}
          onChange={(e) => emitSearch(e.target.value)} />
      ) : (
        <input className="input ps-9!" aria-label={searchLabel} placeholder={t('ui.placeholder_2')} value={q}
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
      <EmptyState title={t('ui.title')} subtitle={t('ui.subtitle')}
        action={<button type="button" className="btn-secondary" onClick={clearFilters}>{t('ui.text_16')}</button>} />
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
                      {/* The row target is the title alone, exactly as on the desktop table, and for
                          the same reason: a column may render its own control (audit 2026-08-25 —
                          the „best price" cell in Products is a <button>), and a card body wrapped
                          whole in a <button> made that button-in-button. Invalid HTML, two nested
                          focus targets, and an ambiguous tap. Mouse click stays on the <li>. */}
                      {/* No aria-label here, unlike the desktop first cell: there the button holds
                          one column out of many and needs rowLabel to say which row it opens, while
                          the card title IS the row's name. A second control with the identical
                          accessible name would only duplicate it. */}
                      {onRowClick ? (
                        <button type="button"
                          onClick={(event) => { event.stopPropagation(); onRowClick(row); }}
                          className="min-w-0 break-words text-start font-medium text-ink-body focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2">
                          {title}
                        </button>
                      ) : (
                        <div className="min-w-0 break-words font-medium text-ink-body">{title}</div>
                      )}
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
                // One shape for both cases: the <li> is the mouse target, the title is the
                // keyboard/AT target, and the action menu is a sibling that stops the click from
                // also navigating. Same division of labour as the desktop <tr>.
                return (
                  <li key={row.id}
                    className={`mobile-data-card p-4 ${onRowClick ? 'row-hover cursor-pointer' : ''} ${rowActions ? 'flex items-start gap-2' : ''}`}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}>
                    <div className="min-w-0 flex-1">{body}</div>
                    {rowActions && (
                      <div className="shrink-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                        <ActionMenu items={rowActions(row)} label={t('uiTail.actionsFor', { row: rowLabel?.(row) ?? row.id })} />
                      </div>
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
            role="region" aria-label={t('uiTail.scrollableTable', { label: tableLabel ?? t('uiTail.dataTable') })} tabIndex={0}>
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
                            {/* The direction is a decorative chevron, not a text arrow — taken from
                                originui's TanStack table headers. The arrow used to be a literal
                                ` ↑` inside the label, which put it in the button's ACCESSIBLE NAME:
                                a screen reader read "סכום up arrow" on top of the `aria-sort` it
                                already announces, and the name changed every time the column was
                                sorted, so no caller could address the header by an exact string
                                (dataTable.spec had to match it by regex). `aria-hidden` restores a
                                stable name and leaves aria-sort as the single source of direction. */}
                            {c.header}
                            {ariaSort === 'ascending' ? <ChevronUp size={ICON.xs} aria-hidden="true" className="shrink-0" />
                              : ariaSort === 'descending' ? <ChevronDown size={ICON.xs} aria-hidden="true" className="shrink-0" /> : null}
                          </button>
                        ) : c.header}
                      </th>
                    );
                  })}
                  {rowActions && <th scope="col" className="th w-12"><span className="sr-only">{t('ui.text_17')}</span></th>}
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
                              aria-label={rowLabel ? t('uiTail.openRow', { row: rowLabel(row) }) : undefined}
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
                            <ActionMenu items={rowActions(row)} label={t('uiTail.actionsFor', { row: rowLabel?.(row) ?? row.id })} />
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
                    <button type="button" className="btn-ghost" onClick={clearFilters}>{t('ui.text_18')}</button>
                  )}
                </>
              ) : sheetHasContent ? (
                // Below md the screen's filters, the column picker and the clear action live in
                // one sheet (UI-PLAN §2). The `toolbar` slot is mounted in exactly one of the two
                // places at a time, so no id inside it can duplicate (gate B6).
                <button type="button" className="btn-secondary" aria-haspopup="dialog" aria-expanded={sheetOpen}
                  onClick={() => setSheetOpen(true)}>
                  <SlidersHorizontal size={ICON.sm} aria-hidden="true" /> {t('ui.title_2')}
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
              <span aria-live="polite">{t(
                pluralCategory(locale, filteredCount) === 'one' ? 'uiTail.recordOne' : 'uiTail.recordsOther',
                { count: filteredCount },
              )}</span>
                {server?.fetching && <Loader2 size={ICON.sm} className="animate-spin text-ink-faint" aria-hidden="true" />}
            </span>
            {pages > 1 && (
              <div className="flex items-center gap-1">
                <button className="btn-ghost p-1.5! min-w-11 min-h-11" disabled={currentPage === 0}
                  onClick={() => (server ? server.onPageChange(server.page - 1) : setPage((p) => p - 1))}
                  aria-label={t('ui.aria_label_6')}><ChevronRight size={ICON.sm} /></button>
                <span className="px-2">{currentPage + 1} / {pages}</span>
                <button className="btn-ghost p-1.5! min-w-11 min-h-11" disabled={currentPage >= pages - 1}
                  onClick={() => (server ? server.onPageChange(server.page + 1) : setPage((p) => p + 1))}
                  aria-label={t('ui.aria_label_7')}><ChevronLeft size={ICON.sm} /></button>
              </div>
            )}
          </div>
        )}
      </div>
      {enterprise && !isDesktop && (
        // The one mobile sheet, over the existing dialog layer (extracted, not rewritten):
        // Modal already runs on useDialogLayer and renders as a bottom sheet on phones.
        <Modal open={sheetOpen} onClose={() => setSheetOpen(false)} title={t('ui.title_2')}>
          <div className="space-y-5">
            {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
            {pickerOptions && (
              <div>
                <div className="label">{t('ui.text_19')}</div>
                <ColumnChecklist options={pickerOptions} />
              </div>
            )}
            {hasActiveFilters && (
              <button type="button" className="btn-secondary w-full" onClick={() => { clearFilters(); setSheetOpen(false); }}>
                {t('ui.text_20')}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
