import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { chartTheme } from '../lib/theme';
import { fmtMoneyExact } from '../lib/format';
import type { DashboardWeeklyPoint } from '../lib/dashboardSeries';

/**
 * Shared chart primitives + generalized chart blocks. Extracted verbatim from the owner dashboard
 * (Dashboard.tsx) so every screen renders identical recharts output; the generalized components only
 * parameterize the data/labels/colors that were already parameters. Every chart is wrapped in
 * ChartViewport, which carries the RTL (dir="ltr"), first-viewport animation, prefers-reduced-motion,
 * and role="img"/aria contract — so any dashboard that uses these inherits all of it for free.
 * Colors always come from chartTheme() (resolved CSS-var strings) — never hex/palette literals (DESIGN).
 */

// whole-₪ label for bars; compact "₪8.1k" for dense axes/centers.
export const money = (v: number) => `₪${Math.round(v).toLocaleString('he-IL')}`;
export const moneyShort = (v: number) =>
  (Math.abs(v) >= 1000 ? `₪${(v / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 })}k` : `₪${Math.round(v)}`);

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
  const plotted = points.map((point) => ({ ...point, total: point.count > 0 ? point.total : null }));
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
            <Area type="linear" dataKey="total" stroke={t.bar} strokeWidth={1.5}
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

/** Vertical bar chart with per-bar color + on-bar value labels. Generalizes the owner monthly-spend
 *  chart; `points` is oldest→newest (the newest bar takes chart-1). Empty → emptyMessage, not empty axes. */
export function SpendBarChart({
  points, ariaLabel, emptyMessage, className = 'mt-2 h-32 sm:h-48', maxBarSize = 52, valueFormatter = fmtMoneyExact,
}: {
  points: BarPoint[];
  ariaLabel: string;
  emptyMessage: string;
  className?: string;
  maxBarSize?: number;
  valueFormatter?: (v: number) => string;
}) {
  const t = chartTheme();
  return (
    <ChartViewport className={className} label={ariaLabel}>
      {(animation) => points.length ? (
        <ResponsiveContainer>
          <BarChart data={points} margin={{ top: 24, left: 8, right: 8 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={t.grid} />
            <XAxis dataKey="key" tick={{ fontSize: 12, fill: t.tick }} axisLine={false} tickLine={false} />
            <YAxis hide />
            <Tooltip cursor={false} formatter={(value) => valueFormatter(Number(value))} isAnimationActive={animation.active} />
            <Bar dataKey="total" name="סה״כ" fill={t.bar} radius={[4, 4, 0, 0]} maxBarSize={maxBarSize}
              isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish}>
              {points.map((point, index) => (
                <Cell key={point.key} fill={t.bars[(points.length - 1 - index) % t.bars.length]} />
              ))}
              <LabelList dataKey="label" position="top" style={{ fontSize: 12, fill: t.label }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      ) : <div className="flex h-full items-center justify-center text-sm text-ink-muted">{emptyMessage}</div>}
    </ChartViewport>
  );
}

export type CategorySlice = { name: string; total: number };

/** Donut + center total + HTML legend. Generalizes the owner category-mix chart; run `slices` through
 *  topCategoriesWithOther first. `total` drives the center + percentages; total<=0 → emptyMessage. */
export function CategoryDonut({ slices, total, ariaLabel, emptyMessage }: {
  slices: CategorySlice[];
  total: number;
  ariaLabel: string;
  emptyMessage: string;
}) {
  const t = chartTheme();
  if (total <= 0) {
    return <div className="flex h-24 items-center justify-center text-center text-sm text-ink-muted sm:h-44">{emptyMessage}</div>;
  }
  return (
    <div className="mt-2 flex min-h-36 flex-col items-stretch gap-3 sm:min-h-44 sm:flex-row sm:items-center">
      <ChartViewport className="relative mx-auto h-28 w-28 shrink-0 sm:h-40 sm:w-40" label={ariaLabel}>
        {(animation) => (
          <>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={slices} dataKey="total" nameKey="name" innerRadius="60%" outerRadius="88%"
                  rootTabIndex={-1} paddingAngle={2} stroke="none" isAnimationActive={animation.active} animationDuration={550}
                  animationEasing="ease-out" onAnimationEnd={animation.finish}>
                  {slices.map((slice, index) => (
                    <Cell key={slice.name} fill={slice.name === 'אחר' ? t.bars[4] : t.bars[index % 4]} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 grid place-content-center text-center" aria-hidden="true">
              <span className="text-xs text-ink-muted">סה״כ</span>
              <span className="num text-sm font-semibold text-ink">{moneyShort(total)}</span>
            </div>
          </>
        )}
      </ChartViewport>
      <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
        {slices.map((slice, index) => (
          <li key={slice.name} className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full" aria-hidden="true"
              style={{ backgroundColor: slice.name === 'אחר' ? t.bars[4] : t.bars[index % 4] }} />
            <span className="min-w-0 flex-1 break-words text-ink-mid sm:truncate">{slice.name}</span>
            <span className="shrink-0 text-ink-muted" title={fmtMoneyExact(slice.total)}>
              <span className="num">{moneyShort(slice.total)}</span> · <span className="num">{Math.round((slice.total / total) * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type LineSeries = { key: string; name: string; color: string; dashed?: boolean };
/** A chart row keyed by field name (x + one field per series). Index signature so callers can build
 *  arbitrarily-keyed points and still pass them by value (no per-shape interface needed). */
export type LinePoint = Record<string, string | number | null>;

/** 1–2 line series over a shared x-axis. Generalizes the owner weekly purchases-vs-payments chart;
 *  a dashed series stays distinguishable in print (DESIGN §5). Empty (no non-null point) → emptyMessage.
 *  `legend={true}` renders the swatch row above the plot; owner keeps its own header legend (legend=false). */
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
  const hasData = points.length > 0 && points.some((point) => series.some((s) => point[s.key] != null));
  return (
    <>
      {legend && (
        <div className="flex items-center justify-end gap-4 text-xs text-ink-muted" aria-hidden="true">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className={`w-6 border-t-2${s.dashed ? ' border-dashed' : ''}`} style={{ borderColor: s.color }} />{s.name}
            </span>
          ))}
        </div>
      )}
      <ChartViewport className={className} label={ariaLabel}>
        {(animation) => hasData ? (
          <ResponsiveContainer>
            <LineChart data={points} margin={{ top: 8, left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={t.grid} />
              <XAxis dataKey={xKey} tick={{ fontSize: 12, fill: t.tick }} axisLine={false} tickLine={false} />
              <YAxis hide />
              <Tooltip cursor={false} formatter={(value) => (value == null ? '—' : valueFormatter(Number(value)))}
                isAnimationActive={animation.active} />
              {series.map((s) => (
                <Line key={s.key} type="linear" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2}
                  strokeDasharray={s.dashed ? '6 4' : undefined} dot={{ r: 2.5, strokeWidth: 0 }} connectNulls={false}
                  isAnimationActive={animation.active} animationDuration={550} animationEasing="ease-out" onAnimationEnd={animation.finish} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : <div className="flex h-full items-center justify-center text-sm text-ink-muted">{emptyMessage}</div>}
      </ChartViewport>
    </>
  );
}
