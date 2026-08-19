import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

// The portal's boundary is structural, and these assertions keep it that way: a supplier page
// holding a bearer token must stay incapable of reaching tenant surfaces, the token must stay
// out of URLs and logs, and the supplier must keep seeing the RAW product wording (0149 rule —
// the canonical display name never leaves the tenant screens).
describe('supplier portal boundary', () => {
  const portalFiles = ['src/portal/main.tsx', 'src/portal/PortalApp.tsx', 'src/portal/api.ts'];

  it('never imports the Supabase client, the auth context, or tenant pages', () => {
    for (const file of portalFiles) {
      const value = source(file);
      expect(value, file).not.toMatch(/from '.*lib\/supabase'/);
      expect(value, file).not.toMatch(/from '.*auth\/AuthContext'/);
      expect(value, file).not.toMatch(/from '.*pages\//);
      expect(value, file).not.toContain('service_role');
    }
  });

  it('never reaches for the canonical display name — raw supplier wording only', () => {
    for (const file of [...portalFiles, 'src/components/SupplierPortalCard.tsx']) {
      const value = source(file);
      expect(value, file).not.toContain('display_name');
      expect(value, file).not.toContain('productLabel');
    }
  });

  it('speaks POST-only and carries the token in the body, never the URL', () => {
    const api = source('src/portal/api.ts');
    expect(api).toContain("method: 'POST'");
    expect(api).not.toMatch(/[?&]token=/);
    // The share URL builders put the token in the FRAGMENT (#token=), which never reaches a
    // server log; the query fallback (?t=) is read but never written.
    const lib = source('src/lib/supplierPortal.ts');
    expect(lib).toContain('/portal#token=');
  });

  it('is a third entry, excluded from the tenant precache and the tenant shell fallback', () => {
    const vite = source('vite.config.ts');
    expect(vite).toContain("portal: fileURLToPath(new URL('./portal.html'");
    expect(vite).toContain('**/portal.html');
    expect(vite).toContain('**/assets/portal-*');
    const sw = source('public/sw.js');
    expect(sw).toContain("url.pathname === '/portal'");
    const swGuard = sw.slice(sw.indexOf("mode === 'navigate'"));
    expect(swGuard).toContain('isPortalNavigation(url)');
    // No manifest link and no service-worker registration in the portal page itself.
    const html = source('portal.html');
    expect(html).not.toMatch(/<link[^>]*rel="manifest"/);
    expect(html).not.toContain('serviceWorker');
    expect(html).toContain('noindex');
  });

  it('the Edge door is jwt-free by declared config, and the CI gate asserts it', () => {
    expect(source('supabase/config.toml')).toMatch(
      /\[functions\.supplier-portal\]\r?\nverify_jwt = false/);
    expect(source('scripts/check-quality-gates.ps1')).toContain('"supplier-portal" = "false"');
  });

  it('both new build entries are known to the CI change classifiers', () => {
    expect(source('.github/workflows/build.yml')).toContain('portal\\.html$');
    expect(source('.github/workflows/quality-gate.yml')).toContain('portal\\.html');
  });
});
