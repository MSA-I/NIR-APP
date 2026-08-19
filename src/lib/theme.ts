// Chart colors resolved from the @theme tokens in index.css. recharts writes fill/stroke as
// SVG presentation *attributes*, where var() resolution is not guaranteed — so we read the
// computed values once and hand recharts real color strings. Module-level cache: the theme is
// static per page load; a future runtime theme switch must invalidate `cache`.
type ChartTheme = {
  bar: string;
  bars: string[];
  grid: string;
  tick: string;
  label: string;
  trendUp: string;
  trendDown: string;
  flat: string;
};

let cache: ChartTheme | null = null;

export function chartTheme() {
  if (!cache) {
    const s = getComputedStyle(document.documentElement);
    const v = (name: string) => s.getPropertyValue(name).trim();
    const bar = v('--color-chart-1');
    cache = {
      bar,
      bars: [bar, v('--color-chart-2'), v('--color-chart-3'), v('--color-chart-4'), v('--color-chart-5')],
      grid: v('--color-chart-grid'),
      tick: v('--color-chart-tick'),
      label: v('--color-chart-label'),
      trendUp: v('--color-trend-up-fg'),
      trendDown: v('--color-trend-down-fg'),
      // A line in a chart belongs to the chart layer. `flat` used to read --color-ink-faint,
      // which is tuned for placeholder legibility — two opposite reasons to change, one token:
      // retuning the hint colour would have moved a price line, and vice versa.
      flat: v('--color-chart-3'),
    };
  }
  return cache;
}

/**
 * The two roles a comparison chart has, and the pairing that serves them — decided here, once,
 * instead of at each call site.
 *
 * Both existing comparison charts chose their own indices, and they disagreed in the worst
 * possible direction: the main dashboard separated its two series by 1.56:1 and carried a dash,
 * while the accountant dashboard separated by 4.23:1 and carried none. The ramp is
 * monochrome-sequential, so lightness is the only separation colour can give — and the dash is
 * the carrier that is not colour at all. There is no reason to spend one and not the other.
 *
 * chart-1 ↔ chart-3 measures 4.23:1. Every other pair, for the record: 1↔2 2.24 · 1↔4 1.56 ·
 * 1↔5 6.97 · 2↔3 1.89 · 2↔4 3.51 · 2↔5 3.11 · 3↔4 6.61 · 3↔5 1.65 · 4↔5 10.89. A future third
 * role picks from that table, not by eye — and `colorLanguage.spec.ts` holds the 3:1 floor.
 *
 * `dash` on the counterpart is not decoration and not optional WHERE A STROKE EXISTS: in
 * ComparisonLineChart it is what keeps the two series apart in greyscale print, in a compressed
 * screenshot, and under colour-vision deficiency. GroupedBarChart ignores the field — a filled
 * bar has no stroke to dash — and carries its second identity in the dot legend below the plot
 * instead. Measured in the browser: the line chart renders stroke-dasharray "7 5" on the
 * counterpart; the bars render the same two fills with the legend beneath them.
 */
export function comparisonSeries(
  primary: { key: string; name: string },
  counterpart: { key: string; name: string },
) {
  const t = chartTheme();
  return [
    { ...primary, color: t.bars[0] },
    { ...counterpart, color: t.bars[2], dash: true },
  ];
}
