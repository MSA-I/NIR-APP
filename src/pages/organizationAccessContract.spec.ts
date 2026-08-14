import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { organizationAccessFromServer } from '../lib/organizationAccess';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const app = source('src/App.tsx');
const layout = source('src/components/Layout.tsx');
const admin = source('src/pages/Admin.tsx');
const provision = source('supabase/functions/admin-provision/index.ts');
const auth = source('src/auth/AuthContext.tsx');
const access = source('src/lib/organizationAccess.ts');
const migration = source('supabase/migrations/0134_retire_trial_lifecycle.sql');

describe('organization access after Trial retirement', () => {
  it('accepts only active as writable and fails retired or unknown modes closed', () => {
    expect(organizationAccessFromServer({ access_mode: 'active' }))
      .toEqual({ mode: 'active', canWrite: true });
    for (const mode of ['offboarding', 'suspended', 'read_only']) {
      expect(organizationAccessFromServer({ access_mode: mode }).canWrite).toBe(false);
    }
    for (const retired of ['trial', 'grace']) {
      expect(organizationAccessFromServer({ access_mode: retired }))
        .toEqual({ mode: 'read_only', canWrite: false });
    }
    expect(access).not.toMatch(/['"]trial['"]\s*\|/);
    expect(access).not.toMatch(/['"]grace['"]\s*\|/);
  });

  it('keeps server-authoritative refresh and route-level mutation guards without Trial banners', () => {
    expect(auth).toContain("supabase.rpc('organization_access_state')");
    expect(auth).toContain('refreshOrganizationAccess: () => Promise<void>');
    expect(auth).toContain('void refreshAccess();');
    expect(auth).toContain("window.addEventListener('focus', onFocus)");
    expect(auth).toContain("document.addEventListener('visibilitychange', onVisibility)");
    expect(app).toContain('if (write && !organizationAccess.canWrite)');
    for (const path of ['/orders/new', '/receiving/:orderId', '/invoices/new', '/pay', '/onboarding']) {
      expect(app).toMatch(new RegExp(`path="${path.replace('/', '\\/')}"[^\n]+<Guard[^\n]+ write>`));
    }
    for (const retiredCopy of ['תקופת הניסיון', 'ימי חסד', 'Grace', 'Trial']) {
      expect(layout).not.toContain(retiredCopy);
      expect(app).not.toContain(retiredCopy);
    }
  });

  it('limits Platform Admin lifecycle actions to suspend and reactivate', () => {
    expect(admin).toContain("action: 'suspend' | 'reactivate'");
    expect(admin).toContain("const status = action === 'suspend' ? 'suspended' : 'active'");
    expect(admin).toContain('<ReauthModal');
    expect(admin).toContain('p_trial_ends_at: null');
    expect(admin).not.toContain("p_status: 'trial'");
    expect(admin).not.toContain('trialEndInstant');
    expect(provision).not.toContain('body.trial_ends_at');
    expect(provision).toContain('Status defaults to active');
    expect(provision).not.toContain('body.status');
  });

  it('preserves the deployed RPC shape while retiring every Trial write path in SQL', () => {
    expect(migration).toContain("alter column status set default 'active'");
    expect(migration).toContain('organizations_trial_retired');
    expect(migration).toContain("if p_status = 'trial' or p_trial_ends_at is not null then");
    expect(migration).toContain("if p_status not in ('active', 'suspended') then");
    expect(migration).toContain('null::timestamptz');
    expect(migration).toContain('null::integer');
  });
});
