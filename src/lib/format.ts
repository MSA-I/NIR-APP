export const BUSINESS_TIME_ZONE = 'Asia/Jerusalem';

const ils = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2, minimumFractionDigits: 0 });
const ilsExact = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 });
const num = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: BUSINESS_TIME_ZONE });
const dateTimeFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: BUSINESS_TIME_ZONE });
const monthFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: BUSINESS_TIME_ZONE });

export const fmtMoney = (v: number | null | undefined) => (v == null ? '—' : ils.format(v));
export const fmtMoneyExact = (v: number | null | undefined) => (v == null ? '—' : ilsExact.format(v));
export const fmtNum = (v: number | null | undefined) => (v == null ? '—' : num.format(v));
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
