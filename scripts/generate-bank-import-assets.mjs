import { mkdirSync, writeFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

const version = '1';
const sheetName = 'Bank Transactions';
const headers = ['transaction_date', 'description', 'direction', 'amount', 'reference'];

function workbook(rows) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['INPLACE_BANK_IMPORT', version],
    headers,
    ...rows,
  ], { cellDates: true });
  sheet['!cols'] = [{ wch: 18 }, { wch: 42 }, { wch: 12 }, { wch: 16 }, { wch: 24 }];
  const result = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(result, sheet, sheetName);
  result.Workbook = { Views: [{ RTL: true }] };
  return XLSX.write(result, { type: 'buffer', bookType: 'xlsx', cellDates: true });
}

mkdirSync('public/templates', { recursive: true });
mkdirSync('src/test/fixtures', { recursive: true });
writeFileSync('public/templates/inplace-bank-import-v1.xlsx', workbook([]));
writeFileSync('src/test/fixtures/bank-import-v1-fixture.xlsx', workbook([
  [new Date(Date.UTC(2026, 7, 21)), 'העברה לספק א', 'debit', 1250.5, 'REF-1'],
  [new Date(Date.UTC(2026, 7, 22)), 'העברה מספק ב', 'credit', 99, null],
]));
