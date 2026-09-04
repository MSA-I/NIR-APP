import { mkdirSync, writeFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

const version = '1';
const sheetName = 'Bank Transactions';
const guideSheetName = 'הנחיות למילוי';
const headers = ['transaction_date', 'description', 'direction', 'amount', 'reference'];

/**
 * These values are declared a second time here because this script is plain Node and the module
 * that owns them is TypeScript. The copy is not left to trust: `bankImportWorkbook.spec.ts` reads
 * the file this script writes and pins it against `BANK_IMPORT_EXAMPLE_ROW` and the guide rows in
 * `src/lib/bankImportWorkbook.ts`, so a change on one side and not the other goes red.
 */
const example = {
  transaction_date: new Date(Date.UTC(2026, 0, 15)),
  description: 'שורת דוגמה — יש להחליף בנתוני התדפיס שלכם',
  direction: 'debit',
  amount: 1250.5,
  reference: 'REF-0001',
};

const guideRows = [
  ['ייבוא תדפיס בנק — הנחיות למילוי'],
  [`יש למלא את גיליון „${sheetName}". אין לשנות בו את שתי השורות הראשונות.`],
  ['שורה 3 בגיליון הנתונים היא שורת דוגמה. יש להחליף אותה בנתונים שלכם או למחוק אותה — קובץ שנשלח והדוגמה עדיין בתוכו נדחה.'],
  [],
  ['עמודה בקובץ', 'מה למלא', 'ערכים מותרים ופורמט', 'דוגמה'],
  ['transaction_date', 'תאריך התנועה', 'תא בפורמט תאריך — לא טקסט', '15.01.2026'],
  ['description', 'תיאור התנועה כפי שמופיע בתדפיס', 'טקסט חופשי, שדה חובה', example.description],
  ['direction', 'כיוון התנועה', 'debit לחיוב, credit לזיכוי — באנגלית ובאותיות קטנות', example.direction],
  ['amount', 'סכום התנועה', 'מספר חיובי, עד שתי ספרות אחרי הנקודה', '1250.50'],
  ['reference', 'אסמכתה', 'טקסט, אפשר להשאיר ריק', example.reference],
  [],
  ['אין עמודת מטבע: כל תדפיס נקלט כמטבע אחד, ILS. אין לערבב מטבעות בקובץ אחד.'],
];

function workbook(rows, { withGuide = false } = {}) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['INPLACE_BANK_IMPORT', version],
    headers,
    ...rows,
  ], { cellDates: true });
  sheet['!cols'] = [{ wch: 18 }, { wch: 42 }, { wch: 12 }, { wch: 16 }, { wch: 24 }];
  const result = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(result, sheet, sheetName);
  if (withGuide) {
    const guide = XLSX.utils.aoa_to_sheet(guideRows);
    guide['!cols'] = [{ wch: 22 }, { wch: 38 }, { wch: 46 }, { wch: 34 }];
    XLSX.utils.book_append_sheet(result, guide, guideSheetName);
  }
  result.Workbook = { Views: withGuide ? [{ RTL: true }, { RTL: true }] : [{ RTL: true }] };
  return XLSX.write(result, { type: 'buffer', bookType: 'xlsx', cellDates: true });
}

mkdirSync('public/templates', { recursive: true });
mkdirSync('src/test/fixtures', { recursive: true });
// The downloadable template: the Hebrew guide a bookkeeper reads, and one worked example row in
// the place the data goes. The parser refuses the file while that row is still in it, so the
// example can teach the format without a specimen transaction reaching a bank ledger (`EXP-09`).
writeFileSync('public/templates/inplace-bank-import-v1.xlsx', workbook([
  [example.transaction_date, example.description, example.direction, example.amount, example.reference],
], { withGuide: true }));
// The fixture is a FILLED workbook — what a bookkeeper sends back — so it carries neither the
// guide sheet nor the example row.
writeFileSync('src/test/fixtures/bank-import-v1-fixture.xlsx', workbook([
  [new Date(Date.UTC(2026, 7, 21)), 'העברה לספק א', 'debit', 1250.5, 'REF-1'],
  [new Date(Date.UTC(2026, 7, 22)), 'העברה מספק ב', 'credit', 99, null],
]));
