#!/usr/bin/env node
/**
 * check:noindex-posture — the application host must not be a search surface, and the ORDER that
 * makes that work must not be reversed by someone who reads half the reasoning.
 *
 * WHAT WENT WRONG. Measured on the live host on 01.09.2026: `app.inplace.digital` answered
 * `200 text/html` on `/`, `/login`, `/suppliers`, `/sitemap.xml` and on a path that does not
 * exist; its title was the bare brand term the marketing site at `inplace.digital` needs to win;
 * and there was no `X-Robots-Tag`, no `<meta name="robots">` and no real `robots.txt` anywhere.
 * `public/_redirects` ends with the SPA catch-all, so a crawler asking for the crawling rules was
 * handed a web page. Cloudflare's AI Crawl Control had logged 15 requests for `/sitemap.xml` in
 * 24 hours, every one answered with HTML.
 *
 * THE TRAP THIS GUARD EXISTS FOR. The instinct is `Disallow: /`. On its own that makes an
 * already-indexed host WORSE: a blocked page is never fetched, so the crawler never sees the
 * `noindex`, and the URLs sit in the results as bare links indefinitely. Allow first, let the
 * noindex be read, and disallow only once the index is actually empty. Nothing in a diff makes
 * that ordering visible, so it is asserted here instead — and a blanket `Disallow` is accepted
 * only when the file also records WHO observed the index empty and WHEN.
 *
 * WHAT THIS GUARD IS NOT. It reads the repository, so it can only prove that the tree still says
 * the right thing. The marketing repository already learned the difference the hard way: its
 * build gate asserted a property of a file in the repository while the host served something
 * else for days. The claim about the LIVE host belongs to `npm run check:live-seo`, which asks
 * app.inplace.digital itself and compares its robots.txt against this one byte for byte.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const inject = process.env.NOINDEX_POSTURE_INJECT ?? '';

const HTML_ENTRIES = ['index.html', 'operator.html', 'portal.html'];
const problems = [];

/** Reads a tracked file, applying the mutation the gate controls ask for. Nothing is written. */
function read(relPath) {
  const full = path.join(repoRoot, relPath);
  if (inject === 'no-robots' && relPath === 'public/robots.txt') return null;
  if (!existsSync(full)) return null;
  let text = readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
  if (inject === 'no-header' && relPath === 'public/_headers') {
    text = text.replace(/^\s*X-Robots-Tag:.*$/gim, '  X-Frame-Options: DENY');
  }
  if (inject === 'narrow-header' && relPath === 'public/_headers') {
    text = text.replace(/^\/\*[ \t]*$/m, '/login');
  }
  if (inject === 'no-meta' && relPath === 'index.html') {
    text = text.replace(/^.*<meta name="robots".*$\n?/gim, '');
  }
  if (inject === 'disallow' && relPath === 'public/robots.txt') {
    text = text.replace(/^Allow: \/$/m, 'Disallow: /');
  }
  // The escape hatch must be provably OPEN, or this guard would quietly forbid the very end
  // state it is written to protect, and nobody would find out until the day they needed it.
  if (inject === 'disallow-cleared' && relPath === 'public/robots.txt') {
    text = text.replace(/^Allow: \/$/m,
      '# INDEX-CLEARED: 2026-09-30 control, a date and an observer is all this line must carry\nDisallow: /');
  }
  if (inject === 'no-catchall' && relPath === 'public/_redirects') {
    text = text.replace(/^\/\*[ \t]+\/index\.html[ \t]+200[ \t]*$/m, '');
  }
  return text;
}

// -- 1. the header, on everything the host serves --------------------------------------------
// The header outranks the meta tag here and the reason is structural, not stylistic: this is a
// single-page application, so a crawler that fetches the document and never runs the bundle
// still reads a response header. It also reaches the responses that were never pages — the SPA
// catch-all turns /sitemap.xml into an HTML document, and a tag inside index.html covers that
// only by accident.
{
  const headers = read('public/_headers');
  if (headers === null) {
    problems.push('public/_headers is missing. Without it nothing carries X-Robots-Tag, and the\n'
      + '  meta tags alone leave every non-HTML response and every unrendered fetch indexable.');
  } else {
    // Cloudflare Pages _headers: an unindented line beginning with `/` opens a rule, and the
    // indented lines under it are that rule's headers, until the next rule.
    const rules = [];
    let current = null;
    for (const raw of headers.split('\n')) {
      if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
      if (!/^\s/.test(raw)) { current = { pattern: raw.trim(), headers: [] }; rules.push(current); continue; }
      if (current) current.headers.push(raw.trim());
    }
    const wildcard = rules.find((r) => r.pattern === '/*');
    if (!wildcard) {
      problems.push(`public/_headers declares no \`/*\` rule (found: ${rules.map((r) => r.pattern).join(', ') || 'nothing'}).\n`
        + '  A narrower pattern leaves whatever it does not match indexable, which on a single-page\n'
        + '  application is every route the catch-all invents.');
    } else {
      const tag = wildcard.headers.find((h) => /^X-Robots-Tag:/i.test(h));
      if (!tag) {
        problems.push('public/_headers has a `/*` rule but it carries no X-Robots-Tag.\n'
          + `  It carries: ${wildcard.headers.join(' | ') || 'nothing'}`);
      } else if (!/\bnoindex\b/i.test(tag)) {
        problems.push(`public/_headers declares X-Robots-Tag without \`noindex\`: ${tag}\n`
          + '  Any other directive leaves the host in the index, which is the whole defect.');
      }
    }
  }
}

