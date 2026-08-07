const assert = require('node:assert/strict');
const { createClient } = require('@supabase/supabase-js');

for (const name of [
  'OCR_ACCEPTANCE_API_URL',
  'OCR_ACCEPTANCE_ANON_KEY',
  'OCR_ACCEPTANCE_SERVICE_ROLE_KEY',
  'OCR_ACCEPTANCE_PASSWORD_SEED',
]) {
  if (!process.env[name]) throw new Error(`Missing OCR browser fixture environment: ${name}`);
}

const apiUrl = process.env.OCR_ACCEPTANCE_API_URL.replace(/\/+$/, '');
if (apiUrl !== 'http://127.0.0.1:55431') throw new Error(`Refusing non-local Supabase URL: ${apiUrl}`);

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SUPPLIER_ID = 'aa000000-0000-4000-8000-000000000008';
const documents = [
  ['97000000-0000-4000-8000-000000000001', 'ocr-01-unprocessed.png'],
  ['97000000-0000-4000-8000-000000000002', 'ocr-02-queued.png'],
  ['97000000-0000-4000-8000-000000000003', 'ocr-03-processing.png'],
  ['97000000-0000-4000-8000-000000000004', 'ocr-04-review.png'],
  ['97000000-0000-4000-8000-000000000005', 'ocr-05-completed.png'],
  ['97000000-0000-4000-8000-000000000006', 'ocr-06-failed.png'],
  ['97000000-0000-4000-8000-000000000007', 'ocr-07-price-list.png', `${ORG_ID}/supplier/${SUPPLIER_ID}/97000000-0000-4000-8000-000000000007/ocr-07-price-list.png`],
].map(([id, fileName, canonicalPath]) => ({
  id,
  fileName,
  storagePath: canonicalPath ?? `${ORG_ID}/ocr-acceptance/${id}/${fileName}`,
}));

const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const service = createClient(apiUrl, process.env.OCR_ACCEPTANCE_SERVICE_ROLE_KEY, options);
const owner = createClient(apiUrl, process.env.OCR_ACCEPTANCE_ANON_KEY, options);

function ok(label, result) {
  assert.equal(result.error, null, `${label}: ${result.error?.message ?? 'unknown error'}`);
  return result.data;
}

async function cleanup() {
  ok('remove OCR browser Storage fixtures', await service.storage.from('documents')
    .remove(documents.map(({ storagePath }) => storagePath)));
  for (const document of documents) {
    const separator = document.storagePath.lastIndexOf('/');
    const folder = document.storagePath.slice(0, separator);
    const listed = ok(`verify removal of ${document.fileName}`, await service.storage.from('documents')
      .list(folder, { limit: 100, search: document.fileName }));
    assert.equal(listed.some(({ name }) => name === document.fileName), false,
      `${document.fileName} still exists after Storage cleanup`);
  }
}

async function prepare() {
  const signedIn = await owner.auth.signInWithPassword({
    email: 'owner@demo.supplyflow.local',
    password: `P4!${process.env.OCR_ACCEPTANCE_PASSWORD_SEED}-owner-Aa7`,
  });
  assert.equal(signedIn.error, null, `sign in demo owner: ${signedIn.error?.message ?? 'unknown error'}`);
  const ownerId = signedIn.data.user?.id;
  assert.ok(ownerId, 'demo owner sign in returned no user id');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  for (const document of documents) {
    ok(`upload ${document.fileName}`, await owner.storage.from('documents').upload(
      document.storagePath,
      png,
      { contentType: 'image/png', cacheControl: '60', upsert: false },
    ));
  }

  ok('insert OCR browser documents', await service.from('documents').insert(documents.map((document) => {
    const isPriceList = document.id.endsWith('0007');
    return {
      id: document.id,
      org_id: ORG_ID,
      entity_type: isPriceList ? 'supplier' : 'inbox',
      entity_id: isPriceList ? SUPPLIER_ID : null,
      storage_path: document.storagePath,
      file_name: document.fileName,
      mime_type: 'image/png',
      document_kind: isPriceList
        ? 'price_list'
        : ['97000000-0000-4000-8000-000000000004', '97000000-0000-4000-8000-000000000005'].includes(document.id)
          ? 'invoice'
          : 'other',
      supplier_id: isPriceList || document.id.endsWith('0004') || document.id.endsWith('0005')
        ? SUPPLIER_ID
        : null,
      uploaded_by: ownerId,
    };
  })));

  const visible = ok('verify OCR documents through owner RLS', await owner.from('documents')
    .select('id').in('id', documents.map(({ id }) => id)));
  assert.equal(visible.length, documents.length, `owner sees ${visible.length}/${documents.length} OCR documents`);
  console.log('ocr_browser_storage_fixture_ready');
}

(async () => {
  const action = process.env.OCR_ACCEPTANCE_FIXTURE_ACTION ?? 'prepare';
  if (action === 'cleanup') {
    await cleanup();
    console.log('ocr_browser_storage_fixture_removed');
    return;
  }
  if (action !== 'prepare') throw new Error(`Unsupported OCR fixture action: ${action}`);
  try {
    await prepare();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      console.error(`OCR browser Storage cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw error;
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
