import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { organizationAccessFromServer } from '../lib/organizationAccess';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const app = source('src/App.tsx');
const layout = source('src/components/Layout.tsx');
const admin = source('src/pages/Admin.tsx');
const customers = source('src/operator/Customers.tsx');
const provision = source('supabase/functions/admin-provision/index.ts');
// Provisioning moved into a module both doors share (0159): the operator's and the public
// signup's. The lifecycle claim is asserted where the insert now lives.
const provisionCore = source('supabase/functions/_shared/provision.ts');
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
    expect(auth).toContain("if (access.mode !== 'active') void refreshAccess()");
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

  // The lifecycle action moved with the customer list to the operator console's own screen
  // (0151); Admin.tsx keeps provisioning, offboarding and feedback. The contract is unchanged and
  // is asserted where the call now lives -- and Admin.tsx is held to no longer carrying it, so a
  // copy-paste back into the tenant-shaped page fails here.
  it('limits Platform Admin lifecycle actions to suspend and reactivate', () => {
    expect(customers).toContain("action: 'suspend' | 'reactivate'");
    expect(customers).toContain("const status = action === 'suspend' ? 'suspended' : 'active'");
    expect(customers).toContain('<ReauthModal');
    expect(customers).toContain('p_trial_ends_at: null');
    expect(customers).not.toContain("p_status: 'trial'");
    expect(customers).not.toContain('trialEndInstant');
    expect(admin).not.toContain("supabase.rpc('set_organization_lifecycle'");
    expect(provision).not.toContain('body.trial_ends_at');
    expect(provision).not.toContain('body.status');
    expect(provisionCore).toContain('Status defaults to active');
    // The public door must not let a form choose a plan either: a signup that could ask for
    // Business would be a free upgrade (0159).
    expect(provisionCore).not.toContain('plan_key');
  });

  // A lifecycle change is gated on a capability the operator may not hold, and the screen must
  // say which of "not permitted" and "nothing here" it is showing -- platform_customers() answers
  // an unauthorised caller with zero rows, which on its own is indistinguishable from an empty
  // customer base.
  it('gates the operator screen on capabilities rather than on membership alone', () => {
    expect(customers).toContain("may('org.lifecycle')");
    expect(customers).toContain("may('customer.view')");
    expect(customers).toContain('fetchMyCapabilities');
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
