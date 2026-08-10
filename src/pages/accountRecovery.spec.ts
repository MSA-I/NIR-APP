import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Line endings are normalized because these are source-text assertions: a CRLF checkout
// (Windows) and an LF one (Linux CI) must read the same contract. The multi-line assertion
// below silently matched nothing on CRLF before this -- the same trap 0092's ancestry guard
// hit with md5(prosrc).
const page = (name: string) =>
  readFileSync(join(process.cwd(), 'src', 'pages', name), 'utf8').replace(/\r\n/g, '\n');

describe('self-service account recovery contract', () => {
  it('uses a same-origin Supabase recovery link and a non-enumerating receipt', () => {
    const forgot = page('ForgotPassword.tsx');
    expect(forgot).toContain('resetPasswordForEmail');
    expect(forgot).toContain('window.location.origin}/reset-password');
    expect(forgot).toContain('אם קיימת כתובת תואמת');
  });

  it('updates only the active recovery user and revokes sessions', () => {
    const reset = page('ResetPassword.tsx');
    expect(reset).toContain('supabase.auth.updateUser({ password })');
    expect(reset).toContain("signOut({ scope: 'global' })");
    expect(reset).toContain('if (signedOut.error) {');
    expect(reset).toContain('לא ניתן היה לנתק את כל החיבורים');
    expect(reset.indexOf('return;\n    }\n    navigate')).toBeGreaterThan(-1);
    expect(reset).not.toMatch(/admin|service_role|user_id/i);
  });

  it('keeps both recovery routes public while tenant bootstrap is unavailable', () => {
    const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(app).toContain("'/forgot-password', '/reset-password'");
    expect(app).toContain('path="/forgot-password"');
    expect(app).toContain('path="/reset-password"');
  });
});
