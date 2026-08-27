import { he } from '../lib/i18n/dictionaries/he';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');
const settings = source('src/pages/Settings.tsx');
const admin = source('src/pages/Admin.tsx');
const layout = source('src/components/Layout.tsx');
const organizationAccess = source('src/lib/organizationAccess.ts');
const auth = source('src/auth/AuthContext.tsx');
const exportFunction = source('supabase/functions/tenant-export/index.ts');

describe('tenant offboarding UI contract', () => {
  it('renders offboarding as its own server-authoritative read-only state', () => {
    expect(organizationAccess).toContain("'offboarding'");
    expect(organizationAccess).toContain("canWrite: mode === 'active'");
    expect(organizationAccess).not.toContain("mode === 'trial'");
    expect(organizationAccess).not.toContain("mode === 'grace'");
    expect(layout).toContain("organizationAccess.mode === 'offboarding'");
    // The notice moved into the dictionary, so the claim moves with it: the layout must render
    // that key, and the key must still carry the sentence this contract is about.
    expect(layout).toContain("t('nav.text_13')");
    expect(he.nav.text_13).toContain('הארגון נמצא בתהליך סיום שירות');
    expect(auth).toContain('refreshOrganizationAccess: () => Promise<void>');
  });

  it('lets an owner request, cancel and download without inventing a reason', () => {
    expect(settings).toContain("supabase.rpc('request_organization_offboarding'");
    expect(settings).toContain("supabase.rpc('cancel_organization_offboarding'");
    expect(settings).toContain("body: { action: 'download', request_id: offboarding.id }");
    expect(settings).toContain('stableSessionUuid(keyName)');
    expect(settings).toContain('refreshOrganizationAccess()');
    expect(settings).toContain('{!offboardingOpen && (');
    expect(settings).not.toContain('{!offboardingOpen && canWrite && (');
  });

  it('requires platform step-up for approve/build/reactivate and keeps export asynchronous in the UI', () => {
    expect(admin).toContain("supabase.rpc('approve_organization_offboarding'");
    expect(admin).toContain("supabase.rpc('reactivate_organization_from_offboarding'");
    expect(admin).toContain("body: { action: 'build', request_id: request.id }");
    expect(admin).toContain('open={offboardingPending !== null}');
    expect(admin).toContain('הועברה לעיבוד');
  });

  it('revalidates a revocable bearer after Storage signed-URL minting', () => {
    const mint = exportFunction.indexOf('createSignedUrl');
    const revalidate = exportFunction.indexOf("service_revalidate_organization_export_link");
    const redirect = exportFunction.indexOf('status: 302');
    expect(mint).toBeGreaterThan(-1);
    expect(revalidate).toBeGreaterThan(mint);
    expect(redirect).toBeGreaterThan(revalidate);
  });
});
