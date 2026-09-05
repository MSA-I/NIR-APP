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

  /**
   * The step-up prop, pinned in source as well as measured.
   *
   * `src/pages/offboardingStepUp.spec.tsx` is the oracle — it mounts the screen and watches the
   * wire. This is the cheap second lock beside it: one `ReauthModal` serves all three actions, so
   * the correct value is a conditional, and both mistakes it guards against are one keystroke
   * away. Dropping the prop restores `skipWhenFresh`'s `true` default and with it `OWN-01` — the
   * effect in `ReauthModal` that fires `onConfirm` before paint on a fresh `password` AMR. Writing
   * `skipWhenFresh={false}` instead would start re-prompting for the export link, which the
   * offboarding ruling never asked for.
   */
  it('gates the closure request and its cancellation on a step-up the fresh-JWT skip cannot bypass', () => {
    expect(settings).toContain("skipWhenFresh={offboardingAction === 'download'}");
    // The step-up is the only confirmation these two actions get, so it carries what changes.
    expect(settings).toContain("t('settings.offboardingRequestDetails')");
    expect(settings).toContain("t('settings.offboardingCancelDetails')");
    expect(he.settings.offboardingRequestDetails).toContain('קריאה בלבד');
    expect(he.settings.offboardingCancelDetails).toContain('קריאה בלבד');
    // The ruling gives neither action a reason field — the sweep's "audited with no reason" half
    // is the product working as decided, and this keeps a later edit from "helpfully" adding one.
    expect(settings).not.toContain('reasonLabel={offboardingAction');
  });

  it('requires platform step-up for approve/build/reactivate and keeps export asynchronous in the UI', () => {
    expect(admin).toContain("supabase.rpc('approve_organization_offboarding'");
    expect(admin).toContain("supabase.rpc('reactivate_organization_from_offboarding'");
    expect(admin).toContain("body: { action: 'build', request_id: request.id }");
    expect(admin).toContain('open={offboardingPending !== null}');
    // The sentence moved into the dictionary, so the claim moves with it in two halves: the
    // screen renders that key, and the key still says the export build was QUEUED rather than
    // finished. Either half alone would pass against a broken dictionary or a silent rewrite.
    expect(admin).toContain("t('admin.text')");
    expect(he.admin.text).toContain('הועברה לעיבוד');
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
