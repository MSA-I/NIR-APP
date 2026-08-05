import { http, HttpResponse, type JsonBodyType } from 'msw';

/**
 * Shared scenarios for development and for tests.
 *
 * The base URL is whatever `VITE_SUPABASE_URL` is set to in the test environment; `src/lib/supabase.ts`
 * throws at module load if it is missing, so tests that import the client must run with it defined.
 */
export const SUPABASE_URL = 'http://127.0.0.1:55431';

/** PostgREST returns a bare array for a table select. */
export const rest = (table: string, rows: JsonBodyType[], init?: ResponseInit) =>
  http.get(`${SUPABASE_URL}/rest/v1/${table}`, () => HttpResponse.json(rows, init));

/** A PostgREST error carries `message`/`code`; `toHebrewError` matches on the message. */
export const restError = (table: string, status: number, message: string, code?: string) =>
  http.get(`${SUPABASE_URL}/rest/v1/${table}`, () =>
    HttpResponse.json({ message, code: code ?? null, details: null, hint: null }, { status }));

/** An RPC call. Supabase posts to /rest/v1/rpc/<name>. */
export const rpc = (name: string, body: JsonBodyType, init?: ResponseInit) =>
  http.post(`${SUPABASE_URL}/rest/v1/rpc/${name}`, () => HttpResponse.json(body, init));

/**
 * Deliberately empty by default.
 *
 * Every test declares the traffic it expects with `server.use(...)`. A shared default set would
 * make a passing test depend on a fixture written for some other test, which is exactly how a
 * suite stops describing the system.
 */
export const handlers = [];
