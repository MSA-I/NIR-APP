import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');

describe('service worker cache boundary', () => {
  it('caches only same-origin shell traffic and leaves API responses live', () => {
    expect(source).toContain("url.origin !== self.location.origin");
    expect(source).toContain("event.request.mode === 'navigate'");
    expect(source).toContain("url.pathname.startsWith('/assets/') || SHELL_FILES.has(url.pathname)");
    expect(source).toContain("html.matchAll(/(?:src|href)=[\"'](\\/assets\\/[^\"']+)[\"']/g)");
    expect(source).not.toMatch(/caches\.match\([^)]*(supabase|\/rest\/v1|\/functions\/v1)/i);
  });
});
