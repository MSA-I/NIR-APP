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
  tickStrong: string;
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
      tickStrong: v('--color-chart-tick-strong'),
      trendUp: v('--color-trend-up-fg'),
      trendDown: v('--color-trend-down-fg'),
      flat: v('--color-ink-faint'),
    };
  }
  return cache;
}
