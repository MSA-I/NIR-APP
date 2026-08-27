import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import { buildCatalog } from './catalog.mjs';
import {
  createInitialState,
  finalizeState,
  loadState,
  recordAnswer,
  recordDebtPriority,
  recordReconsideration,
  saveStateAtomic,
} from './state.mjs';

const BODY_LIMIT = 64 * 1024;
const LOOPBACK_HOST = '127.0.0.1';

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function sendText(response, status, body, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const error = new Error('body_too_large');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.code = 'invalid_json';
    throw error;
  }
}

function statusFor(error) {
  if (['unknown_item'].includes(error?.code)) return 404;
  if (['revision_conflict', 'source_changed', 'saved_state_source_changed', 'reconsideration_required', 'direct_answer_required', 'answers_missing'].includes(error?.code)) return 409;
  return 400;
}

function isAllowedHost(hostHeader, port) {
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

function isAllowedOrigin(origin, port) {
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

export function ownerDecisionInstanceId({ rootDir, resultsDir }) {
  return createHash('sha256').update(`${path.resolve(rootDir)}\0${path.resolve(resultsDir)}`, 'utf8').digest('hex').slice(0, 24);
}

export function createOwnerDecisionServer({
  rootDir,
  resultsDir,
  host = LOOPBACK_HOST,
  port = 43127,
  sourceCommit,
  catalogProvider,
}) {
  if (host !== LOOPBACK_HOST) throw new Error('loopback_only');
  let server;
  let activeCatalog;
  let activeState;
  let actualPort = port;
  let writeQueue = Promise.resolve();
  const publicDir = path.join(rootDir, 'tools', 'owner-decisions', 'public');
  const brandPath = path.join(rootDir, 'public', 'brand', 'inplace-symbol.svg');
  const instanceId = ownerDecisionInstanceId({ rootDir, resultsDir });

  const provideCatalog = catalogProvider || (() => buildCatalog({ rootDir, sourceCommit }));

  async function freshCatalog() {
    return provideCatalog();
  }

  async function ensureSourceUnchanged(key, sourceHash) {
    const current = await freshCatalog();
    const currentItem = current.items.find((item) => item.key === key);
    if (!currentItem || currentItem.sourceHash !== sourceHash || current.sourceCommit !== activeCatalog.sourceCommit) {
      const error = new Error('source_changed');
      error.code = 'source_changed';
      throw error;
    }
  }

  async function mutateState(operation) {
    const result = writeQueue.then(async () => {
      const next = await operation(activeState);
      await saveStateAtomic(resultsDir, next, activeCatalog);
      activeState = next;
      return next;
    });
    writeQueue = result.catch(() => {});
    return result;
  }

  async function serveStatic(pathname, response) {
    let filePath;
    if (pathname === '/') filePath = path.join(publicDir, 'index.html');
    else if (pathname === '/app.js') filePath = path.join(publicDir, 'app.js');
    else if (pathname === '/ui-model.mjs') filePath = path.join(publicDir, 'ui-model.mjs');
    else if (pathname === '/styles.css') filePath = path.join(publicDir, 'styles.css');
    else if (pathname === '/brand.svg') filePath = brandPath;
    else if (pathname === '/font.woff2') filePath = path.join(rootDir, 'public', 'fonts', 'noto', 'NotoSansHebrew-Hebrew.woff2');
    else return false;
    const body = await readFile(filePath);
    sendText(response, 200, body, CONTENT_TYPES.get(path.extname(filePath)) || 'application/octet-stream');
    return true;
  }

  async function handler(request, response) {
    if (!isAllowedHost(request.headers.host, actualPort)) {
      sendJson(response, 403, { error: 'loopback_host_required' });
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, actualPort)) {
      sendJson(response, 403, { error: 'same_origin_required' });
      return;
    }
    const url = new URL(request.url || '/', `http://${request.headers.host}`);
    try {
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, sourceCommit: activeCatalog.sourceCommit, sourceFiles: activeCatalog.sourceFiles, instanceId, status: activeState.status });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/catalog') {
        sendJson(response, 200, activeCatalog);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        sendJson(response, 200, activeState);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/answer') {
        const payload = await readJson(request);
        await ensureSourceUnchanged(payload.key, payload.sourceHash);
        const next = await mutateState((state) => recordAnswer(state, activeCatalog, payload));
        sendJson(response, 200, next);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/reconsideration') {
        const payload = await readJson(request);
        await ensureSourceUnchanged(payload.key, payload.sourceHash);
        const next = await mutateState((state) => recordReconsideration(state, activeCatalog, payload));
        sendJson(response, 200, next);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/debt-priority') {
        const payload = await readJson(request);
        await ensureSourceUnchanged(payload.key, payload.sourceHash);
        const next = await mutateState((state) => recordDebtPriority(state, activeCatalog, payload));
        sendJson(response, 200, next);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/finalize') {
        const payload = await readJson(request);
        const current = await freshCatalog();
        if (current.sourceCommit !== activeCatalog.sourceCommit || current.sourceFiles.decisions !== activeCatalog.sourceFiles.decisions || current.sourceFiles.debts !== activeCatalog.sourceFiles.debts) {
          const error = new Error('source_changed');
          error.code = 'source_changed';
          throw error;
        }
        const next = await mutateState((state) => finalizeState(state, activeCatalog, payload));
        sendJson(response, 200, next);
        return;
      }
      if (request.method === 'GET' && await serveStatic(url.pathname, response)) return;
      sendJson(response, 404, { error: 'not_found' });
    } catch (error) {
      sendJson(response, statusFor(error), { error: error?.code || 'request_failed', missing: error?.missing || undefined });
    }
  }

  return {
    async start() {
      activeCatalog = await freshCatalog();
      try {
        activeState = await loadState(resultsDir, activeCatalog);
      } catch (error) {
        if (error?.code !== 'saved_state_source_changed') throw error;
        throw error;
      }
      if (!activeState) activeState = createInitialState(activeCatalog);
      await saveStateAtomic(resultsDir, activeState, activeCatalog);
      server = http.createServer((request, response) => void handler(request, response));
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      actualPort = server.address().port;
      const url = `http://${host}:${actualPort}/`;
      return { url, port: actualPort, catalog: activeCatalog, state: activeState };
    },
    async close() {
      if (!server) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    },
  };
}
