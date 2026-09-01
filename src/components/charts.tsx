import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { useChartTheme } from '../lib/theme';
import { useT } from '../lib/i18n/LocaleProvider';
import { fmtMoneyCompact, fmtMoneyExact, fmtMoneyRounded } from '../lib/format';
import type { DashboardWeeklyPoint } from '../lib/dashboardSeries';

/**
 * Shared chart primitives + generalized chart blocks. Extracted verbatim from the owner dashboard
 * (Dashboard.tsx) so every screen renders identical recharts output; the generalized components only
 * parameterize the data/labels/colors that were already parameters. Every chart is wrapped in
 * ChartViewport, which carries the RTL (dir="ltr"), first-viewport animation, prefers-reduced-motion,
 * and role="img"/aria contract — so any dashboard that uses these inherits all of it for free.
 * Colors always come from chartTheme() (resolved CSS-var strings) — never hex/palette literals (DESIGN).
 */

// Whole-currency label for bars; compact for dense axes and donut centres. Both go through
// src/lib/format.ts — they used to hand-build the symbol as a prefix with a bare toLocaleString,
// which put the currency mark on the wrong side of the figure from every table in the app.
//
// SINCE 0217 THEY ARE FACTORIES, and that is not ceremony. recharts hands a formatter a bare
// number, so the only place a chart can learn which money it is drawing is the moment it is built.
// A CHART IS ALWAYS ONE CURRENCY: a series mixing two would need two axes to be honest, and the
// callers instead pick a currency and pass its own series (plan §3.1). The currency comes with the
// data; it is never assumed and never converted.
export const moneyFor = (currency: string | null | undefined) => (v: number) => fmtMoneyRounded(v, currency);
export const moneyShortFor = (currency: string | null | undefined) => (v: number) => (
  Math.abs(v) >= 1000 ? fmtMoneyCompact(v, currency) : fmtMoneyRounded(v, currency)
);

/**
 * DarkTooltip (T7.2; oceanic since T7.3 — the brand blue leads, black stays rare) — the one
 * tooltip of the chart system: a deep-blue pill with white ink, like the reference's floating
 * "Others 12" chip. Replaces recharts' default white box everywhere. Receives recharts' injected
 * tooltip props; renders nothing when inactive. Series color appears as a dot beside the name —
 * text itself stays in shell ink (text wears text tokens, not series colors).
 */
/** `payload` is the DATUM behind the hovered mark, which recharts attaches to every entry. It is
 *  the only thing on the entry that identifies WHICH bucket is under the pointer — `value` cannot,
 *  because two buckets are allowed to hold the same amount. */
type TooltipEntry = {
  name?: string;
  value?: number | string | null;
  color?: string;
  fill?: string;
  payload?: { key?: string };
};

export function DarkTooltip({ active, payload, label, formatter, colorFor }: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  formatter?: (value: number) => string;
  /** T7.3k (owner, image #27): when marks are individually colored (rank-colored bars via
   *  Cells), recharts' injected entry.color is the series default — this hook lets the chart
   *  restate the HOVERED mark's actual color so the tooltip dot matches what the eye sees. */
  colorFor?: (entry: TooltipEntry) => string | undefined;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((entry) => entry.value != null);
  if (!rows.length) return null;
  /* THE GROUND IS `shell`, NOT `action` (found by the both-themes contrast sweep, 31.08.2026).
     All four inks in this tooltip come from the `shell-*` family, which is deliberately on-dark in
     BOTH themes — but the ground was `action`, which is dark oceanic on paper and LIGHT paper in the
     dark theme. So the tooltip read at 10.83:1 in the light theme and 1.08:1 in the dark one: white
     lettering on a white pill. `shell` is the ground those inks were written for, and it holds at
     16.93:1 in both themes because neither token follows the palette. */
  return (
    <div className="rounded-xl bg-shell px-3 py-1.5 text-xs text-shell-ink shadow-menu">
      {label != null && label !== '' && <div className="mb-0.5 text-shell-ink-dim">{label}</div>}
      {rows.map((entry, index) => (
        <div key={index} className="flex items-center gap-1.5">
          {/* Thin light ring so an oceanic dot stays visible on the tooltip's own dark pill
              (found in the closing audit: blue-on-blue vanished). */}
          <span className="size-2 shrink-0 rounded-full ring-1 ring-shell-ink/45" style={{ backgroundColor: colorFor?.(entry) ?? entry.color ?? entry.fill }} aria-hidden="true" />
          {entry.name && <span className="text-shell-ink-soft">{entry.name}</span>}
          <span className="num font-medium">{formatter ? formatter(Number(entry.value)) : entry.value}</span>
        </div>
      ))}
    </div>
  );
}

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  return reduced;
}

