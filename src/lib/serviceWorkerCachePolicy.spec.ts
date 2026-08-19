import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
const viteConfig = readFileSync(join(process.cwd(), 'vite.config.ts'), 'utf8');

describe('service worker cache boundary', () => {
  it('uses the build manifest for a complete static shell and leaves API responses live', () => {
    expect(viteConfig).toContain("strategies: 'injectManifest'");
    expect(viteConfig).toContain("srcDir: 'public'");
    expect(viteConfig).toContain("filename: 'sw.js'");
    expect(source).toContain('self.__WB_MANIFEST || []');
    expect(source).toContain('cache.addAll(PRECACHE.map');
    expect(source).toContain("url.origin !== self.location.origin");
    expect(source).toContain("event.request.mode === 'navigate'");
    expect(source).toContain("url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname)");
    expect(source).toContain("caches.match('/index.html', { cacheName: CACHE_NAME })");
    expect(source).toContain("url.pathname.startsWith('/rest/')");
    expect(source).toContain("url.pathname.startsWith('/auth/')");
    expect(source).toContain("url.pathname.startsWith('/storage/')");
    expect(source).toContain("url.pathname.startsWith('/functions/')");
    expect(source).toContain("url.pathname.startsWith('/realtime/')");
    expect(source).not.toContain('html.matchAll');
    expect(source).not.toMatch(/caches\.match\([^)]*(supabase|\/rest\/v1|\/functions\/v1)/i);
  });

  it('never answers the operator console from the tenant shell cache', () => {
    // The operator console (operator.html, a second Vite entry on the same origin) is inside
    // this worker's scope. Serving it the cached TENANT shell would swap one application for
    // another silently — so the worker refuses /operator navigations outright, and the build
    // keeps operator.html and its entry chunk out of the precache manifest.
    expect(source).toContain('isOperatorNavigation');
    expect(source).toContain("url.pathname === '/operator'");
    expect(source).toContain('if (isOperatorNavigation(url)) return;');
    expect(viteConfig).toContain("'**/operator.html'");
    expect(viteConfig).toContain("'**/assets/operator-*'");
  });
});
