#!/usr/bin/env node
/**
 * check:live-seo — ask the LIVE host, not the build.
 *
 * WHY THIS EXISTS SEPARATELY FROM check:noindex-posture. That guard reads the repository, so the
 * strongest thing it can say is "the tree still says the right thing". The marketing repository
 * shipped exactly that mistake: its build gate asserted a property of a file in the repository
 * while the host served something different for days, and nobody found out until somebody asked
 * the host. So this script asks the host. It reads `public/robots.txt` only to compare the served
 * bytes against it — the repository is the expectation, the response is the measurement.
 *
 * WHAT IT ASSERTS, on every configured origin:
 *   1. every probed path answers with `X-Robots-Tag` containing `noindex`, including the paths
 *      that were never pages — the SPA catch-all answers /sitemap.xml and unknown routes with an
 *      HTML document, and those documents are indexable URLs;
 *   2. /robots.txt is a real file: `200`, `text/plain`, and its body is byte-identical to
 *      public/robots.txt once line endings are normalised. `text/html` there means the catch-all
 *      is still swallowing the request and the fix has not landed;
 *   3. every HTML document served also carries `<meta name="robots" ... noindex>`, which is how a
 *      stale deployment gives itself away: the header can come from configuration, but the tag
 *      can only come from a build that contains it.
 *
 * WHAT IT DOES NOT DO. It never asserts an absence of `Disallow`. Once Search Console reports the
 * URLs gone, `public/robots.txt` legitimately becomes `Disallow: /` — and because assertion 2
 * compares the served body against the repository rather than against a string pinned in this
 * file, that flip needs no edit here and still cannot drift unnoticed.
 *
 * Read-only: GET, no credentials, no cookies, nothing submitted.
 *
 *   node scripts/check-live-seo-posture.mjs
 *   node scripts/check-live-seo-posture.mjs --origins https://app.inplace.digital
 *   node scripts/check-live-seo-posture.mjs --report artifacts/seo-noindex/live-seo.json
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Both hosts are the same Cloudflare Pages project (`supplyflow`), and both were indexable on
// 01.09.2026. Fixing one fixes the other, but only if both are measured — the pages.dev address
// is the one nobody remembers exists.
const ORIGINS = flag('origins', process.env.LIVE_SEO_ORIGINS
  ?? 'https://app.inplace.digital,https://supplyflow-baq.pages.dev')
  .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);

// `/suppliers` is a real internal route; the nonsense path proves the catch-all's invented URLs
// are covered too, and /sitemap.xml is the path crawlers were actually requesting.
const PATHS = ['/', '/login', '/suppliers', '/operator', '/portal', '/robots.txt', '/sitemap.xml',
  '/this-page-does-not-exist-xyz'];

const expectedRobots = readFileSync(path.join(repoRoot, 'public', 'robots.txt'), 'utf8')
  .replace(/\r\n/g, '\n').trimEnd();

/** One GET, with a single retry: a 5xx or a dropped connection is infrastructure, not a verdict. */
async function probe(url) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'inplace-live-seo-check (+repo scripts/check-live-seo-posture.mjs)' },
        signal: AbortSignal.timeout(20000),
      });
      const body = await response.text();
      if (response.status >= 500 && attempt === 1) {
        await new Promise((r) => { setTimeout(r, 3000); });
        continue;
      }
      return {
        status: response.status,
        finalUrl: response.url,
        contentType: response.headers.get('content-type') ?? '',
        xRobotsTag: response.headers.get('x-robots-tag'),
        body,
      };
    } catch (error) {
      if (attempt === 2) return { error: error.message };
      await new Promise((r) => { setTimeout(r, 3000); });
    }
  }
  return { error: 'unreachable' };
}

const failures = [];
const observations = [];

for (const origin of ORIGINS) {
  for (const probePath of PATHS) {
    const url = `${origin}${probePath}`;
    const result = await probe(url);
    const record = { url, ...result };
    delete record.body;
    observations.push(record);

    if (result.error) {
      failures.push(`${url}\n      could not be fetched: ${result.error}`);
      continue;
    }

    // 1. the header, everywhere.
    if (!result.xRobotsTag || !/\bnoindex\b/i.test(result.xRobotsTag)) {
      failures.push(`${url}\n      no \`X-Robots-Tag: noindex\` on the response`
        + ` (got: ${result.xRobotsTag ?? 'the header is absent'}).`
        + '\n      public/_headers declares it for `/*`; if the tree has it and the host does not,'
        + '\n      this build has not been deployed yet.');
    }

    // 2. robots.txt must be a real file, and must match the repository.
    if (probePath === '/robots.txt') {
      if (result.status !== 200) {
        failures.push(`${url}\n      answered ${result.status}, not 200.`);
      }
      if (!/^text\/plain/i.test(result.contentType)) {
        failures.push(`${url}\n      served as \`${result.contentType || 'no content-type'}\`, not text/plain.`
          + '\n      text/html means the SPA catch-all in _redirects is still swallowing the request'
          + '\n      and public/robots.txt is not in the published output.');
      } else if (result.body.replace(/\r\n/g, '\n').trimEnd() !== expectedRobots) {
        failures.push(`${url}\n      the served file does not match public/robots.txt.`
          + '\n      The repository is the expectation and the response is the measurement; if the'
          + '\n      file was deliberately changed, deploy it — do not edit this script.');
      }
    }

    // 3. an HTML document must also carry the tag, which is what proves the BUILD is current.
    if (/^text\/html/i.test(result.contentType)
      && !/<meta\s+name="robots"[^>]*noindex/i.test(result.body)) {
      failures.push(`${url}\n      the served HTML carries no \`<meta name="robots" ... noindex>\`.`
        + '\n      All three HTML entries carry it in the tree, so the deployed build predates it.');
    }
  }
}

const report = {
  observedAt: new Date().toISOString(),
  origins: ORIGINS,
  paths: PATHS,
  observations,
  failures,
  passed: failures.length === 0,
};

const reportPath = flag('report', path.join('artifacts', 'seo-noindex', 'live-seo-posture.json'));
const absoluteReport = path.isAbsolute(reportPath) ? reportPath : path.join(repoRoot, reportPath);
mkdirSync(path.dirname(absoluteReport), { recursive: true });
writeFileSync(absoluteReport, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const o of observations) {
  const tag = o.xRobotsTag ?? '—';
  console.log(`  ${o.error ? 'ERR' : o.status} ${(o.contentType || '').split(';')[0].padEnd(10)} `
    + `x-robots-tag: ${String(tag).padEnd(18)} ${o.url}`);
}
console.log(`\n  report: ${path.relative(repoRoot, absoluteReport).replace(/\\/g, '/')}`);

if (failures.length) {
  console.error(`\ncheck:live-seo FAILED — ${failures.length} problem(s) on the live host.\n`);
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}
console.log(`\ncheck:live-seo passed: ${ORIGINS.length} origin(s) x ${PATHS.length} path(s), every response`
  + '\n  noindex, robots.txt served as text/plain and byte-identical to public/robots.txt.');
