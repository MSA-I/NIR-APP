import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner decision G (03.09.2026): every password change is recorded in `audit_logs`.
 *
 * THE POINT OF THIS FILE IS WHAT IT FORBIDS. The obvious way to satisfy decision G is to call
 * `supabase.auth.updateUser(...)` and then insert an audit row from the browser — and that is the
 * one implementation the decision rules out by name, because the pair is not atomic: the password
 * changes, the insert fails, and the ledger says nothing while reality has moved.
 *
 * The record is therefore written by a database trigger inside GoTrue's OWN transaction on
 * `auth.users` (filed as `artifacts/w1/migration-requests/w1-password.sql`). Which means the
 * browser's whole obligation is negative: change the password through the one door the trigger
 * sits behind, and write nothing itself.
 *
 * So these assertions are the client half of decision G. If a later change makes one of them
 * fail, the fix is not to relax the assertion — it is that the change has taken the password
 * change out from under the recorder, or has reintroduced the best-effort write.
 *
 * Line endings are normalized for the reason `accountRecovery.spec.ts` gives: a CRLF checkout and
 * an LF one must read the same contract.
 */
const page = (name: string) =>
  readFileSync(join(process.cwd(), 'src', 'pages', name), 'utf8').replace(/\r\n/g, '\n');

const PASSWORD_SCREENS = ['SetPassword.tsx', 'Settings.tsx', 'ResetPassword.tsx'] as const;

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('decision G — the browser writes no password audit row', () => {
  it.each(PASSWORD_SCREENS)('%s changes the password through the one recorded door', (name) => {
    const source = page(name);
    // Exactly one: a second call would be a second password change, and the screen would be
    // claiming something the single audit row does not say.
    expect(occurrences(source, 'supabase.auth.updateUser(')).toBe(1);
  });

  it.each(PASSWORD_SCREENS)('%s writes no audit row of its own', (name) => {
    const source = page(name);
    // A quoted table name is how a browser write would have to name it.
    expect(source).not.toContain("'audit_logs'");
    expect(source).not.toContain('"audit_logs"');
  });

  it.each(PASSWORD_SCREENS)('%s reaches for no privileged identity to do it', (name) => {
    const source = page(name);
    expect(source).not.toContain('service_role');
    expect(source).not.toContain('auth.admin');
  });
});
