import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { he } from './i18n/dictionaries/he';
import { en } from './i18n/dictionaries/en';
import {
  BRAND_CORRELATION_DISPOSITION_HEADER,
  BRAND_CORRELATION_ROTATE_VALUE,
  brandFailureAllowsNewCorrelation,
  brandLogoProblemKey,
} from './organizationBranding';

const read = (path: string) => readFileSync(join(process.cwd(), ...path.split('/')), 'utf8');

describe('organization branding wiring', () => {
  it('routes brand uploads through the server validator and never accepts SVG or HTML', () => {
    const settings = read('src/pages/Settings.tsx');
    const edge = read('supabase/functions/upload-organization-logo/index.ts');
    expect(read('src/lib/organizationBranding.ts')).toContain("['image/png', 'image/jpeg', 'image/webp']");
    expect(settings).toContain("'upload-organization-logo', {");
    expect(edge).toContain('validatedLogoType(uploadBytes, value.type, value.size)');
    expect(edge).toContain('kind: "organization_logo_storage"');
    expect(edge).toContain('error: "invalid_correlation_id"');
    expect(edge).toContain('STORAGE_CONTROL_TIMEOUT_MS');
    expect(edge).toContain('AbortSignal.timeout(STORAGE_CONTROL_TIMEOUT_MS)');
    expect(edge).toContain('evidence: { ...operationEvidence }');
    expect(edge).toContain('retryable_definitive: !cleanupFailed');
    expect(edge).toContain('rotate-after-definitive-failure');
    expect(edge).toContain('databaseFailureIsDefinitive');
    expect(edge).toContain('runReservedEgress');
    expect(edge).toContain('getOrganizationEgressEvidence');
    expect(edge).toContain('crypto.randomUUID()');
    expect(edge).toContain('upsert: false');
    expect(edge).toContain('branding_conflict');
    expect(edge).toContain('"set_organization_branding_reference",');
    expect(edge).not.toMatch(/from\("organizations"\)\s*\.update/);
    expect(settings).not.toMatch(/image\/svg|text\/html/);
    expect(settings).toContain("headers: { 'x-correlation-id': correlationId }");
    expect(settings).toContain('stableSessionUuid(keyName)');
    expect(settings).toContain('logoUploadSessionKey(org.id, file)');
    expect(settings).toContain('brandFailureAllowsNewCorrelation(error)');
  });

  it('rotates a correlation only after an explicitly definitive no-commit response', () => {
    const definitive = {
      context: {
        headers: new Headers({
          [BRAND_CORRELATION_DISPOSITION_HEADER]: BRAND_CORRELATION_ROTATE_VALUE,
        }),
      },
    };
    expect(brandFailureAllowsNewCorrelation(definitive)).toBe(true);
    expect(brandFailureAllowsNewCorrelation({
      context: { headers: new Headers() },
    })).toBe(false);
    expect(brandFailureAllowsNewCorrelation(new Error('response lost'))).toBe(false);
  });

  it('checks image signatures instead of trusting the browser MIME claim', async () => {
    const png = new File([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], 'logo.png', { type: 'image/png' });
    const disguisedHtml = new File(['<script>alert(1)</script>'], 'logo.png', { type: 'image/png' });
    await expect(brandLogoProblemKey(png)).resolves.toBeNull();
    // The refusal is a key now; the sentence it stands for is pinned in both dictionaries.
    await expect(brandLogoProblemKey(disguisedHtml)).resolves.toBe('branding.logoContentMismatch');
    expect(he.branding.logoContentMismatch).toContain('אינו תואם');
    expect(en.branding.logoContentMismatch).toMatch(/does not match/i);
  });

  it('uses the tenant logo in the authenticated shell and in every generated document', () => {
    expect(read('src/components/Layout.tsx')).toContain("from('organization-branding').getPublicUrl");
    // #330 moved the four printed headings onto one plate, so the logo has one render site and
    // the contract widened with it: the report is no longer the only document that carries it.
    expect(read('src/components/DocumentPlate.tsx')).toContain('data-testid="document-org-logo"');
    for (const page of ['Reports.tsx', 'Orders.tsx', 'Expenses.tsx', 'InvoiceDetail.tsx']) {
      expect(read(`src/pages/${page}`)).toContain('orgLogoUrl={orgLogoUrl}');
    }
  });
});