// -- 2. a real robots.txt, and it must still ALLOW -------------------------------------------
{
  const robots = read('public/robots.txt');
  if (robots === null) {
    problems.push('public/robots.txt is missing. Cloudflare Pages serves files from the published\n'
      + '  output before the catch-all in _redirects, so without this file a request for the\n'
      + '  crawling rules is answered with the application shell as text/html — which is not a\n'
      + '  robots file at all, and is exactly the state measured on 01.09.2026.');
  } else {
    if (!/^User-agent:\s*\*/im.test(robots)) {
      problems.push('public/robots.txt declares no `User-agent: *` group, so it instructs nobody.');
    }
    // A blanket disallow is the RIGHT end state and the WRONG starting move. It is allowed only
    // once someone records that the index is empty — an observation, not an intention.
    const blanketDisallow = /^Disallow:[ \t]*\/[ \t]*$/im.test(robots);
    const cleared = /^#\s*INDEX-CLEARED:\s*\d{4}-\d{2}-\d{2}\s+\S/im.test(robots);
    if (blanketDisallow && !cleared) {
      problems.push('public/robots.txt carries a blanket `Disallow: /` with no INDEX-CLEARED line.\n'
        + '  Read the ordering before changing this. A disallowed page is never fetched, so the\n'
        + '  crawler never sees the X-Robots-Tag noindex, and URLs already in the index stay there\n'
        + '  as bare links indefinitely. Disallow is the step AFTER Search Console reports them\n'
        + '  gone, and the file must then say who observed that and when:\n'
        + '    # INDEX-CLEARED: 2026-09-30 owner, Search Console coverage shows 0 indexed URLs');
    }
  }
}

// -- 3. the meta tags, as belt and braces ----------------------------------------------------
{
  const without = HTML_ENTRIES.filter((entry) => {
    const html = read(entry);
    return html === null || !/<meta\s+name="robots"[^>]*noindex/i.test(html);
  });
  if (without.length) {
    problems.push(`no \`<meta name="robots" ... noindex>\` in: ${without.join(', ')}\n`
      + '  The header in public/_headers is the primary instruction, but each HTML entry is a\n'
      + '  separate document served to a separate audience, and the tag is what a reader of the\n'
      + '  source sees. They do not conflict.');
  }
}

// -- 4. the catch-all must SURVIVE -----------------------------------------------------------
// The tempting third fix is to stop answering unknown paths with 200 so a crawler gets a real
// 404. That rule is what makes client-side routing work, and breaking it to satisfy a crawler
// would be a genuine regression for a fake gain: on a noindex host a soft 404 costs nothing.
{
  const redirects = read('public/_redirects');
  if (redirects === null || !/^\/\*[ \t]+\/index\.html[ \t]+200[ \t]*$/m.test(redirects)) {
    problems.push('public/_redirects no longer carries the SPA catch-all `/* /index.html 200`.\n'
      + '  If this was removed to give crawlers a real 404, put it back: it is what makes every\n'
      + '  client-side route work on reload and on a deep link. A soft 404 on a host that is\n'
      + '  already noindex costs nothing.');
  }
}

if (problems.length) {
  console.error(`check:noindex-posture FAILED — ${problems.length} problem(s).\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  console.error('  The live host is a separate question: run `npm run check:live-seo`.');
  process.exit(1);
}
console.log('check:noindex-posture passed: X-Robots-Tag noindex on /*, a real robots.txt that still\n'
  + `  allows crawling, the meta tag in all ${HTML_ENTRIES.length} HTML entries, and the SPA catch-all intact.`);
