import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('typography contract', () => {
  const css = readFileSync('src/index.css', 'utf8');
  const html = readFileSync('index.html', 'utf8');

  it('ships the free local Noto default without Google Fonts', () => {
    expect(css).toContain('NotoSansHebrew-Hebrew.woff2');
    expect(css).toContain('NotoSansHebrew-Latin.woff2');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).not.toContain(['IBM', 'Plex'].join(' '));
  });

  it('uses proportional tabular figures for ordinary numbers', () => {
    const numRule = css.match(/\.num\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(numRule).toContain('tabular-nums');
    expect(numRule).not.toContain('direction: ltr');
    expect(numRule).not.toContain('ui-monospace');
    expect(numRule).not.toContain('unicode-bidi: embed');
  });

  it('reserves a separate monospace class for true technical IDs', () => {
    const techRule = css.match(/\.tech-id\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(techRule).toContain('ui-monospace');
    expect(techRule).toContain('unicode-bidi: isolate');
  });
});
