export const BUSINESS_TIME_ZONE = 'Asia/Jerusalem';

/**
 * Two money shapes, and deliberately no third.
 *
 * There used to be a `fmtMoney` with `minimumFractionDigits: 0, maximumFractionDigits: 2` — a
 * formatter whose OUTPUT SHAPE depended on the value. Inside one column it produced `0 ₪`,
 * `780 ₪` and `1,650.6 ₪`, and `1,650.6 ₪` is not a figure an accountant accepts. Call sites had
 * started compensating for it: `fmtMoney(Math.round(v))` appeared in Dashboard and Expenses, which
 * is the shape of a formatter nobody trusted. It is gone, and every one of its call sites now
 * chooses in the open.
 *
 * `fmtMoneyExact` — ledgers, tables, record detail and anything about money being moved. Always
 *   two decimals, so a column of figures aligns and agorot are never silently dropped.
 * `fmtMoneyRounded` — glance surfaces only: KPI tiles, chart axes, the dashboard money band.
 *   Always zero decimals. A headline that reads `18,420 ₪` is honest about being a headline.
 *
 * Both are stable: the shape follows the SURFACE, never the value.
 */
const ilsRounded = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 });
const ilsExact = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 });
/** Compact currency for chart axes, where a full figure per tick would not fit. */
const ilsCompact = new Intl.NumberFormat('he-IL', {
  style: 'currency', currency: 'ILS', notation: 'compact', maximumFractionDigits: 1,
});
/**
 * Quantities and counts, NOT money — and it keeps variable decimals on purpose. `3` invoices must
 * not render as `3.00`, and `2.5` kg must not render as `3`. The money rule above does not
 * transfer here, and an earlier draft of this change that applied it to `fmtNum` was wrong.
 */
const num = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: BUSINESS_TIME_ZONE });
const dateTimeFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: BUSINESS_TIME_ZONE });
const monthFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: BUSINESS_TIME_ZONE });

/**
 * Subscription catalogue prices, and the ONE reason a second currency exists in this file.
 *
 * The product's own money is shekels and stays that way (#14). A plan price is different:
 * OPEN-DECISIONS #208 keeps two versioned catalogues — ILS for a verified Israeli billing address,
 * USD for every other country — and the catalogue is chosen by the merchant of record, never by
 * this code. So the CURRENCY IS AN ARGUMENT, supplied by the row being rendered, and a currency
 * this function does not recognise returns an em dash rather than a figure in the wrong unit.
 *
 * Zero decimals, because every figure #195 decided is whole and a pricing surface is a glance
 * surface. As with the shekel formatters, the shape follows the surface and never the value.
 */
const usdRounded = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const fmtPlanPrice = (v: number | null | undefined, currency: string | null | undefined) => {
  if (v == null) return '—';
  if (currency === 'ILS') return ilsRounded.format(v);
  if (currency === 'USD') return usdRounded.format(v);
  return '—';
};

export const fmtMoneyExact = (v: number | null | undefined) => (v == null ? '—' : ilsExact.format(v));
export const fmtMoneyRounded = (v: number | null | undefined) => (v == null ? '—' : ilsRounded.format(v));
export const fmtMoneyCompact = (v: number | null | undefined) => (v == null ? '—' : ilsCompact.format(v));
export const fmtNum = (v: number | null | undefined) => (v == null ? '—' : num.format(v));

/**
 * First-strong bidi isolation for PLAIN-TEXT contexts (WhatsApp messages, <option> labels) —
 * the string twin of <bdi>. A user-entered name mixing Hebrew with digits/'*'/'/' reorders
 * against its neighbours unless the whole name is fenced as one run (DESIGN.md, חוק בידוד
 * השמות). Markup contexts wrap with <bdi> instead; this exists only where markup cannot go.
 */
export const bidiIsolate = (s: string): string => `⁨${s}⁩`; // FSI … PDI