export function ChartViewport({ className, label, style, children }: {
  className: string;
  label: string;
  style?: CSSProperties;
  children: (animation: { active: boolean; finish: () => void }) => ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const initialLabel = useRef(label);
  const [visible, setVisible] = useState(() => reducedMotion || !('IntersectionObserver' in window));
  const [finished, setFinished] = useState(() => reducedMotion || !('IntersectionObserver' in window));

  useEffect(() => {
    if (reducedMotion || !('IntersectionObserver' in window)) {
      setVisible(true);
      setFinished(true);
      return;
    }
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { threshold: 0.18 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [reducedMotion]);

  useEffect(() => {
    if (label !== initialLabel.current) setFinished(true);
  }, [label]);

  return (
    <div ref={ref} dir="ltr" className={className} style={style} role="img" aria-label={label}>
      {visible
        ? children({ active: !finished && !reducedMotion, finish: () => setFinished(true) })
        : <span className="sr-only">{label}</span>}
    </div>
  );
}

export function TrendSparkline({ points, label, currency }: {
  points: DashboardWeeklyPoint[]; label: string; currency: string | null | undefined;
}) {
  const { t } = useT();
  const gradientId = `dashboardSpark${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const theme = useChartTheme();
  // T7.2 zero policy: the window is fetched in full, so a rowless week is a measured ₪0 — the
  // sparkline stays continuous. Callers already gate rendering on ≥2 active weeks (hasSpark).
  const plotted = points.map((point) => ({ ...point, total: point.count > 0 ? point.total : 0 }));
  const ariaLabel = `${label}: ${points.map((point) => `${point.week} ${point.count ? fmtMoneyExact(point.total, currency) : t('charts.noRecords')}`).join(', ')}`;

  return (
    <ChartViewport className="h-7 min-w-16 flex-1" label={ariaLabel}>
      {(animation) => (
        <ResponsiveContainer>
          <AreaChart data={plotted} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={theme.bar} stopOpacity={0.18} />
                <stop offset="100%" stopColor={theme.bar} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="total" stroke={theme.bar} strokeWidth={1.5}
              fill={`url(#${gradientId})`} dot={{ r: 1.5, strokeWidth: 0 }} connectNulls={false}
              isAnimationActive={animation.active} animationDuration={500} animationEasing="ease-out"
              onAnimationEnd={animation.finish} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </ChartViewport>
  );
}

export type BarPoint = { key: string; label: string; total: number };

/** Vertical bar chart, one categorical colour per bucket (owner, 26.08.2026 — the bars are to
 *  wear "the colours of the month's purchase mix", i.e. the donut's palette). This REPLACES the
 *  rank ramp of T7.3k/25.08: the fill no longer says which month was the biggest, the bar's own
 *  height does, and the tooltip and ARIA sentence carry the figures. See `bucketFill` for the
 *  trade written out. Thin, rounded marks; empty → emptyMessage, not empty axes. */
export function SpendBarChart({
  points, ariaLabel, emptyMessage, currency, className = 'mt-2 h-32 sm:h-48', maxBarSize = 32,
  valueFormatter,
}: {
  points: BarPoint[];
  ariaLabel: string;
  emptyMessage: string;
  /** The one currency this chart is drawn in. Two would need two axes to be honest. */
  currency: string | null | undefined;
  className?: string;
  maxBarSize?: number;
  /** Defaults to this chart's own currency; pass one only to draw something that is not money. */
  valueFormatter?: (v: number) => string;
}) {
  const format = valueFormatter ?? ((v: number) => fmtMoneyExact(v, currency));
  const { t } = useT();
  const theme = useChartTheme();
  /* One bucket, one colour, taken from the SAME categorical palette the donut beside it uses
     (owner report 26.08.2026: "שהצבע בדאשבורד באזור של המגמות בהוצאות רכש שיהיה כמו הצבעים של
     תמהיל הרכש החודש"). The colour is keyed to the bucket's POSITION, so a month keeps its
     colour while the window holds and two neighbouring bars never land on the same hue.

     What this trades away, stated rather than discovered: the three-step ramp that used to live
     here painted the highest month deep and the lowest pale, so the fill itself ranked them. It
     no longer does. The ranking was never the only carrier — the bar HEIGHT is the magnitude, and
     the tooltip and the ARIA sentence both still read the exact figures — but a reader who used
     to get rank from the fill now gets identity from it instead. That is the owner's call and it
     is the same call the donut already makes.

     `barLow` stays for a zero/negative bucket: nothing measured is not a category, and giving it
     a palette hue would claim it is one. */
  const bucketFill = (total: number, index: number) =>
    (total <= 0 ? theme.barLow : theme.categorical[index % theme.categorical.length]);
  return (
    <ChartViewport className={className} label={ariaLabel}>
      {(animation) => points.length ? (
        <ResponsiveContainer>
          <BarChart data={points} margin={{ top: 12, left: 8, right: 8 }}>
            {/* Reference bar language (T7.2): faint SOLID horizontal guides only, no on-bar
                numbers — the dark tooltip and the ARIA text carry the values. */}
            <CartesianGrid vertical={false} stroke={theme.grid} />
            <XAxis dataKey="key" tick={{ fontSize: 12, fill: theme.tick }} axisLine={false} tickLine={false} />
            <YAxis hide />
            {/* The tooltip swatch is looked up by the bucket's KEY, not by its value: two months
                can hold the same amount, and matching on the number would have painted the swatch
                of whichever one recharts happened to find first. */}
            <Tooltip cursor={false} isAnimationActive={animation.active}
              content={<DarkTooltip formatter={format} colorFor={(entry) => {
                const index = points.findIndex((p) => p.key === entry.payload?.key);
                return bucketFill(Number(entry.value ?? 0), index < 0 ? 0 : index);
              }} />} />
            <Bar dataKey="total" name={t('charts.total')} radius={[8, 8, 0, 0]} maxBarSize={maxBarSize}
              isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish}>
              {points.map((p, index) => <Cell key={p.key} fill={bucketFill(p.total, index)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : <div className="flex h-full items-center justify-center text-sm text-ink-muted">{emptyMessage}</div>}
    </ChartViewport>
  );
}

/**
 * `aggregate` is what identifies the "everything else" slice, and it replaced a comparison against
 * the word itself. A screen that recognised the bucket by matching the rendered text stopped
 * recognising it the moment the reader could change language — `AccountantDashboard` compared a
 * supplier name to `t(...)`, so on an English screen the aggregate would have been given a link to
 * a search for a supplier that does not exist. The name is empty on that row on purpose: the word
 * is copy, and copy is resolved here, where the reader's language is known.
 */
export type CategorySlice = { name: string; total: number; aggregate?: boolean };

/* A category keeps its colour when the amounts move (24.08.2026).
   The old assignment was `DONUT_ORDER[index % 4]`, and `index` is the slice's RANK — the list
   arrives sorted by total (topCategoriesWithOther). So a quiet month that swapped second place
   for third repainted both wedges, and the reader had to re-read the legend to find the category
   they were following. Colour that moves with rank is not identity, it is decoration.

   The slot now comes from the NAME: the named categories of this donut, sorted, and the
   category's position in that order. Two consequences worth stating rather than discovering.
   A category's colour is stable across every refresh, filter and month for as long as the same
   set of categories is on screen — which is the case that was broken. It can still change when a
   DIFFERENT category enters or leaves the top four, because a four-slot donut has no room for a
   catalogue-wide mapping; the upgrade path, if that ever matters, is a persisted per-category
   slot, and it is not worth a table today.

   The aggregate is pinned to the last step: it is an aggregate, never an entity, and it must not
   take a slot from something that is. ONE definition, used by both the arc Cell and the legend
   swatch — the duplicated expression they had before was an unchecked contract.

   It is identified by `slice.aggregate` rather than by its word. The word is copy now, and a
   colour rule that read copy would have handed the aggregate an entity's slot — and an entity the
   aggregate's — on the first screen that rendered in the other language. */
function sliceColor(categorical: string[], slice: CategorySlice, all: readonly CategorySlice[]) {
  if (slice.aggregate) return categorical[categorical.length - 1];
  const named = all
    .filter((candidate) => !candidate.aggregate)
    .map((candidate) => candidate.name)
    .sort((a, b) => a.localeCompare(b, 'he'));
  const slot = named.indexOf(slice.name);
  return categorical[(slot < 0 ? 0 : slot) % (categorical.length - 1)];
}

/** Donut + center total + HTML legend. Generalizes the owner category-mix chart; run `slices` through
 *  topCategoriesWithOther first. `total` drives the center + percentages; total<=0 → emptyMessage. */
/**
 * `hrefFor` — G1, finding 13. Optional, and the legend is where it lands rather than the SVG arcs:
 * the arcs carry `rootTabIndex={-1}` and no text, so a link on them would be reachable by mouse
 * only, while the legend row already names the slice and its share. Returning `null` leaves that
 * row plain — the aggregated slice is not a destination, because there is no one thing to open.
 * Callers that pass nothing keep exactly the markup they had.
 */
export function CategoryDonut({ slices, total, currency, ariaLabel, emptyMessage, hrefFor, hrefLabel }: {
  slices: CategorySlice[];
  total: number;
  /** The one currency this chart is drawn in. Two would need two axes to be honest. */
  currency: string | null | undefined;
  ariaLabel: string;
  emptyMessage: string;
  hrefFor?: (slice: CategorySlice) => string | null;
  hrefLabel?: (slice: CategorySlice) => string;
}) {
  const { t } = useT();
  const theme = useChartTheme();
  /** The word for the product's own bucket, resolved once, where the reader's language is known. */
  const sliceLabel = (slice: CategorySlice) => (slice.aggregate ? t('charts.otherSlice') : slice.name);
  if (total <= 0) {
    return <div className="flex h-24 items-center justify-center text-center text-sm text-ink-muted sm:h-44">{emptyMessage}</div>;
  }
  // T7.2 reference anatomy: a THICK centered ring with the big total inside it, and the legend as
  // a compact dot+name+% chip row BELOW (the Crextio "●70% ●30%" idiom) — no side list. The exact
  // ₪ amounts stay reachable: on each chip's title and in the tooltip/aria text.
  return (
    <div className="mt-2 flex min-h-36 flex-col items-center gap-3 sm:min-h-44">
      <ChartViewport className="pointer-events-none relative mx-auto h-36 w-36 shrink-0 sm:h-44 sm:w-44" label={ariaLabel}>
        {(animation) => (
          <>
            <ResponsiveContainer>
              <PieChart accessibilityLayer={false} style={{ pointerEvents: 'none' }}>
                <Pie data={slices} dataKey="total" nameKey="name" innerRadius="55%" outerRadius="92%"
                  rootTabIndex={-1} tabIndex={-1} paddingAngle={2} stroke="none" isAnimationActive={animation.active} animationDuration={550}
                  animationEasing="ease-out" onAnimationEnd={animation.finish}>
                  {slices.map((slice, index) => (
                    <Cell key={slice.aggregate ? 'aggregate' : slice.name || index}
                      fill={sliceColor(theme.categorical, slice, slices)} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-content-center text-center" aria-hidden="true">
              <span className="num text-xl font-semibold text-ink sm:text-2xl">{moneyShortFor(currency)(total)}</span>
              <span className="text-xs text-ink-muted">{t('charts.total')}</span>
            </div>
          </>
        )}
      </ChartViewport>
      <ul className="flex min-w-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
        {slices.map((slice, index) => {
          const href = hrefFor?.(slice) ?? null;
          const pct = Math.round((slice.total / total) * 100);
          const swatch = (
            <span className="size-2 shrink-0 rounded-full" aria-hidden="true"
              style={{ backgroundColor: sliceColor(theme.categorical, slice, slices) }} />
          );
          const label = sliceLabel(slice);
          return (
            <li key={slice.aggregate ? 'aggregate' : slice.name || index}>
              {href ? (
                <Link to={href} aria-label={hrefLabel?.(slice) ?? slice.name} title={fmtMoneyExact(slice.total, currency)}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-1.5 text-action hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  {swatch}
                  <span className="max-w-32 truncate">{label}</span>
                  <span className="num text-ink-muted">{pct}%</span>
                </Link>
              ) : (
                <div className="inline-flex min-h-11 items-center gap-1.5 px-1.5 text-ink-mid" title={fmtMoneyExact(slice.total, currency)}>
                  {swatch}
                  <span className="max-w-32 truncate">{label}</span>
                  <span className="num text-ink-muted">{pct}%</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* `dash` (T7.3g, owner sketch on image #16): the secondary series draws dashed — with a
   system-colors-only ramp both lines are dark, so the dash carries the identity distinction
   that hue no longer can. */
export type LineSeries = { key: string; name: string; color: string; dash?: boolean };
/** A chart row keyed by field name (x + one field per series). Index signature so callers can build
 *  arbitrarily-keyed points and still pass them by value (no per-shape interface needed). */
export type LinePoint = Record<string, string | number | null>;

/** Minimum vertical distance between two series-name end labels. Measured, not guessed: the text
 *  box is 17px tall at fontSize 12, so 16 still left the boxes 1px into each other. 18 clears them
 *  with a hairline to spare, and nothing wider is used — every extra pixel drags a label further
 *  from the line it names. */
const END_LABEL_GAP = 18;
/** Radius of the terminal dot, and the gap between it and the first glyph of the name. */
const END_DOT_R = 4;

type EndPoint = { x: number; y: number } | null;

/**
 * Where the series names go: at their own dot, and level with it.
 *
 * Owner report 26.08.2026 — the line should end in a small dot and the words "רכש" / "תשלומים"
 * should sit at those dots' height, so that a dot moving takes its word with it. That is the
 * whole rule, and for any pair of lines further apart than one label box it is the entire
 * function: `y` in, `y` out.
 *
 * The exception is two lines ending on nearly the same value — which is exactly the shape this
 * chart has whenever purchases and payments converge, so it is the common case and not a corner.
 * There the two boxes would sit on top of each other and something has to give, and WHICH WAY IT
 * GIVES IS NOT A FREE CHOICE: below the lowest line end is the date axis, so a name nudged down
 * lands on a tick (measured on /dashboard — both series finish at zero, and "תשלומים" came to
 * rest across "19/07"). So a colliding stack opens UPWARDS. The lowest name keeps its dot's exact
 * height and each one above it rises only as far as the one below forces. Nothing is ever drawn
 * below a dot, every name stays in its line's vertical order, and the whole arrangement still
 * travels with the data.
 *
 * An earlier version of this spread the pair symmetrically about its midpoint and then slid the
 * block clear of the axis. The slide cancelled the symmetry every time — for two series it always
 * bites — so the symmetry was arithmetic nobody could observe. This is the same output, said once.
 *
 * Two is what `comparisonSeries()` produces and what the component documents; the loop is written
 * for n anyway because writing it for two would have cost the same and read worse.
 */
export function endLabels(points: readonly EndPoint[]) {
  const placed = points
    .map((point, index) => (point ? { index, x: point.x, y: point.y } : null))
    .filter((entry): entry is { index: number; x: number; y: number } => entry !== null)
    .sort((a, b) => a.y - b.y);
  for (let i = placed.length - 2; i >= 0; i -= 1) {
    const ceiling = placed[i + 1].y - END_LABEL_GAP;
    if (placed[i].y > ceiling) placed[i].y = ceiling;
  }
  return placed;
}

/** 1–2 smooth layered areas over a shared x-axis — the reference's "Sale Activity" rendering
 *  (T7.2): NO grid, no dots ALONG the line, a soft gradient wash under each line (~28% at the
 *  stroke fading to 0; `dash` series draw dashed per T7.3g), and the series NAME beside a
 *  terminal dot at the line's end, level with it (owner 26.08.2026, see `endLabels`) —
 *  identity never rests on color alone, and no legend box is needed. Empty (no non-null point) →
 *  emptyMessage; with the fully-fetched-window zero policy, callers pass [] when the whole window
 *  has no activity so two flat zero lines never fabricate a chart. `legend` kept for callers that
 *  still want the swatch row (default off — end labels replace it). */
export function ComparisonLineChart({
  points, xKey = 'x', series, ariaLabel, emptyMessage,
  className = 'mt-2 h-32 sm:h-48', currency, valueFormatter, legend = false,
}: {
  points: LinePoint[];
  xKey?: string;
  series: LineSeries[];
  /** The one currency this chart is drawn in. Two would need two axes to be honest. */
  currency: string | null | undefined;
  ariaLabel: string;
  emptyMessage: string;
  className?: string;
  /** Defaults to this chart's own currency; pass one only to draw something that is not money. */
  valueFormatter?: (v: number) => string;
  legend?: boolean;
}) {
  const format = valueFormatter ?? ((v: number) => fmtMoneyExact(v, currency));
  const theme = useChartTheme();
  const gradientBase = `cmpArea${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const hasData = points.length > 0 && points.some((point) => series.some((s) => point[s.key] != null));
  const lastIndex = points.length - 1;
  // Where each series' line ENDS, filled in as recharts renders the series in order.
  const endPointY = useRef<EndPoint[]>([]);
  return (
    <>
      {legend && (
        <div className="flex items-center justify-end gap-4 text-xs text-ink-muted" aria-hidden="true">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="w-6 border-t-2" style={{ borderColor: s.color }} />{s.name}
            </span>
          ))}
        </div>
      )}
      <ChartViewport className={className} label={ariaLabel}>
        {(animation) => hasData ? (
          <ResponsiveContainer>
            {/* end margin reserves room for the series-name end labels */}
            <AreaChart data={points} margin={{ top: 8, left: 8, right: 56 }}>
              <defs>
                {series.map((s, index) => (
                  <linearGradient key={s.key} id={`${gradientBase}${index}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
              <XAxis dataKey={xKey} tick={{ fontSize: 12, fill: theme.tick }} axisLine={false} tickLine={false} />
              <YAxis hide />
              {/* T7.3g: dashed hover cursor — the owner drew exactly this on image #16. */}
              <Tooltip cursor={{ stroke: theme.tick, strokeWidth: 1, strokeDasharray: '4 4' }}
                content={<DarkTooltip formatter={format} />} isAnimationActive={animation.active} />
              {series.map((s, index) => (
                <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2.5}
                  strokeDasharray={s.dash ? '7 5' : undefined}
                  fill={`url(#${gradientBase}${index})`} dot={false} connectNulls={false}
                  isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish}>
                  {/* The line ENDS in a dot, and its name sits at the dot's height — one node, so
                      the two cannot drift apart: both read the same `y`, which is the y recharts
                      computed for the series' last point. Move the data and both move together.

                      The dot is the series hue with a surface-coloured collar, the same treatment
                      the donut's 2px gaps use, so two dots that land on top of each other still
                      read as two. The NAME stays chart ink and never takes the hue: identity is
                      the word, colour only makes finding it faster.

                      The one case where the name leaves its dot is two dots closer than a label
                      box. Then BOTH names step half a box from their own dot — the upper one up,
                      the lower one down — which keeps each name attached to the line it belongs
                      to. The old rule moved only the later series and left it at a height its
                      line never reached. `dominantBaseline` is what makes "same height" true in
                      pixels rather than approximately: without it the text hangs from its
                      baseline and sits ~4px low. */}
                  <LabelList dataKey={s.key} content={({ x, y, index: pointIndex }) => {
                    if (pointIndex !== lastIndex) return null;
                    const end = typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
                    endPointY.current[index] = end;
                    // Every dot is drawn by its own series. The NAMES are all drawn from the last
                    // series' turn, because that is the first moment in the pass where every end
                    // point is known — and knowing all of them is what lets a colliding pair split
                    // symmetrically instead of the later one alone being pushed off its line.
                    const names = index === series.length - 1 ? endLabels(endPointY.current) : [];
                    return (
                      <g>
                        {end && <circle cx={end.x} cy={end.y} r={END_DOT_R} fill={s.color} stroke={theme.surface} strokeWidth={2} />}
                        {names.map((label) => (
                          <text key={series[label.index].key} x={label.x + END_DOT_R + 6} y={label.y}
                            dominantBaseline="middle" fontSize={12} fontWeight={500} fill={theme.label} textAnchor="start">
                            {series[label.index].name}
                          </text>
                        ))}
                      </g>
                    );
                  }} />
                </Area>
              ))}
            </AreaChart>
          </ResponsiveContainer>
        ) : <div className="flex h-full items-center justify-center text-sm text-ink-muted">{emptyMessage}</div>}
      </ChartViewport>
    </>
  );
}

/**
 * GroupedBarChart (T7.2) — the reference's paired-bars rendering ("Revenue", image 2): two slim
 * fully-round-capped bars per bucket, a dot legend row BELOW the plot, faint solid horizontal
 * guides, dark tooltip. Two-hue exception to the single-hue bar rule: identity is carried by the
 * legend + ARIA + a large lightness gap between the series colors, never by hue alone.
 */
export function GroupedBarChart({
  points, xKey = 'x', series, ariaLabel, emptyMessage,
  className = 'mt-2 h-32 sm:h-48', currency, valueFormatter,
}: {
  points: LinePoint[];
  xKey?: string;
  series: LineSeries[];
  /** The one currency this chart is drawn in. Two would need two axes to be honest. */
  currency: string | null | undefined;
  ariaLabel: string;
  emptyMessage: string;
  className?: string;
  /** Defaults to this chart's own currency; pass one only to draw something that is not money. */
  valueFormatter?: (v: number) => string;
}) {
  const format = valueFormatter ?? ((v: number) => fmtMoneyExact(v, currency));
  const theme = useChartTheme();
  const hasData = points.length > 0 && points.some((point) => series.some((s) => point[s.key] != null));
  return (
    <>
      <ChartViewport className={className} label={ariaLabel}>
        {(animation) => hasData ? (
          <ResponsiveContainer>
            <BarChart data={points} margin={{ top: 12, left: 8, right: 8 }} barGap={3}>
              <CartesianGrid vertical={false} stroke={theme.grid} />
              <XAxis dataKey={xKey} tick={{ fontSize: 12, fill: theme.tick }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip cursor={false} content={<DarkTooltip formatter={format} />} isAnimationActive={animation.active} />
              {series.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[999, 999, 0, 0]} maxBarSize={14}
                  isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : <div className="flex h-full items-center justify-center text-sm text-ink-muted">{emptyMessage}</div>}
      </ChartViewport>
      <div className="mt-1 flex items-center justify-center gap-4 text-xs text-ink-muted" aria-hidden="true">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />{s.name}
          </span>
        ))}
      </div>
    </>
  );
}
