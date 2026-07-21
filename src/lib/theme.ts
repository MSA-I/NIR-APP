// Chart colors resolved from the @theme tokens in index.css. recharts writes fill/stroke as
// SVG presentation *attributes*, where var() resolution is not guaranteed — so we read the
// computed values once and hand recharts real color strings. Module-level cache: the theme is
// static per page load; a future runtime theme switch must invalidate `cache`.
let cache: Record<string, string> | null = null;

export function chartTheme() {
  if (!cache) {
    const s = getComputedStyle(document.documentElement);
    const v = (name: string) => s.getPropertyValue(name).trim();
    cache = {
      bar: v('--color-chart-1'),
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
