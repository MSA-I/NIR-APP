// Section 4 — supplier decision-support metrics.
//
// These live here (not in ui.tsx) because ui.tsx has a single owner this wave. The pieces:
//   SupplierMetrics  — the row shape of the supplier_metrics view (0011). Hand-written like
//                      every other view type (types.ts convention); tsc cannot derive it, so
//                      it MUST match the 16 select columns of 0011 exactly.
//   Scorecard        — one card holding a compact grid of metric tiles, NOT a KpiCard grid
//                      (see docs/nir/04-suppliers.md §4.4 for why KpiCard is wrong here).
//   RatingStars      — read-only when onChange is omitted; interactive radiogroup otherwise.
//   PriceSparkline   — a static, axis-less step line for the prices tab.
//
// Colors: the metric-tile value colors map to the settled semantic tokens (done/await/alert/info
// — audit 2026-07-21, once status.ts/index.css finished this wave's rewrite). The star glyphs
// (RatingStars) and the price trend line (PriceSparkline) stay on raw utilities/hex on purpose:
// they are a rating affordance and a direction-of-change, not status claims, so the semantic
// tokens would misrepresent them.

import { LineChart, Line } from 'recharts';
import { Star } from 'lucide-react';
import type { SupplierMetrics } from '../lib/types';

export type { SupplierMetrics };  // re-exported so Suppliers.tsx's existing import keeps resolving

// Local tone union, deliberately NOT status.ts's Tone: these are value-colors for metric tiles
// keyed by plain color names (green/amber/red/…) chosen at the call site from thresholds — a
// different vocabulary than status.ts's semantic claims. The values below map each onto the
// settled semantic token so the palette stays single-sourced (audit 2026-07-21). `violet` is
// gone: it had no caller and no place in the four-meaning language.
export type ScoreTone = 'slate' | 'green' | 'amber' | 'red' | 'blue';


// Metric formatters — kept local rather than added to format.ts, which is not owned this wave.
// Both return an em dash for null, matching fmtMoney's convention (format.ts:8).
export const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}%`);
export const fmtLeadDays = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)} ימים`);

// Value text color per tone → the semantic token utilities (audit 2026-07-21). Mirrors KpiCard's
// mapping (ui.tsx). amber→await-fg lifts the 16px tile value off the failing 3.19:1 contrast that
// amber-600 gave; green→done-fg, red→alert-fg, blue→info-fg.
const TONE_TEXT: Record<ScoreTone, string> = {
  slate: 'text-slate-900',
  green: 'text-done-fg',
  amber: 'text-await-fg',
  red: 'text-alert-fg',
  blue: 'text-info-fg',
};

export interface ScoreItem {
  label: string;
  value: string;
  sub?: string;
  tone?: ScoreTone;
  /** false → render the value as plain RTL text (e.g. free-text payment terms), not a `.num` cell. */
  numeric?: boolean;
}

/**
 * One card, one grid of compact tiles — reads as a single spec sheet, not eight competing
 * dashboard cards (docs/nir/04-suppliers.md §4.4). No divide-x: it forces physical left/right
 * borders that break under RTL; separation is gap-based, which is direction-agnostic.
 */
export function Scorecard({ items }: { items: ScoreItem[] }) {
  return (
    <div className="card card-pad">
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-x-6 gap-y-4">
        {items.map((it, i) => (
          <div key={i}>
            <div className="text-xs font-medium text-slate-500">{it.label}</div>
            <div className={`text-base font-semibold mt-0.5 ${it.numeric === false ? 'text-start' : 'num'} ${TONE_TEXT[it.tone ?? 'slate']}`}>
              {it.value}
            </div>
            {it.sub && <div className="text-xs text-slate-400 mt-0.5">{it.sub}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Rating display / editor. Read-only when `onChange` is omitted (one amber glyph per filled
 * star). Interactive variant is a keyboard-accessible radiogroup; the "נקה" button and star 0
 * both mean "clear" — the caller maps 0 to null.
 */
export function RatingStars({ value, onChange }: { value: number | null; onChange?: (n: number) => void }) {
  const stars = [1, 2, 3, 4, 5];

  if (!onChange) {
    return (
      <span className="inline-flex items-center gap-0.5"
        aria-label={value != null ? `דירוג ${value} מתוך 5` : 'ספק לא דורג'}
        title={value != null ? `דירוג ${value} מתוך 5` : 'לא דורג'}>
        {stars.map((n) => (
          <Star key={n} size={15}
            className={value != null && n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />
        ))}
      </span>
    );
  }

  return (
    <span role="radiogroup" aria-label="דירוג ספק" className="inline-flex items-center gap-0.5">
      {stars.map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} כוכבים`}
          onClick={() => onChange(n)} className="p-0.5 cursor-pointer leading-none">
          <Star size={20}
            className={value != null && n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-300 hover:text-amber-300'} />
        </button>
      ))}
      {value != null && (
        <button type="button" className="text-xs text-slate-400 hover:text-slate-600 ms-1" onClick={() => onChange(0)}>
          נקה
        </button>
      )}
    </span>
  );
}

/**
 * A static price trend for one product. price_history records only *changes*, so the series is
 * a step function, not a continuous line. Fixed 96×28, no axes/grid/tooltip, no animation
 * (15 of these render at once), wrapped dir="ltr" like the charts in Dashboard.tsx. Returns
 * null under two points — a single dot is noise, not a trend.
 */
export function PriceSparkline({ points }: { points: number[] }) {
  if (!points || points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const stroke = last > first ? '#f43f5e' /* rose-500 */
    : last < first ? '#10b981' /* emerald-500 */
    : '#94a3b8'; /* slate-400 */
  const data = points.map((price, i) => ({ i, price }));
  return (
    <span dir="ltr" className="inline-block align-middle">
      <LineChart width={96} height={28} data={data} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
        <Line type="stepAfter" dataKey="price" stroke={stroke} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </span>
  );
}
