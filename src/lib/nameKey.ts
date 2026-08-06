/**
 * The app's one answer to "are these two hand-typed names the same name?".
 *
 * It lived in `importSheet.ts` and is re-exported from there, so every existing call site is
 * unchanged. It moved here because `importSheet` statically imports `xlsx` (~490 kB) and
 * `papaparse`: any screen that wanted this one-line comparison would have pulled the whole
 * spreadsheet parser in with it. Matching two names is not a spreadsheet concern.
 */

/** Key for matching names typed by hand across a spreadsheet and the database. */
export const nameKey = (s: string) => s.replace(/["'״׳]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
