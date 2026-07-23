const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');

function localEnvironment() {
  const environment = {
    API_URL: process.env.P1B_API_URL,
    ANON_KEY: process.env.P1B_ANON_KEY,
    SERVICE_ROLE_KEY: process.env.P1B_SERVICE_ROLE_KEY,
  };
  assert.ok(
    environment.API_URL && environment.ANON_KEY && environment.SERVICE_ROLE_KEY,
    'P1B local Edge environment is incomplete',
  );
  return environment;
}

async function mustInsert(query, label) {
  const { error } = await query;
  assert.equal(error, null, `${label}: ${error?.message ?? 'unknown error'}`);
}

async function exactCount(query, label) {
  const { count, error } = await query;
  assert.equal(error, null, `${label}: ${error?.message ?? 'unknown error'}`);
  assert.notEqual(count, null, `${label}: missing count`);
  return count;
}

async function upload(client, path, bytes, contentType) {
  const { error } = await client.storage.from('price-submissions').upload(path, bytes, {
    contentType,
    upsert: false,
  });
  assert.equal(error, null, `upload ${path}: ${error?.message ?? 'unknown error'}`);
}

async function invoke(apiUrl, anonKey, accessToken, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${apiUrl}/functions/v1/submit-price-list`, {
      method: 'POST',
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    const transientWorkerRestart = response.status === 502
      && payload?.message === 'An invalid response was received from the upstream server';
    if (!transientWorkerRestart || attempt === 2) return { response, payload };
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error('unreachable Edge retry state');
}

function csvFor(productIds, price) {
  return Buffer.from([
    'product_id,price,available',
    ...productIds.map((productId) => `${productId},${price},true`),
    '',
  ].join('\n'), 'utf8');
}

async function main() {
  const env = localEnvironment();
  const apiUrl = env.API_URL;
  const anonKey = env.ANON_KEY;
  const serviceKey = env.SERVICE_ROLE_KEY;

  const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false } });
  const userClient = createClient(apiUrl, anonKey, { auth: { persistSession: false } });
  const orgId = crypto.randomUUID();
  const supplierId = crypto.randomUUID();
  const competitorId = crypto.randomUUID();
  const productIds = Array.from({ length: 1000 }, () => crypto.randomUUID());
  const supplierProductIds = Array.from({ length: 1000 }, () => crypto.randomUUID());
  const email = `p1b-edge-${crypto.randomUUID()}@example.test`;
  const password = `P1b-${crypto.randomBytes(18).toString('base64url')}!9a`;

  await mustInsert(admin.from('organizations').insert({ id: orgId, name: 'P1B Edge tenant', status: 'active' }), 'organization');
  await mustInsert(admin.from('suppliers').insert([
    { id: supplierId, org_id: orgId, name: 'P1B Edge supplier' },
    { id: competitorId, org_id: orgId, name: 'P1B competitor supplier' },
  ]), 'suppliers');
  await mustInsert(admin.from('products').insert(productIds.map((id, index) => ({
    id,
    org_id: orgId,
    name: `P1B canonical product ${index + 1}`,
    unit: 'unit',
  }))), 'products');

  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.equal(created.error, null, `create auth user: ${created.error?.message ?? 'unknown error'}`);
  const userId = created.data.user.id;
  await mustInsert(admin.from('profiles').insert({
    id: userId,
    org_id: orgId,
    full_name: 'P1B Edge supplier',
    role: 'supplier',
    supplier_id: supplierId,
    active: true,
  }), 'profile');
  await mustInsert(admin.from('supplier_products').insert(productIds.map((productId, index) => ({
    id: supplierProductIds[index],
    org_id: orgId,
    supplier_id: supplierId,
    product_id: productId,
    current_price: 10,
    price_effective_date: '2026-06-01',
    available: true,
  }))), 'supplier products');
  await mustInsert(admin.from('price_history').insert({
    org_id: orgId,
    supplier_product_id: supplierProductIds[0],
    price: 10,
    effective_date: '2026-06-01',
  }), 'initial price history');

  const signedIn = await userClient.auth.signInWithPassword({ email, password });
  assert.equal(signedIn.error, null, `sign in: ${signedIn.error?.message ?? 'unknown error'}`);
  const accessToken = signedIn.data.session.access_token;

  const submissionId = crypto.randomUUID();
  const fileName = 'monthly-prices-10.csv';
  const csv = csvFor([...productIds.slice(0, 9), crypto.randomUUID()], '12.34');
  const storagePath = `${orgId}/price-submissions/${supplierId}/${submissionId}/${fileName}`;
  await upload(userClient, storagePath, csv, 'text/csv');

  const first = await invoke(apiUrl, anonKey, accessToken, {
    submissionId,
    supplierId,
    targetMonth: '2026-07-01',
    fileName,
    storagePath,
    reason: 'P1B Edge runtime acceptance',
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.status, 'accepted_with_rejections');
  assert.equal(first.payload.accepted_count, 9);
  assert.equal(first.payload.rejected_count, 1);
  assert.equal(first.payload.idempotent, false);

  const expectedChecksum = crypto.createHash('sha256').update(csv).digest('hex');
  const receipt = await admin.from('supplier_price_submissions').select('*').eq('id', submissionId).single();
  assert.equal(receipt.error, null, `receipt lookup: ${receipt.error?.message ?? 'unknown error'}`);
  assert.equal(receipt.data.file_checksum, expectedChecksum);
  assert.equal(receipt.data.revision, 1);

  const current = await admin.from('supplier_products').select('current_price').eq('id', supplierProductIds[0]).single();
  assert.equal(current.error, null);
  assert.equal(Number(current.data.current_price), 12.34);
  const history = await admin.from('price_history').select('id', { count: 'exact', head: true }).eq('supplier_product_id', supplierProductIds[0]);
  assert.equal(history.error, null);
  assert.equal(history.count, 2);
  const catalog = await admin.from('products').select('id', { count: 'exact', head: true }).eq('org_id', orgId);
  assert.equal(catalog.error, null);
  assert.equal(catalog.count, 1000, 'unknown upload row created a catalog product');
  const audit = await admin.from('audit_logs').select('reason').eq('entity_id', submissionId).eq('action', 'supplier_price_submission_processed').single();
  assert.equal(audit.error, null, `audit lookup: ${audit.error?.message ?? 'unknown error'}`);
  assert.equal(audit.data.reason, 'P1B Edge runtime acceptance');

  const oldBypass = await userClient.rpc('submit_supplier_price_list', {
    p_submission_id: crypto.randomUUID(),
    p_supplier_id: supplierId,
    p_target_month: '2026-07-01',
    p_file_name: 'forged.csv',
    p_storage_path: `${orgId}/price-submissions/${supplierId}/${crypto.randomUUID()}/forged.csv`,
    p_file_checksum: 'a'.repeat(64),
    p_rows: [{ product_id: productIds[0], price_text: '1' }],
    p_reason: 'forged browser payload',
  });
  assert.ok(oldBypass.error, 'legacy eight-argument browser RPC remained callable');
  const internalBypass = await userClient.rpc('p1b_submit_supplier_price_list_internal', {
    p_submission_id: crypto.randomUUID(),
    p_supplier_id: supplierId,
    p_target_month: '2026-07-01',
    p_file_name: 'internal-bypass.csv',
    p_storage_path: `${orgId}/price-submissions/${supplierId}/${crypto.randomUUID()}/internal-bypass.csv`,
    p_file_checksum: 'b'.repeat(64),
    p_rows: [],
    p_reason: 'browser internal command attempt',
  });
  assert.ok(internalBypass.error, 'browser reached the internal price-list command');
  const intakeBypass = await userClient.rpc('claim_supplier_price_intake', {
    p_intake_id: crypto.randomUUID(),
    p_actor_id: userId,
    p_supplier_id: supplierId,
    p_submission_id: crypto.randomUUID(),
    p_target_month: '2026-07-01',
    p_file_name: 'intake-bypass.csv',
    p_storage_path: `${orgId}/price-submissions/${supplierId}/${crypto.randomUUID()}/intake-bypass.csv`,
    p_reason: 'browser intake command attempt',
  });
  assert.ok(intakeBypass.error, 'browser reached the service-only intake command');
  const noIntake = await userClient.rpc('submit_supplier_price_list', { p_intake_id: crypto.randomUUID() });
  assert.ok(noIntake.error, 'one-argument RPC accepted an untrusted intake id');

  await userClient.storage.from('price-submissions').remove([storagePath]);
  const registeredStillPresent = await admin.storage.from('price-submissions').download(storagePath);
  assert.equal(registeredStillPresent.error, null, 'registered immutable file was deleted by its uploader');

  const retryId = crypto.randomUUID();
  const retryPath = `${orgId}/price-submissions/${supplierId}/${retryId}/${fileName}`;
  await upload(userClient, retryPath, csv, 'text/csv');
  const retry = await invoke(apiUrl, anonKey, accessToken, {
    submissionId: retryId,
    supplierId,
    targetMonth: '2026-07-01',
    fileName,
    storagePath: retryPath,
    reason: 'P1B Edge retry',
  });
  assert.equal(retry.response.status, 200, JSON.stringify(retry.payload));
  assert.equal(retry.payload.submission_id, submissionId);
  assert.equal(retry.payload.idempotent, true);
  await userClient.storage.from('price-submissions').remove([retryPath]);
  const retryGone = await admin.storage.from('price-submissions').download(retryPath);
  assert.ok(retryGone.error, 'retry orphan was not removable after intake consumption');

  const resultsByInputSize = {
    10: { accepted: first.payload.accepted_count, rejected: first.payload.rejected_count },
  };
  for (const [rowCount, targetMonth, price] of [
    [100, '2026-08-01', '13.34'],
    [1000, '2026-09-01', '14.34'],
  ]) {
    const scaleSubmissionId = crypto.randomUUID();
    const scaleFileName = `monthly-prices-${rowCount}.csv`;
    const scaleCsv = csvFor(productIds.slice(0, rowCount), price);
    const scalePath = `${orgId}/price-submissions/${supplierId}/${scaleSubmissionId}/${scaleFileName}`;
    await upload(userClient, scalePath, scaleCsv, 'text/csv');
    const scale = await invoke(apiUrl, anonKey, accessToken, {
      submissionId: scaleSubmissionId,
      supplierId,
      targetMonth,
      fileName: scaleFileName,
      storagePath: scalePath,
      reason: `P1B Edge ${rowCount}-row acceptance`,
    });
    assert.equal(scale.response.status, 200, JSON.stringify(scale.payload));
    assert.equal(scale.payload.status, 'accepted');
    assert.equal(scale.payload.accepted_count, rowCount);
    assert.equal(scale.payload.rejected_count, 0);
    resultsByInputSize[rowCount] = {
      accepted: scale.payload.accepted_count,
      rejected: scale.payload.rejected_count,
    };
  }

  const competitorSubmission = crypto.randomUUID();
  const competitorPath = `${orgId}/price-submissions/${competitorId}/${competitorSubmission}/competitor.csv`;
  const competitorUpload = await userClient.storage.from('price-submissions').upload(competitorPath, csv, {
    contentType: 'text/csv',
    upsert: false,
  });
  assert.ok(competitorUpload.error, 'supplier uploaded into a competitor path');

  const submissionsBeforeFailure = await exactCount(
    admin.from('supplier_price_submissions').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
    'submission count before damaged workbook',
  );
  const historyBeforeFailure = await exactCount(
    admin.from('price_history').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
    'history count before damaged workbook',
  );
  const damagedId = crypto.randomUUID();
  const damagedName = 'damaged.xlsx';
  const damagedPath = `${orgId}/price-submissions/${supplierId}/${damagedId}/${damagedName}`;
  await upload(userClient, damagedPath, Buffer.from('not-an-xlsx', 'utf8'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const damaged = await invoke(apiUrl, anonKey, accessToken, {
    submissionId: damagedId,
    supplierId,
    targetMonth: '2026-10-01',
    fileName: damagedName,
    storagePath: damagedPath,
    reason: 'P1B damaged workbook test',
  });
  assert.equal(damaged.response.status, 400, JSON.stringify(damaged.payload));
  assert.equal(damaged.payload.error.code, 'damaged_spreadsheet');
  assert.equal(await exactCount(
    admin.from('supplier_price_submissions').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
    'submission count after damaged workbook',
  ), submissionsBeforeFailure, 'damaged workbook left a partial receipt');
  assert.equal(await exactCount(
    admin.from('price_history').select('id', { count: 'exact', head: true }).eq('org_id', orgId),
    'history count after damaged workbook',
  ), historyBeforeFailure, 'damaged workbook left a partial price update');
  await userClient.storage.from('price-submissions').remove([damagedPath]);
  const damagedGone = await admin.storage.from('price-submissions').download(damagedPath);
  assert.ok(damagedGone.error, 'damaged workbook orphan was not removable after failed intake');

  process.stdout.write(JSON.stringify({
    result: 'p1b_edge_smoke_passed',
    input_sizes: resultsByInputSize,
    retry_idempotent: retry.payload.idempotent,
    checksum_matches_bytes: receipt.data.file_checksum === expectedChecksum,
    competitor_upload_blocked: Boolean(competitorUpload.error),
    damaged_workbook_blocked: damaged.payload.error.code === 'damaged_spreadsheet',
    damaged_workbook_atomic: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
