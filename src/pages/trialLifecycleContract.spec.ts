import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const app = source('src/App.tsx');
const layout = source('src/components/Layout.tsx');
const admin = source('src/pages/Admin.tsx');
const provision = source('supabase/functions/admin-provision/index.ts');
const auth = source('src/auth/AuthContext.tsx');
const trial = source('src/lib/trial.ts');

describe('trial lifecycle UI contract', () => {
  it('shows the approved grace and read-only explanations verbatim', () => {
    expect(layout).toContain('תקופת הניסיון הסתיימה. נותרו <span className="num font-semibold">{organizationAccess.graceDaysRemaining}</span> ימים להמשך שימוש מלא במערכת. לאחר מכן המערכת תעבור למצב קריאה בלבד והמידע שלך יישאר זמין לצפייה ולייצוא.');
    const expired = 'תקופת הניסיון הסתיימה. המערכת נמצאת כעת במצב קריאה בלבד. כל המידע הקיים נשמר וזמין לצפייה ולייצוא. להפעלת המערכת מחדש יש לפנות למנהל השירות.';
    expect(layout).toContain(expired);
    expect(app).toContain(expired);
  });

  it('marks mutation-only routes as write guarded while read routes stay available', () => {
    for (const path of ['/orders/new', '/receiving/:orderId', '/invoices/new', '/pay', '/pay/emergency', '/onboarding']) {
      expect(app).toMatch(new RegExp(`path="${path.replace('/', '\\/')}"[^\n]+<Guard[^\n]+ write>`));
    }
    expect(app).toContain('path="/reports" element={<Guard roles={[\'owner\', \'accountant\']}><Reports /></Guard>}');
  });

  it('uses the existing step-up boundary for explicit, reasoned platform trial extension', () => {
    expect(admin).toContain('<ReauthModal');
    expect(admin).toContain("p_status: 'trial'");
    expect(admin).toContain('p_trial_ends_at: trialEndInstant(extension.date)');
    expect(admin).toContain('p_reason: extension.reason.trim()');
    expect(admin).toContain('disabled={busy || !extension.date || !extension.reason.trim()}');
    expect(admin).toContain('open={statusReauth}');
    expect(admin).not.toContain('new-org-trial');
    expect(provision).not.toContain('body.trial_ends_at');
  });

  it('gets lifecycle write access from the database clock instead of the device clock', () => {
    expect(auth).toContain("supabase.rpc('organization_access_state')");
    expect(auth).toContain('window.setInterval(() => void refreshAccess(), 60_000)');
    expect(trial).toContain('organizationAccessFromServer');
    expect(trial).not.toMatch(/Date\.now\(\)/);
  });
});
