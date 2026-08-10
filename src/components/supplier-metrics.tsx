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
// Colors: the metric-tile value colors map to the settled semantic tokens, and since the 2026-08-02
// polish sweep the tiles are also *keyed* by that vocabulary (ScoreTone = status.ts's Tone) rather
// than by colour names. The star glyphs (RatingStars) and the price trend line (PriceSparkline) stay
// on raw utilities/hex on purpose: they are a rating affordance and a direction-of-change, not status
// claims, so the semantic tokens would misrepresent them.

import { LineChart, Line } from 'recharts';
import { Star } from 'lucide-react';
import type { SupplierMetrics } from '../lib/types';
import type { Tone } from '../lib/status';
import { chartTheme } from '../lib/theme';
import { useId } from 'react';

export type { SupplierMetrics };  // re-exported so Suppliers.tsx's existing import keeps resolving

// Unified onto status.ts's Tone (polish sweep 2026-08-02). The previous local union keyed tiles by
// plain colour names (green/amber/red/…) on the theory that a threshold-derived value colour is a
// different thing from a status claim. It is not: `openBalance ? 'amber' : 'slate'` says "awaiting
// action" vs "no claim" — exactly await vs idle — and the colour name only hid which of the four
// meanings was being asserted. One vocabulary now (PRODUCT.md §"שפה סמנטית אחת"); the rendered
// classes are unchanged, so this renamed nothing on screen.
export type ScoreTone = Tone;


// Metric formatters — kept local rather than added to format.ts, which is not owned this wave.
// Both return an em dash for null, matching fmtMoney's convention (format.ts:8).
export const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}%`);
export const fmtLeadDays = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)} ימים`);

// Value text colour per tone → the semantic token utilities. Mirrors KpiCard's mapping (ui.tsx).
// await-fg lifts the 16px tile value off the failing 3.19:1 contrast that amber-600 gave.
const TONE_TEXT: Record<ScoreTone, string> = {
  idle: 'text-ink',
  done: 'text-done-fg',
  await: 'text-await-fg',
  alert: 'text-alert-fg',
  info: 'text-info-fg',
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
            <div className="text-xs font-medium text-ink-muted">{it.label}</div>
            <div className={`text-base font-semibold mt-0.5 ${it.numeric === false ? 'text-start' : 'num'} ${TONE_TEXT[it.tone ?? 'idle']}`}>
              {it.value}
            </div>
            {it.sub && <div className="text-xs text-ink-faint mt-0.5">{it.sub}</div>}
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
export function RatingStars({ value, onChange, label = 'דירוג ספק' }: { value: number | null; onChange?: (n: number) => void; label?: string }) {
  const stars = [1, 2, 3, 4, 5];
  const groupName = useId();

  if (!onChange) {
    return (
      <span className="inline-flex items-center gap-0.5"
        aria-label={value != null ? `דירוג ${value} מתוך 5` : 'ספק לא דורג'}
        title={value != null ? `דירוג ${value} מתוך 5` : 'לא דורג'}>
        {stars.map((n) => (
          <Star key={n} size={15} aria-hidden="true"
            className={value != null && n <= value ? 'fill-star text-star' : 'text-ink-ghost'} />
        ))}
      </span>
    );
  }

  return (
    <span role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5">
      {stars.map((n) => (
        <label key={n} className="cursor-pointer rounded-sm p-0.5 leading-none focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-action">
          <input className="sr-only" type="radio" name={groupName} value={n} checked={value === n}
            aria-label={`${n} כוכבים`} onChange={() => onChange(n)} />
          <Star size={20} aria-hidden="true"
            className={value != null && n <= value ? 'fill-star text-star' : 'text-ink-ghost hover:text-star-hover'} />
        </label>
      ))}
      {value != null && (
        /* 44px, like every other action in the app (DESIGN.md). It was a bare text button with no
           height floor — the smallest touch target in the interface, next to five star radios. */
        <button type="button"
          className="ms-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-xs text-ink-faint hover:text-ink-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => onChange(0)}>
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
  const t = chartTheme();
  const stroke = last > first ? t.trendUp : last < first ? t.trendDown : t.flat;
  const data = points.map((price, i) => ({ i, price }));
  return (
    <span dir="ltr" className="inline-block align-middle">
      <LineChart width={96} height={28} data={data} margin={{ top: 4, right: 2, bottom: 4, left: 2 }}>
        <Line type="stepAfter" dataKey="price" stroke={stroke} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </span>
  );
}
