// Prepares the local Edge environment for a CI run, the way New-LocalFunctionsEnvironment
// does on Windows. It is a separate implementation for one reason: the PowerShell version
// mints VAPID keys with System.Security.Cryptography.ECDsaCng, and Cng is a Windows-only API.
// Everything else here mirrors check-quality-gates.ps1:674-686 line for line.
//
// Usage:
//   node scripts/ci-local-env.mjs write-functions-env                # writes supabase/functions/.env
//   node scripts/ci-local-env.mjs write-demo-manifest <seed> <path>  # demo Auth accounts, outside the repo

import { writeFileSync, existsSync } from 'node:fs';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(repoRoot, 'supabase', 'functions', '.env');

/** P-256 keys in the shape web-push expects: uncompressed point for the public half. */
function newVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, 'base64url'),
    Buffer.from(pub.y, 'base64url'),
  ]);
  if (point.length !== 65) throw new Error(`VAPID public point is ${point.length} bytes, expected 65`);
  return { publicKey: point.toString('base64url'), privateKey: priv.d };
}

const mode = process.argv[2];

if (mode === 'write-functions-env') {
  // The gate refuses to overwrite a pre-existing .env because it may hold real secrets. On a
  // fresh CI runner there is never one; if there is, something is wrong and we stop rather
  // than clobber it.
  if (existsSync(envPath)) {
    console.error(`Refusing to overwrite an existing ${envPath}.`);
    process.exit(1);
  }
  const vapid = newVapidKeys();
  const secrets = {
    OCR_WORKER_TOKEN: `quality-${randomUUID().replace(/-/g, '')}`,
    INTERPRET_DOCUMENT_CRON_SECRET: `quality-${randomUUID().replace(/-/g, '')}`,
    PUSH_FN_SECRET: `quality-${randomUUID().replace(/-/g, '')}`,
  };
  const lines = [
    `OCR_WORKER_TOKEN=${secrets.OCR_WORKER_TOKEN}`,
    `INTERPRET_DOCUMENT_CRON_SECRET=${secrets.INTERPRET_DOCUMENT_CRON_SECRET}`,
    'OPENAI_API_KEY=local-provider-mock-not-sent',
    'APP_BASE_URL=http://127.0.0.1:5199',
    `PUSH_FN_SECRET=${secrets.PUSH_FN_SECRET}`,
    `VAPID_PUBLIC_KEY=${vapid.publicKey}`,
    `VAPID_PRIVATE_KEY=${vapid.privateKey}`,
    'VAPID_SUBJECT=mailto:quality-local@example.test',
  ];
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  console.log(`Wrote ${lines.length} lines to supabase/functions/.env (VAPID public key ${vapid.publicKey.length} chars).`);
} else if (mode === 'write-demo-manifest') {
  // Mirrors New-DemoManifest (check-quality-gates.ps1:461-472). The password shape is a
  // contract shared with check-browser-smoke.cjs, which derives the same string from
  // QUALITY_PASSWORD_SEED — change one and the browser scenarios stop being able to log in.
  const [, , , seed, outPath] = process.argv;
  if (!seed || !outPath) throw new Error('Usage: write-demo-manifest <seed> <path outside the repo>');
  if (path.resolve(outPath).startsWith(repoRoot + path.sep)) {
    throw new Error('The demo manifest must live outside the repository; create-users.ps1 refuses otherwise.');
  }
  const roles = ['owner', 'kitchen', 'office', 'payer', 'accountant', 'supplier'];
  const accounts = roles.map((role) => ({
    email: `${role}@demo.supplyflow.local`,
    password: `P4!${seed}-${role}-Aa7`,
  }));
  writeFileSync(outPath, JSON.stringify({ accounts }, null, 2), 'utf8');
  console.log(`Wrote a ${accounts.length}-account demo manifest to ${outPath}.`);
} else {
  console.error('Usage: node scripts/ci-local-env.mjs <write-functions-env|write-demo-manifest>');
  process.exit(2);
}