/**
 * The name to SHOW for a product: the canonical one a person approved (0149), or the raw one
 * until somebody has. `display_name IS NULL` is the normal state — nothing was backfilled — so
 * every call site keeps rendering exactly what it rendered before this helper existed, and starts
 * showing a canonical name only for the rows an owner has actually reviewed.
 *
 * WHY A FUNCTION AND NOT `?? name` AT TWENTY CALL SITES. The interesting question about a product
 * name is not how to fall back, it is WHICH SIDE OF THE LINE a given screen is on. A grep for this
 * function returns the display half of the answer; the list below is the other half, and it is
 * the half that breaks silently if somebody is helpful in the wrong place.
 *
 * THESE MUST NEVER CALL IT, and `productLabel.spec.ts` fails the build if they do:
 *
 *   * MATCHING. `nameKey(product.name)` decides which spreadsheet row is which catalogue row —
 *     `PriceListUpload.tsx`, `QuickCreateProduct.tsx`, `Onboarding.tsx`, and the SQL twin
 *     `private.name_match_key`. Canonicalising here changes which rows are treated as the same
 *     product, which is a data outcome, not a display one.
 *   * SUPPLIER-FACING. `share.ts` (the WhatsApp order) and `orderImage.ts` (the order image). The
 *     supplier recognises THEIR name for the item; a name we composed arrives at someone who has
 *     never seen it and cannot act on it.
 *   * AUDIT. `audit_logs` and `/supplier-log` say what the record said, at the time it said it.
 *   * THE PROPOSAL SCREEN. `ProductNameReview.tsx` exists to show the raw name against a proposal.
 *
 * The parameter deliberately requires `display_name` rather than accepting it as optional: a
 * query that forgot to select the column then fails typecheck, instead of quietly rendering the
 * raw name forever on a screen everyone believes was switched.
 *
 * The blank guard is belt-and-braces — `products_display_name_shape` makes `''` unrepresentable
 * in the column — but rows also get built client-side (the duplicate-product prefill), and one
 * spelling of "no canonical name" is worth more than a second one nobody remembers.
 */
export function productLabel(product: { name: string; display_name: string | null }): string {
  return product.display_name?.trim() || product.name;
}

const UNIT_FORMS: Record<string, { singular: string; plural?: string }> = {
  'ארגז': { singular: 'ארגז', plural: 'ארגזים' },
  'ארגזים': { singular: 'ארגז', plural: 'ארגזים' },
  'בקבוק': { singular: 'בקבוק', plural: 'בקבוקים' },
  'בקבוקים': { singular: 'בקבוק', plural: 'בקבוקים' },
  'גל': { singular: 'גליל', plural: 'גלילים' },
  'גליל': { singular: 'גליל', plural: 'גלילים' },
  'גלילים': { singular: 'גליל', plural: 'גלילים' },
  'דלי': { singular: 'דלי', plural: 'דליים' },
  'דליים': { singular: 'דלי', plural: 'דליים' },
  'חבי': { singular: 'חבילה', plural: 'חבילות' },
  'חבילה': { singular: 'חבילה', plural: 'חבילות' },
  'חבילות': { singular: 'חבילה', plural: 'חבילות' },
  'חבית': { singular: 'חבית', plural: 'חביות' },
  'חביות': { singular: 'חבית', plural: 'חביות' },
  'יח': { singular: 'יחידה', plural: 'יחידות' },
  "יח'": { singular: 'יחידה', plural: 'יחידות' },
  'יח׳': { singular: 'יחידה', plural: 'יחידות' },
  'יחידה': { singular: 'יחידה', plural: 'יחידות' },
  'יחידות': { singular: 'יחידה', plural: 'יחידות' },
  'ליטר': { singular: 'ל׳' },
  'ליטרים': { singular: 'ל׳' },
  "ל'": { singular: 'ל׳' },
  'ל׳': { singular: 'ל׳' },
  'מארז': { singular: 'מארז', plural: 'מארזים' },
  'מארזים': { singular: 'מארז', plural: 'מארזים' },
  'מיכל': { singular: 'מיכל', plural: 'מיכלים' },
  'מיכלים': { singular: 'מיכל', plural: 'מיכלים' },
  'צרור': { singular: 'צרור', plural: 'צרורות' },
  'צרורות': { singular: 'צרור', plural: 'צרורות' },
  "ק'ג": { singular: 'ק״ג' },
  'ק"ג': { singular: 'ק״ג' },
  'ק״ג': { singular: 'ק״ג' },
  'קג': { singular: 'ק״ג' },
  'קרט': { singular: 'קרטון', plural: 'קרטונים' },
  'קרטון': { singular: 'קרטון', plural: 'קרטונים' },
  'קרטונים': { singular: 'קרטון', plural: 'קרטונים' },
  'שק': { singular: 'שק', plural: 'שקים' },
  'שקים': { singular: 'שק', plural: 'שקים' },
  'שקית': { singular: 'שקית', plural: 'שקיות' },
  'שקיות': { singular: 'שקית', plural: 'שקיות' },
  'שרוול': { singular: 'שרוול', plural: 'שרוולים' },
  'שרוולים': { singular: 'שרוול', plural: 'שרוולים' },
  'תבנית': { singular: 'תבנית', plural: 'תבניות' },
  'תבניות': { singular: 'תבנית', plural: 'תבניות' },
};

