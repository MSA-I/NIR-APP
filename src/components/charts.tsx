import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { chartTheme } from '../lib/theme';
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

// Whole-shekel label for bars; compact for dense axes and donut centres. Both go through
// src/lib/format.ts — they used to hand-build the symbol as a prefix with a bare toLocaleString,
// which put the currency mark on the wrong side of the figure from every table in the app.
export const money = (v: number) => fmtMoneyRounded(v);
export const moneyShort = (v: number) => (Math.abs(v) >= 1000 ? fmtMoneyCompact(v) : fmtMoneyRounded(v));

/**
 * DarkTooltip (T7.2; oceanic since T7.3 — the brand blue leads, black stays rare) — the one
 * tooltip of the chart system: a deep-blue pill with white ink, like the reference's floating
 * "Others 12" chip. Replaces recharts' default white box everywhere. Receives recharts' injected
 * tooltip props; renders nothing when inactive. Series color appears as a dot beside the name —
 * text itself stays in shell ink (text wears text tokens, not series colors).
 */
type TooltipEntry = { name?: string; value?: number | string | null; color?: string; fill?: string };

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
  return (
    <div className="rounded-xl bg-action px-3 py-1.5 text-xs text-shell-ink shadow-menu">
      {label != null && label !== '' && <div className="mb-0.5 text-shell-ink-dim">{label}</div>}
      {rows.map((entry, index) => (
        <div key={index} className="flex items-center gap-1.5">
          {/* Thin light ring so an oceanic dot stays visible on the tooltip's own oceanic pill
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

export function TrendSparkline({ points, label }: { points: DashboardWeeklyPoint[]; label: string }) {
  const gradientId = `dashboardSpark${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const t = chartTheme();
  // T7.2 zero policy: the window is fetched in full, so a rowless week is a measured ₪0 — the
  // sparkline stays continuous. Callers already gate rendering on ≥2 active weeks (hasSpark).
  const plotted = points.map((point) => ({ ...point, total: point.count > 0 ? point.total : 0 }));
  const ariaLabel = `${label}: ${points.map((point) => `${point.week} ${point.count ? fmtMoneyExact(point.total) : 'אין רשומות'}`).join(', ')}`;

  return (
    <ChartViewport className="h-7 min-w-16 flex-1" label={ariaLabel}>
      {(animation) => (
        <ResponsiveContainer>
          <AreaChart data={plotted} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={t.bar} stopOpacity={0.18} />
                <stop offset="100%" stopColor={t.bar} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="total" stroke={t.bar} strokeWidth={1.5}
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

/** Vertical bar chart, rank-colored (T7.3k, owner on image #24): the HIGHEST bucket wears
 *  ONYX, the LOWEST positive bucket wears the pale ramp step, and everything between is
 *  OCEANIC. Named owner exception to "color follows the entity, never its rank" — here the
 *  color IS the ranking, restated by the ARIA text and the tooltip values. Thin, rounded
 *  marks; empty → emptyMessage, not empty axes. */
export function SpendBarChart({
  points, ariaLabel, emptyMessage, className = 'mt-2 h-32 sm:h-48', maxBarSize = 32, valueFormatter = fmtMoneyExact,
}: {
  points: BarPoint[];
  ariaLabel: string;
  emptyMessage: string;
  className?: string;
  maxBarSize?: number;
  valueFormatter?: (v: number) => string;
}) {
  const t = chartTheme();
  const positive = points.filter((p) => p.total > 0).map((p) => p.total);
  const max = positive.length ? Math.max(...positive) : 0;
  const min = positive.length ? Math.min(...positive) : 0;
  const rankFill = (total: number) => {
    if (total <= 0) return t.bars[4];
    if (total === max) return t.bars[3];      // onyx — the highest
    if (total === min) return t.bars[4];      // pale gray-teal — the lowest
    return t.bar;                             // oceanic — the middle
  };
  return (
    <ChartViewport className={className} label={ariaLabel}>
      {(animation) => points.length ? (
        <ResponsiveContainer>
          <BarChart data={points} margin={{ top: 12, left: 8, right: 8 }}>
            {/* Reference bar language (T7.2): faint SOLID horizontal guides only, no on-bar
                numbers — the dark tooltip and the ARIA text carry the values. */}
            <CartesianGrid vertical={false} stroke={t.grid} />
            <XAxis dataKey="key" tick={{ fontSize: 12, fill: t.tick }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip cursor={false} isAnimationActive={animation.active}
              content={<DarkTooltip formatter={valueFormatter} colorFor={(entry) => rankFill(Number(entry.value ?? 0))} />} />
            <Bar dataKey="total" name="סה״כ" radius={[8, 8, 0, 0]} maxBarSize={maxBarSize}
              isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish}>
              {points.map((p) => <Cell key={p.key} fill={rankFill(p.total)} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : <div className="flex h-full items-center justify-center text-sm text-ink-muted">{emptyMessage}</div>}
    </ChartViewport>
  );
}

export type CategorySlice = { name: string; total: number };

/* T7.1: the ramp is palette-derived, and its two teal steps are the closest pair — so adjacent
   donut slices are assigned in the order [deep-teal, teal-mid, slate, teal-light]: the slate
   step separates the two teals, and every adjacent pair crosses a family or a large lightness
   band. "אחר" keeps bars[4] (bronze). ONE definition, used by both the arc Cell and the legend
   swatch — the duplicated expression they had before was an unchecked contract. */
const DONUT_ORDER = [0, 1, 3, 2] as const;
function sliceColor(bars: string[], name: string, index: number) {
  return name === 'אחר' ? bars[4] : bars[DONUT_ORDER[index % DONUT_ORDER.length]];
}

/** Donut + center total + HTML legend. Generalizes the owner category-mix chart; run `slices` through
 *  topCategoriesWithOther first. `total` drives the center + percentages; total<=0 → emptyMessage. */
/**
 * `hrefFor` — G1, finding 13. Optional, and the legend is where it lands rather than the SVG arcs:
 * the arcs carry `rootTabIndex={-1}` and no text, so a link on them would be reachable by mouse
 * only, while the legend row already names the slice and its share. Returning `null` leaves that
 * row plain — the aggregated "אחר" slice is not a destination, because there is no one thing to
 * open. Callers that pass nothing keep exactly the markup they had.
 */
export function CategoryDonut({ slices, total, ariaLabel, emptyMessage, hrefFor, hrefLabel }: {
  slices: CategorySlice[];
  total: number;
  ariaLabel: string;
  emptyMessage: string;
  hrefFor?: (slice: CategorySlice) => string | null;
  hrefLabel?: (slice: CategorySlice) => string;
}) {
  const t = chartTheme();
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
                    <Cell key={slice.name} fill={sliceColor(t.bars, slice.name, index)} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-content-center text-center" aria-hidden="true">
              <span className="num text-xl font-semibold text-ink sm:text-2xl">{moneyShort(total)}</span>
              <span className="text-xs text-ink-muted">סה״כ</span>
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
              style={{ backgroundColor: sliceColor(t.bars, slice.name, index) }} />
          );
          return (
            <li key={slice.name}>
              {href ? (
                <Link to={href} aria-label={hrefLabel?.(slice) ?? slice.name} title={fmtMoneyExact(slice.total)}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-1.5 text-action hover:bg-action-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  {swatch}
                  <span className="max-w-32 truncate">{slice.name}</span>
                  <span className="num text-ink-muted">{pct}%</span>
                </Link>
              ) : (
                <div className="inline-flex min-h-11 items-center gap-1.5 px-1.5 text-ink-mid" title={fmtMoneyExact(slice.total)}>
                  {swatch}
                  <span className="max-w-32 truncate">{slice.name}</span>
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

/**
 * CoverageRing (T7.1) — the reference's radial-progress rendering, for a TRUE numerator/denominator
 * only. Plain SVG arc (ponytail: recharts RadialBarChart is a dependency-shaped hammer for one
 * circle): a quiet track in the grid color, a brand-color arc for the covered share, the percent
 * in the center and the honest count sentence beside it. `total === 0` renders the empty message —
 * a coverage claim over nothing is not 0% and not 100%.
 */
export function CoverageRing({ covered, total, label, emptyMessage, sentence }: {
  covered: number;
  total: number;
  label: string;
  emptyMessage: string;
  /** The honest wording under the ring, e.g. "12 מתוך 15 דרישות פעילות". */
  sentence: string;
}) {
  const t = chartTheme();
  if (total <= 0) {
    return <div className="flex h-24 items-center justify-center text-center text-sm text-ink-muted sm:h-40">{emptyMessage}</div>;
  }
  const pct = Math.round((covered / total) * 100);
  const radius = 44;
  const circumference = 2 * Math.PI * radius;
  const arc = (Math.min(covered, total) / total) * circumference;
  // T7.3j (owner, image #23 "Total Visitors Chart - Shape"): thick ring, a pale system-ramp
  // track under a mid-oceanic arc, a BIG value + tiny label in the center, and a two-line
  // caption below — a semibold headline line and the muted honest count under it.
  return (
    <div className="mt-2 flex min-h-36 flex-col items-center justify-center gap-3 sm:min-h-44" role="img" aria-label={`${label}: ${sentence}, ${pct} אחוז`}>
      <div className="relative size-28 sm:size-36">
        <svg viewBox="0 0 112 112" className="size-full -rotate-90" aria-hidden="true">
          <circle cx="56" cy="56" r={radius} fill="none" stroke={t.bars[4]} strokeWidth="14" />
          <circle cx="56" cy="56" r={radius} fill="none" stroke={t.bars[1]} strokeWidth="14" strokeLinecap="round"
            strokeDasharray={`${arc} ${circumference - arc}`} />
        </svg>
        <div className="absolute inset-0 grid place-content-center text-center" aria-hidden="true">
          <span className="num text-3xl font-semibold text-ink sm:text-4xl">{covered}</span>
          <span className="text-xs text-ink-muted">עם תאריך</span>
        </div>
      </div>
      <div className="text-center" aria-hidden="true">
        <p className="text-sm font-semibold text-ink-body"><span className="num" dir="ltr">{pct}%</span> מהדרישות עם תאריך</p>
        <p className="text-xs text-ink-muted">{sentence}</p>
      </div>
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

/** 1–2 smooth layered areas over a shared x-axis — the reference's "Sale Activity" rendering
 *  (T7.2): NO grid, NO dots, a soft gradient wash under each line (~28% at the stroke fading
 *  to 0; `dash` series draw dashed per T7.3g), and the series NAME as a small ink label at the line's end —
 *  identity never rests on color alone, and no legend box is needed. Empty (no non-null point) →
 *  emptyMessage; with the fully-fetched-window zero policy, callers pass [] when the whole window
 *  has no activity so two flat zero lines never fabricate a chart. `legend` kept for callers that
 *  still want the swatch row (default off — end labels replace it). */
export function ComparisonLineChart({
  points, xKey = 'x', series, ariaLabel, emptyMessage,
  className = 'mt-2 h-32 sm:h-48', valueFormatter = fmtMoneyExact, legend = false,
}: {
  points: LinePoint[];
  xKey?: string;
  series: LineSeries[];
  ariaLabel: string;
  emptyMessage: string;
  className?: string;
  valueFormatter?: (v: number) => string;
  legend?: boolean;
}) {
  const t = chartTheme();
  const gradientBase = `cmpArea${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const hasData = points.length > 0 && points.some((point) => series.some((s) => point[s.key] != null));
  const lastIndex = points.length - 1;
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
              <XAxis dataKey={xKey} tick={{ fontSize: 12, fill: t.tick }} axisLine={false} tickLine={false} />
              <YAxis hide />
              {/* T7.3g: dashed hover cursor — the owner drew exactly this on image #16. */}
              <Tooltip cursor={{ stroke: t.tick, strokeWidth: 1, strokeDasharray: '4 4' }}
                content={<DarkTooltip formatter={valueFormatter} />} isAnimationActive={animation.active} />
              {series.map((s, index) => (
                <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2.5}
                  strokeDasharray={s.dash ? '7 5' : undefined}
                  fill={`url(#${gradientBase}${index})`} dot={false} connectNulls={false}
                  isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish}>
                  {/* The series name rides the END of its own line, in ink (never the series hue).
                      The per-series dy stagger keeps the two labels apart when both lines end at
                      the same value — e.g. a shared measured-zero tail. */}
                  <LabelList dataKey={s.key} content={({ x, y, index: pointIndex }) => (
                    pointIndex === lastIndex && typeof x === 'number' && typeof y === 'number' ? (
                      <text x={x + 8} y={y + 4 - index * 14} fontSize={12} fontWeight={500} fill={t.label} textAnchor="start">{s.name}</text>
                    ) : null
                  )} />
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
  className = 'mt-2 h-32 sm:h-48', valueFormatter = fmtMoneyExact,
}: {
  points: LinePoint[];
  xKey?: string;
  series: LineSeries[];
  ariaLabel: string;
  emptyMessage: string;
  className?: string;
  valueFormatter?: (v: number) => string;
}) {
  const t = chartTheme();
  const hasData = points.length > 0 && points.some((point) => series.some((s) => point[s.key] != null));
  return (
    <>
      <ChartViewport className={className} label={ariaLabel}>
        {(animation) => hasData ? (
          <ResponsiveContainer>
            <BarChart data={points} margin={{ top: 12, left: 8, right: 8 }} barGap={3}>
              <CartesianGrid vertical={false} stroke={t.grid} />
              <XAxis dataKey={xKey} tick={{ fontSize: 12, fill: t.tick }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip cursor={false} content={<DarkTooltip formatter={valueFormatter} />} isAnimationActive={animation.active} />
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
