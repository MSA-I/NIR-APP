import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { redactText, redactUnknown } from './redact.ts';

function redactJson(value: unknown): string {
  return JSON.stringify(redactUnknown(value));
}

function redactUtf8(text: string): string {
  try {
    return redactJson(JSON.parse(text) as unknown);
  } catch {
    const trailingNewline = text.endsWith('\n');
    const lines = text.split(/\r?\n/);
    const redacted = lines.map((line) => {
      if (!line) return '';
      try {
        return redactJson(JSON.parse(line) as unknown);
      } catch {
        return redactText(line);
      }
    }).join('\n');
    return trailingNewline && !redacted.endsWith('\n') ? redacted + '\n' : redacted;
  }
}

function assertNoRecognizableCredentials(text: string, name: string): void {
  const exposed = [
    /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+\/-]{8,}/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /["\\]*(?:access_token|refresh_token|service_role_key)["\\]*\s*:\s*["\\]*(?!\[REDACTED\])/i,
  ].some((pattern) => pattern.test(text));
  if (exposed) throw new Error('Trace entry ' + name + ' still contains a recognizable credential.');
}

export async function scrubTraceZip(source: string, destination: string): Promise<void> {
  const archive = unzipSync(new Uint8Array(await readFile(source)));
  for (const [name, bytes] of Object.entries(archive)) {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // The QA trace configuration disables snapshots, sources and attachments. Any binary
      // entry is therefore unexpected and cannot be proven free of embedded credentials.
      delete archive[name];
      continue;
    }
    const safe = redactUtf8(text);
    assertNoRecognizableCredentials(safe, name);
    if (safe !== text) archive[name] = new TextEncoder().encode(safe);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, zipSync(archive, { level: 6 }));
}