function cleanUnit(unit: string | null | undefined) {
  return unit?.trim().replace(/\s+/g, ' ') ?? '';
}

/** Canonical singular storage value for known aliases; unknown business units stay untouched. */
export function normalizeUnitInput(unit: string | null | undefined) {
  const cleaned = cleanUnit(unit);
  return UNIT_FORMS[cleaned]?.singular ?? cleaned;
}

/** User-facing unit. Exact quantity 1 uses singular; every other measured quantity uses plural. */
export function formatUnit(unit: string | null | undefined, quantity?: number | null) {
  const cleaned = cleanUnit(unit);
  if (!cleaned) return '';
  const form = UNIT_FORMS[cleaned];
  if (!form) return cleaned;
  return quantity != null && quantity !== 1 && form.plural ? form.plural : form.singular;
}

export function formatQuantity(quantity: number | null | undefined, unit: string | null | undefined) {
  if (quantity == null) return '—';
  const label = formatUnit(unit, quantity);
  return `${fmtNum(quantity)}${label ? ` ${label}` : ''}`;
}
export const fmtDate = (v: string | Date | null | undefined) => (v ? dateFmt.format(new Date(v)) : '—');
export const fmtDateTime = (v: string | Date | null | undefined) => (v ? dateTimeFmt.format(new Date(v)) : '—');
export const fmtMonth = (v: string | Date) => monthFmt.format(new Date(v));

// Runtime-local calendar day. Keep this for user-selected Date objects; business "today" uses
// toTimeZoneISO() below so results stay on Israel time even if a server/browser runs elsewhere.
export const toLocalISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function datePartsInTimeZone(d: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'), second: value('second') };
}

export function toTimeZoneISO(d: Date, timeZone = BUSINESS_TIME_ZONE) {
  const { year, month, day } = datePartsInTimeZone(d, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export const todayISO = () => toTimeZoneISO(new Date());
export const currentMonthISO = (d = new Date()) => toTimeZoneISO(d).slice(0, 7);

/**
 * A month filter that is safe to hand to `monthRange`, `fmtMonth` and a report filename.
 *
 * The raw value is user-supplied twice over: it lives in the URL, where anything can be typed or
 * pasted, and browsers without a native month picker render `<input type="month">` as free text.
 * Anything that is not a real calendar month falls back to the current one, so the screen shows a
 * month instead of throwing — the grammar accepted here is exactly `monthRange`'s, because every
 * consumer of a "sanitized" month eventually reaches it.
 */
export function safeMonthISO(raw: string | null | undefined): string {
  return raw && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw) ? raw : currentMonthISO();
}

// Business-timezone calendar day for a stored value: a timestamp is projected onto Israel time;
// a plain YYYY-MM-DD date is taken as-is. Used by chart bucketers so a row lands in the right day.
export const localDateKey = (value: string) => (value.includes('T') ? toTimeZoneISO(new Date(value)) : value.slice(0, 10));

function parseCalendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError('Invalid date: expected YYYY-MM-DD');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (year < 1 || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError('Invalid calendar date');
  }
  return { year, month, day };
}

