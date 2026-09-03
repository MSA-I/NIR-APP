#!/usr/bin/env node
/**
 * W0-G4 / Wave 1 — the production auth hardening the owner approved on 03.09.2026.
 *
 * WHY THIS IS A SCRIPT AND NOT A MIGRATION. None of it is schema. GoTrue's password policy lives
 * in the project's auth configuration, reachable only through the Management API, so the change
 * is a PATCH to that configuration and the evidence is the value read back afterwards.
 *
 * WHAT W0-G4 MEASURED on 03.09.2026, and every line of it is the reason a toggle is here:
 *
 *   password_min_length                          6      <- the client enforces 10; the SERVER
 *                                                          accepts six from any caller that
 *                                                          skips the form. The regression report
 *                                                          claiming "the minimum rose to 10" was
 *                                                          describing a client-side check only.
 *   password_hibp_enabled                        false  <- `1234567890` and every other known
 *                                                          breached password is accepted today.
 *   hook_password_verification_attempt_enabled   false  <- and its URI is NULL. See below.
 *   security_captcha_enabled                     false  <- deliberately NOT changed: the plan
 *                                                          calls CAPTCHA a separate judgement.
 *
 *   There is NO sign-in attempt limit in this configuration at all. `rate_limit_verify`, `_otp`,
 *   `_token_refresh` and `_anonymous_users` exist and none of them governs password sign-in —
 *   which is the 33-attempts-without-a-block finding, confirmed at its source.
 *
 * THE THIRD TOGGLE IS NOT IN THE DEFAULT SET, AND THAT IS THE POINT.
 * `hook_password_verification_attempt_enabled` is the supported lockout mechanism, but its
 * `..._uri` is null. Enabling a hook with nothing behind it does not weaken sign-in — it REFUSES
 * every sign-in, because GoTrue calls a hook that is not there. So the lockout needs its hook
 * function to exist and its URI to be set in the same change, and `--with-lockout <uri>` is the
 * only way to ask for it. Without that flag this script will not touch it.
 *
 * SAFE TO RUN ON A LIVE SITE WITH USERS. Neither default toggle affects an existing session or an
 * existing password: `password_min_length` and the breach check are evaluated when a password is
 * SET, so nobody is locked out by this and nobody has to change anything. What changes is that
 * the next password chosen has to be one.
 *
 * The token is read at run time from the path recorded in `docs/LOCAL-CREDENTIALS-PATH.md`, is
 * never printed, and never enters the repository.
 *
 *   node scripts/auth-hardening.mjs --check     # read only, prints the measured state
 *   node scripts/auth-hardening.mjs             # applies the two approved toggles
 *   node scripts/auth-hardening.mjs --with-lockout https://<host>/functions/v1/<fn>
 */
import { readFileSync } from 'node:fs';

const PROJECT_REF = 'rkftlbctohswhbbiaqin';
const TOKEN_PATH = 'D:/משה פרוייקטים/פיתוח אתרים/AI/API/NIR-TOKEN-SUPABASE.txt';
const ENDPOINT = `https://api.supabase.com/v1/projects/${PROJECT_REF}/config/auth`;

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const lockoutAt = args.indexOf('--with-lockout');
const lockoutUri = lockoutAt >= 0 ? args[lockoutAt + 1] : null;
if (lockoutAt >= 0 && !lockoutUri) {
  console.error('--with-lockout needs the hook URI as its next argument.');
  process.exit(2);
}

let token;
try {
  token = readFileSync(TOKEN_PATH, 'utf8').trim();
} catch {
  console.error(`auth-hardening: cannot read the Management token from ${TOKEN_PATH}`);
  console.error('See docs/LOCAL-CREDENTIALS-PATH.md. The token is never stored in this repository.');
  process.exit(2);
}
if (!token) { console.error('auth-hardening: the token file is empty.'); process.exit(2); }

/** Everything W0-G4 measured, so a run prints the same shape the gate reported. */
const REPORTED = [
  'password_min_length',
  'password_required_characters',
  'password_hibp_enabled',
  'security_captcha_enabled',
  'hook_password_verification_attempt_enabled',
  'hook_password_verification_attempt_uri',
  'security_update_password_require_current_password',
  'mailer_notifications_password_changed_enabled',
];

async function readConfig() {
  const res = await fetch(ENDPOINT, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`read HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function print(label, cfg) {
  console.log(label);
  for (const key of REPORTED) console.log(`  ${key} = ${JSON.stringify(cfg[key])}`);
}

const before = await readConfig();
print('BEFORE', before);

// `process.exit` while fetch still holds a keep-alive socket aborts Node on Windows with a
// libuv assertion, which reads like a failure and is not one. Set the code and let it drain.
if (checkOnly) {
  console.log('AUTH_HARDENING_READ_ONLY');
} else {
  await apply();
}

async function apply() {

const patch = { password_min_length: 10, password_hibp_enabled: true };
if (lockoutUri) {
  patch.hook_password_verification_attempt_uri = lockoutUri;
  patch.hook_password_verification_attempt_enabled = true;
}

const res = await fetch(ENDPOINT, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(patch),
});
if (!res.ok) {
  console.error(`PATCH HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exitCode = 1;
  return;
}

const after = await readConfig();
print('AFTER', after);

// The value read back is the evidence, not the 200. And nothing outside the patch may have moved:
// a configuration PATCH that resets a neighbouring field is exactly the silent change this whole
// wave exists to stop.
let ok = true;
for (const [key, want] of Object.entries(patch)) {
  if (after[key] !== want) {
    ok = false;
    console.error(`  MISMATCH ${key}: wanted ${JSON.stringify(want)}, read back ${JSON.stringify(after[key])}`);
  }
}
for (const key of Object.keys(before)) {
  if (key in patch) continue;
  if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
    ok = false;
    console.error(`  UNEXPECTED CHANGE ${key}`);
  }
}
console.log(ok ? 'AUTH_HARDENING_APPLIED' : 'AUTH_HARDENING_FAILED');
if (!ok) process.exitCode = 1;
}
