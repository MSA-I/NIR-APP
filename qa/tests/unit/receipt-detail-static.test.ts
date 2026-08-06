import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('receipt detail remains a select-only route with no mutation controls', async () => {
  const source = await readFile(path.join(process.cwd(), 'src', 'pages', 'ReceiptDetail.tsx'), 'utf8');
  assert.match(source, /from\('goods_receipts'\)[\s\S]*?\.select\(/);
  assert.match(source, /from\('goods_receipt_items'\)[\s\S]*?\.select\(/);
  assert.doesNotMatch(source, /\.rpc\(|\.insert\(|\.upsert\(|\.update\(|\.delete\(/);
  assert.doesNotMatch(source, /<button\b|<form\b|<input\b|<select\b|<textarea\b|onClick=/);
});
