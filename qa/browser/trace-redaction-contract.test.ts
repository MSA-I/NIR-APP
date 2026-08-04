import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { unzipSync, zipSync } from 'fflate';
import { scrubTraceZip } from '../reporting/scrub-traces.ts';
import { scrubPlaywrightTraces } from '../runner/scrub-artifacts.ts';

const SYNTHETIC_ACCESS_MARKER = 'QA_SYNTHETIC_ACCESS_MARKER_8f2a1d';
const SYNTHETIC_REFRESH_MARKER = 'QA_SYNTHETIC_REFRESH_MARKER_4c7b9e';
const SYNTHETIC_COOKIE_MARKER = 'QA_SYNTHETIC_COOKIE_MARKER_3d6f0a';
const SYNTHETIC_HEADER_COOKIE_MARKER = 'QA_SYNTHETIC_HEADER_COOKIE_MARKER_7a4d1c';
const SYNTHETIC_BINARY_MARKER = 'QA_SYNTHETIC_BINARY_MARKER_5e8c2b';

function syntheticContextOptionsEvent(): string {
  const localStorageValue = JSON.stringify({
    access_token: SYNTHETIC_ACCESS_MARKER,
    refresh_token: SYNTHETIC_REFRESH_MARKER,
    token_type: 'bearer',
  });
  return JSON.stringify({
    type: 'context-options',
    version: 8,
    browserName: 'chromium',
    options: {
      locale: 'he-IL',
      timezoneId: 'Asia/Jerusalem',
      storageState: {
        cookies: [{
          name: 'synthetic-session',
          value: SYNTHETIC_COOKIE_MARKER,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        }],
        origins: [{
          origin: 'http://127.0.0.1:4173',
          localStorage: [{ name: 'sb-local-auth-token', value: localStorageValue }],
        }],
      },
    },
  });
}

test('trace scrub removes nested storage state and unexpected binary credential markers', async (t) => {
  const directory = await mkdtemp(join(process.cwd(), '.qa-test-trace-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'raw-trace.zip');
  const destination = join(directory, 'safe-trace.zip');
  const encoder = new TextEncoder();
  await writeFile(source, zipSync({
    'trace.trace': encoder.encode(`${syntheticContextOptionsEvent()}\n`),
    'trace.network': encoder.encode(`${JSON.stringify({
      type: 'resource-snapshot',
      snapshot: {
        request: { headers: [{ name: 'cookie', value: SYNTHETIC_HEADER_COOKIE_MARKER }] },
        response: { headers: [] },
      },
    })}\n`),
    'resources/unexpected.bin': Buffer.concat([
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from(SYNTHETIC_BINARY_MARKER),
    ]),
  }));

  await scrubTraceZip(source, destination);
  const archive = unzipSync(new Uint8Array(await readFile(destination)));
  const bytes = Buffer.concat(Object.values(archive).map((entry) => Buffer.from(entry)));
  for (const marker of [
    SYNTHETIC_ACCESS_MARKER,
    SYNTHETIC_REFRESH_MARKER,
    SYNTHETIC_COOKIE_MARKER,
    SYNTHETIC_HEADER_COOKIE_MARKER,
    SYNTHETIC_BINARY_MARKER,
  ]) {
    assert.equal(bytes.includes(Buffer.from(marker)), false, 'A synthetic credential marker survived trace scrubbing.');
  }
});

test('a trace scrub failure deletes every raw trace in the managed artifact root', async (t) => {
  const directory = await mkdtemp(join(process.cwd(), '.qa-test-trace-failure-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const first = join(directory, 'first', 'trace.zip');
  const second = join(directory, 'second', 'trace.zip');
  await mkdir(join(directory, 'first'), { recursive: true });
  await mkdir(join(directory, 'second'), { recursive: true });
  await writeFile(first, 'not-a-zip', 'utf8');
  await writeFile(second, 'also-not-a-zip', 'utf8');

  await assert.rejects(scrubPlaywrightTraces(directory));
  await assert.rejects(readFile(first), { code: 'ENOENT' });
  await assert.rejects(readFile(second), { code: 'ENOENT' });
});
