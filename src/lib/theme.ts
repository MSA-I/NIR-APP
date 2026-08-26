// Chart colors resolved from the @theme tokens in index.css. recharts writes fill/stroke as
// SVG presentation *attributes*, where var() resolution is not guaranteed — so we read the
// computed values once and hand recharts real color strings. Module-level cache: the theme is
// static per page load; a future runtime theme switch must invalidate `cache`.
type ChartTheme = {
  bar: string;
  barHigh: string;
  barLow: string;
  categorical: string[];
  grid: string;
  tick: string;
  label: string;
  /** The card the charts are drawn on. Used as a COLLAR around a mark that may land on top of
   *  another one — the terminal dots of the comparison lines — the same trick the donut's 2px
   *  paddingAngle plays, so two coincident marks still read as two. */
  surface: string;
  trendUp: string;
  trendDown: string;
  flat: string;
};

let cache: ChartTheme | null = null;

export function chartTheme() {
  if (!cache) {
    const s = getComputedStyle(document.documentElement);
    const v = (name: string) => s.getPropertyValue(name).trim();
    const bar = v('--color-bar-mid');
    cache = {
      bar,
      barHigh: v('--color-bar-high'),
      barLow: v('--color-bar-low'),
      // Two palettes, two jobs. bar/barHigh/barLow are the sequential ramp — magnitude, where
      // lightness order carries meaning. `categorical` is identity, where it cannot: see the
      // block above --color-series-1 in index.css for the measurement that separated them.
      //
      // Until 25.08.2026 the ramp read chart-1..5, which is where the two jobs had been split
      // — but it left the ramp in the OLD hue family after identity had moved to series-*, so
      // one screen showed two colour vocabularies at once. The ramp is now three lightness
      // steps of series-1's hue: same family, still a ramp. `bars` (the five-entry array) is
      // gone with it; only these three steps were ever read, and an array of five invited a
      // sixth caller to pick an index nobody had measured.
      categorical: [v('--color-series-1'), v('--color-series-2'), v('--color-series-3'),
        v('--color-series-4'), v('--color-series-5')],
      grid: v('--color-chart-grid'),
      tick: v('--color-chart-tick'),
      label: v('--color-chart-label'),
      surface: v('--color-surface'),
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
 * Both existing comparison charts used to choose their own indices, and they disagreed in the
 * worst possible direction: the main dashboard separated its two series by 1.56:1 and carried a
 * dash, while the accountant dashboard separated by 4.23:1 and carried none.
 *
 * WHY THE MEASURE CHANGED (24.08.2026). That 3:1 floor was a WCAG contrast ratio, which is a
 * LIGHTNESS ratio — the right instrument only while the ramp was monochrome and lightness was
 * the only separation colour could give. With a categorical palette it is the wrong instrument
 * and an impossible one: those steps sit at similar lightness on purpose, so that no series
 * dominates, and inside the validator's L band no two of them can reach 3:1 at all. The measure
 * that actually answers "can a reader tell these two apart" is OKLab ΔE, and colorLanguage.spec
 * now holds it at >= 15 for normal vision and >= 8 under simulated protanopia/deuteranopia.
 * series-1 vs series-2 measures 26.1 normal, 23.6 worst-CVD — the strongest pair the palette
 * offers that also keeps the primary in the brand's oceanic family.
 *
 * `dash` on the counterpart is not decoration and not optional WHERE A STROKE EXISTS: in
 * ComparisonLineChart it is what keeps the two series apart in greyscale print, in a compressed
 * screenshot, and for a reader who sees no colour at all. Hue got better; it did not become
 * sufficient. GroupedBarChart ignores the field — a filled bar has no stroke to dash — and
 * carries its second identity in the dot legend below the plot instead.
 */
export function comparisonSeries(
  primary: { key: string; name: string },
  counterpart: { key: string; name: string },
) {
  const t = chartTheme();
  return [
    { ...primary, color: t.categorical[0] },
    { ...counterpart, color: t.categorical[1], dash: true },
  ];
}
