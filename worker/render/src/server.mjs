import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  parseRenderRequest,
  RENDER_CONTRACT_HEADER,
  RENDER_CONTRACT_VERSION,
} from './contract.mjs';
import { closeBrowser, renderDocument } from './render.mjs';

/**
 * The render service.
 *
 * It has exactly one caller — `supabase/functions/render-document` — and one job: turn an
 * application path into a PDF the caller could not have produced for themselves. It is deployed
 * beside the OCR worker and follows the same two rules that service learned the hard way: a
 * versioned contract checked on every request, and a shared secret that is compared in constant
 * time rather than with `===`.
 */

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.RENDER_SERVICE_TOKEN ?? '';
const APP_URL = process.env.RENDER_APP_URL ?? '';
const MARK_PATH = process.env.RENDER_MARK_PATH
  ?? join(process.cwd(), 'assets', 'inplace-lockup.png');
const MAX_BODY_BYTES = 64 * 1024;

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

/** Constant time, and length-safe: `timingSafeEqual` throws on a length mismatch. */
function tokenMatches(presented) {
  if (TOKEN.length === 0 || presented.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(TOKEN));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('render_body_too_large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    // Deliberately says the contract version. `Up` is not evidence a worker is compatible — that
    // is the lesson of the five silent days in the OCR gateway.
    return json(response, 200, { ok: true, contract: RENDER_CONTRACT_VERSION });
  }
  if (request.method !== 'POST' || request.url !== '/render') {
    return json(response, 404, { error: 'not_found' });
  }
  if (TOKEN.length === 0 || APP_URL.length === 0) {
    return json(response, 503, { error: 'render_service_misconfigured' });
  }

  const presented = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!tokenMatches(presented)) return json(response, 401, { error: 'render_unauthorized' });

  const presentedContract = request.headers[RENDER_CONTRACT_HEADER];
  if (presentedContract !== RENDER_CONTRACT_VERSION) {
    return json(response, 409, {
      error: 'render_contract_mismatch',
      expected: RENDER_CONTRACT_VERSION,
      received: presentedContract ?? null,
    });
  }

  let parsed;
  try {
    parsed = parseRenderRequest(await readBody(request));
  } catch {
    return json(response, 400, { error: 'render_bad_request' });
  }
  if (!parsed.ok) return json(response, 400, { error: parsed.error });

  const started = Date.now();
  try {
    const pdf = await renderDocument({ ...parsed.request, appUrl: APP_URL, markPath: MARK_PATH });
    response.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': String(pdf.byteLength),
      [RENDER_CONTRACT_HEADER]: RENDER_CONTRACT_VERSION,
      'x-render-duration-ms': String(Date.now() - started),
    });
    response.end(pdf);
  } catch (error) {
    // The path is not echoed back: it names a tenant's invoice or order.
    console.error('[render] failed', error instanceof Error ? error.message : error);
    json(response, 502, { error: 'render_failed' });
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => { void closeBrowser().finally(() => process.exit(0)); });
  });
}

server.listen(PORT, () => console.log(`[render] listening on ${PORT}, contract ${RENDER_CONTRACT_VERSION}`));
