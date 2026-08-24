import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.91.1';
import { parseProductNameRepairSource, sha256Hex } from './core.ts';

const BUCKET = 'price-submissions';
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'content-type': 'application/json' },
});

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return json(401, { error: 'not_authorized' });
  let body: { submissionId?: string; targetProductIds?: string[] };
  try { body = await request.json(); } catch { return json(400, { error: 'request_invalid' }); }
  if (!body.submissionId || !Array.isArray(body.targetProductIds)
      || body.targetProductIds.length < 1 || body.targetProductIds.length > 500
      || new Set(body.targetProductIds).size !== body.targetProductIds.length) {
    return json(400, { error: 'request_invalid' });
  }

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !anon || !service) return json(503, { error: 'service_unavailable' });
  const caller = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const user = await caller.auth.getUser();
  if (user.error || !user.data.user) return json(401, { error: 'not_authorized' });

  const source = await caller.from('supplier_price_submissions')
    .select('id, org_id, file_name, storage_path, file_checksum')
    .eq('id', body.submissionId).single();
  if (source.error || !source.data) return json(404, { error: 'source_unknown' });
  const submission = source.data as {
    id: string; org_id: string; file_name: string; storage_path: string; file_checksum: string;
  };
  if (!submission.storage_path.startsWith(`${submission.org_id}/price-submissions/`)
      || !/^[0-9a-f]{64}$/.test(submission.file_checksum)) {
    return json(409, { error: 'source_contract_invalid' });
  }

  const downloaded = await admin.storage.from(BUCKET).download(submission.storage_path);
  if (downloaded.error || !downloaded.data) return json(404, { error: 'source_missing' });
  if (!downloaded.data.size || downloaded.data.size > 10 * 1024 * 1024) {
    return json(400, { error: 'source_size_invalid' });
  }
  const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
  const checksum = await sha256Hex(bytes);
  if (checksum !== submission.file_checksum) return json(409, { error: 'source_checksum_changed' });

  let rows;
  try { rows = parseProductNameRepairSource(bytes, submission.file_name); }
  catch (error) { return json(400, { error: error instanceof Error ? error.message : 'source_parse_invalid' }); }
  const prepared = await admin.rpc('prepare_product_name_repair_dry_run', {
    p_source_submission_id: submission.id,
    p_requester_id: user.data.user.id,
    p_source_checksum: checksum,
    p_target_product_ids: body.targetProductIds,
    p_rows: rows,
  });
  if (prepared.error) return json(409, { error: prepared.error.message });
  return json(200, { run_id: prepared.data, source_checksum: checksum, parsed_row_count: rows.length });
});