export function addCalendarDays(value: string, days: number) {
  const { year, month, day } = parseCalendarDate(value);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function shiftCalendarMonth(month: string, delta: number) {
  const { start } = monthRange(month);
  const { year, month: monthNumber } = parseCalendarDate(start);
  const shifted = (year * 12 + monthNumber - 1) + delta;
  const shiftedYear = Math.floor(shifted / 12);
  const shiftedMonth = (shifted % 12 + 12) % 12 + 1;
  if (shiftedYear < 1) throw new RangeError('Calendar month is before year 0001');
  return `${String(shiftedYear).padStart(4, '0')}-${String(shiftedMonth).padStart(2, '0')}`;
}

export function daysInCalendarMonth(month: string) {
  return Number(addCalendarDays(monthRange(month).end, -1).slice(8, 10));
}

/** Sunday-start business week containing the supplied YYYY-MM-DD day. */
export function startOfCalendarWeek(value: string) {
  const { year, month, day } = parseCalendarDate(value);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addCalendarDays(value, -weekday);
}

export function monthRange(month: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match || Number(match[1]) < 1) throw new RangeError('Invalid month: expected YYYY-MM');
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  const start = `${String(year).padStart(4, '0')}-${String(monthNumber).padStart(2, '0')}-01`;
  const end = `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
  return { start, end };
}

/** UTC instants for local-midnight boundaries of a business calendar month. */
export function monthInstantRange(month: string, timeZone = BUSINESS_TIME_ZONE) {
  const { start, end } = monthRange(month);
  return { start: dateStartInstant(start, timeZone), end: dateStartInstant(end, timeZone) };
}

export function dateStartInstant(value: string, timeZone = BUSINESS_TIME_ZONE) {
  const { year, month, day } = parseCalendarDate(value);
  const target = Date.UTC(year, month - 1, day);
  let instant = target;
  // Two passes cover offset changes; Israel's DST transitions do not occur at midnight.
  for (let pass = 0; pass < 3; pass++) {
    const actual = datePartsInTimeZone(new Date(instant), timeZone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const correction = target - represented;
    instant += correction;
    if (correction === 0) break;
  }
  return new Date(instant).toISOString();
}

export type WeeklyBucket = { week: string; total: number; count: number };
export type MonthlyBucket = { key: string; total: number; count: number };

/**
 * N consecutive Sunday-start week buckets ending with the week containing `todayISO`. Each bucket keeps
 * a `count` so an empty week reads as a real gap, never a fabricated 0 (CLAUDE.md). Value label is left
 * to the caller. Powers the dashboards' weekly trend charts.
 */
export function weeklyBuckets(
  rows: readonly { date: string; value: number }[],
  { todayISO: today, weeks = 8 }: { todayISO: string; weeks?: number },
): WeeklyBucket[] {
  const currentWeekStart = startOfCalendarWeek(today);
  const buckets = Array.from({ length: weeks }, (_, idx) => {
    const key = addCalendarDays(currentWeekStart, -(weeks - 1 - idx) * 7);
    return { key, week: `${key.slice(8, 10)}/${key.slice(5, 7)}`, total: 0, count: 0 };
  });
  const byWeek = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const row of rows) {
    const bucket = byWeek.get(startOfCalendarWeek(localDateKey(row.date)));
    if (!bucket) continue;
    bucket.total += row.value;
    bucket.count += 1;
  }
  return buckets.map(({ week, total, count }) => ({ week, total, count }));
}

/**
 * N consecutive calendar-month buckets ending with `monthKey` (YYYY-MM), oldest→newest. Empty months
 * stay as `count: 0` so the axis is continuous; an entirely empty source stays empty.
 */
export function monthlyBuckets(
  rows: readonly { date: string; value: number }[],
  { monthKey, months }: { monthKey: string; months: number },
): MonthlyBucket[] {
  const byMonth = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const m = localDateKey(row.date).slice(0, 7);
    const bucket = byMonth.get(m) ?? { total: 0, count: 0 };
    bucket.total += row.value;
    bucket.count += 1;
    byMonth.set(m, bucket);
  }
  return Array.from({ length: months }, (_, idx) => {
    const key = shiftCalendarMonth(monthKey, -(months - 1 - idx));
    const bucket = byMonth.get(key) ?? { total: 0, count: 0 };
    return { key, total: bucket.total, count: bucket.count };
  });
}

export const DAY_NAMES = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
export const fmtDays = (days: number[] | null | undefined) =>
  days && days.length ? days.map((d) => DAY_NAMES[d]).join(', ') : '—';
