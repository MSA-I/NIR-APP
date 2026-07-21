const ils = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 2, minimumFractionDigits: 0 });
const ilsExact = new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', minimumFractionDigits: 2 });
const num = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const monthFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });

export const fmtMoney = (v: number | null | undefined) => (v == null ? '—' : ils.format(v));
export const fmtMoneyExact = (v: number | null | undefined) => (v == null ? '—' : ilsExact.format(v));
export const fmtNum = (v: number | null | undefined) => (v == null ? '—' : num.format(v));
export const fmtDate = (v: string | Date | null | undefined) => (v ? dateFmt.format(new Date(v)) : '—');
export const fmtDateTime = (v: string | Date | null | undefined) => (v ? dateTimeFmt.format(new Date(v)) : '—');
export const fmtMonth = (v: string | Date) => monthFmt.format(new Date(v));

// Local calendar day, NOT UTC. The app runs in one timezone (Israel), so "today" — whether
// stamped on a new record or compared against a due_date — must be the local day. toISOString()
// is UTC and rolls the date back in the hours after local midnight (docs/nir/01-03 §2.7).
export const toLocalISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const todayISO = () => toLocalISO(new Date());

export function monthRange(month: string /* YYYY-MM */) {
  const start = `${month}-01`;
  const d = new Date(`${month}-01T00:00:00`);
  d.setMonth(d.getMonth() + 1);
  const end = d.toISOString().slice(0, 10);
  return { start, end };
}

export const DAY_NAMES = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
export const fmtDays = (days: number[] | null | undefined) =>
  days && days.length ? days.map((d) => DAY_NAMES[d]).join(', ') : '—';
