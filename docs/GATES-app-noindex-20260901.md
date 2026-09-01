# Gates: the application host stops competing with the marketing site for the brand name

Execution branch: `claude/app-inplace-seo-indexing-75b417`, cut from `main` (`05c1b5a7`).

Scoped to its own file rather than to the repository's `GATES.md`, which currently carries the
currency-tolerances campaign and is contended by other worktrees. Same convention as
`docs/GATES-admin-console-20260828.md`.

**Zero product code.** No `src/`, no migration, no Edge function, no dependency. The change is
two static files in `public/`, one meta tag in two HTML entries, two guard scripts, and the
wiring that makes them run.

---

## What was measured, before anything changed

`https://app.inplace.digital`, 01.09.2026, read-only GETs:

| path | status | content-type | `X-Robots-Tag` |
|---|---|---|---|
| `/` | 200 | `text/html` | absent |
| `/login` | 200 | `text/html` | absent |
| `/suppliers` | 200 | `text/html` | absent |
| `/operator` | 200 | `text/html` | absent |
| `/portal` | 200 | `text/html` | absent |
| `/robots.txt` | 200 | **`text/html`** | absent |
| `/sitemap.xml` | 200 | `text/html` | absent |
| `/this-page-does-not-exist-xyz` | 200 | `text/html` | absent |

The same eight, identically, on `https://supplyflow-baq.pages.dev` — the same Cloudflare Pages
project under its own address, which nobody remembers is also indexable. `<meta name="robots">`
was absent from the served HTML of every entry except `/portal`. The served `<title>` was the bare
brand term. Machine-readable record: `artifacts/seo-noindex/live-seo-posture-20260901-before.json`
— 32 failures across 16 URLs.

**The one assumption the whole fix rests on, and it is measured rather than assumed.** Cloudflare
Pages serves a file that exists in the published output before it applies the `/*` catch-all in
`_redirects`. On the live host, right now, with that catch-all in force:

```
/favicon.ico          200 image/vnd.microsoft.icon
/favicon.svg          200 image/svg+xml
/manifest.webmanifest 200 application/manifest+json
/sw.js                200 application/javascript
/apple-touch-icon.png 200 image/png
```

Five root-level files, five real content types, none of them swallowed into the shell.
`robots.txt` now occupies exactly that position in `dist/`.

### What Search Console actually held — measured after the fix was written

Read on 01.09.2026 from `sc-domain:inplace.digital` (a domain property, so it covers the
subdomain), at the owner's request and with the owner's session. Read-only.

| | |
|---|---|
| pages indexed, whole domain | **2** |
| which | `https://app.inplace.digital/` and `http://app.inplace.digital/` — the home page, twice |
| internal screens indexed | **none**; `/suppliers` and every other route: absent |
| not-indexed with a reason | 0 |
| impressions, 90 days | **2**, both on 29.08.2026 |
| clicks | **0** |
| average position | **42** |
| removal requests on file | none in six months |

**This corrects the premise the campaign was opened on, and the correction matters.** The brief
said the application was "outranking the marketing site for the company's own brand name". The
first half is true in the sense that matters — the application is the only thing Google shows
for this domain — but not because it is strong: **`inplace.digital` is not in the index at all,
zero pages and zero impressions.** It was a race with one runner. The application's own showing
is two impressions at position 42 with no clicks.

So the exposure this campaign closes is real but **potential rather than realised**: every route
was open to indexing, and one page had been taken. Nothing internal leaked. The fix is still
correct — an application behind a login has no business being crawlable — but its urgency is
lower than the brief assumed, which is an argument FOR the owner's decision to let it ride with
the `0243`–`0267` rollout rather than shortcut it through Cloudflare.

The marketing site's absence from the index is a larger problem than this one and is explicitly
out of scope. Recorded in `DEBT §89` with the one-minute check that would tell the two possible
causes apart, and left for the owner.

---

## Phase 1 — the header, which is the primary instruction

- [x] P1-G1: `X-Robots-Tag: noindex, nofollow` is declared for `/*`, not for a subset
  CHECK: `public/_headers` parsed as Cloudflare Pages parses it — unindented `/`-line opens a
  rule, indented lines are its headers
  EXPECT: exactly one rule, pattern `/*`, carrying `X-Robots-Tag` with `noindex`
  EVIDENCE: `node scripts/check-noindex-posture.mjs` green. The negative control is real: with
  `NOINDEX_POSTURE_INJECT=narrow-header` the rule becomes `/login` and the guard exits 1 with
  "declares no `/*` rule".

- [x] P1-G2: it survives the build into the published output, byte for byte
  CHECK: `npm run build`, then `cmp public/_headers dist/_headers`
  EXPECT: identical
  EVIDENCE: identical. Vite copies `public/` verbatim; the file needs no plugin and no config.

- [x] P1-G3: the header is chosen over the meta tag for a stated reason, not a stylistic one
  EVIDENCE: written into `public/_headers` itself. A crawler that fetches the document and never
  executes the bundle still reads a response header — this is a single-page application. And the
  catch-all answers paths that were never pages: `/sitemap.xml` was requested 15 times in 24
  hours per Cloudflare AI Crawl Control, every time with an HTML document. A `/*` header covers
  those; a tag inside `index.html` covers them only by accident.

---

## Phase 2 — a real `robots.txt` that still ALLOWS

- [x] P2-G1: the file exists, instructs everyone, and permits crawling
  CHECK: `public/robots.txt`
  EXPECT: a `User-agent: *` group with `Allow: /`, and no blanket `Disallow`
  EVIDENCE: both present. The guard fails the file if the `User-agent` group is missing.

- [x] P2-G2: the reason for the `Allow` is in the file, where the next reader will find it
  EVIDENCE: four comment lines. Without them the `Allow` reads as an oversight and the next
  person "fixes" it — which is the failure this campaign exists to prevent, not a hypothetical.

- [x] P2-G3: **the ordering rule is enforced by something, not just written down**
  CHECK: `NOINDEX_POSTURE_INJECT=disallow` (blanket `Disallow: /`, no observation recorded)
  EXPECT: exit 1, naming `INDEX-CLEARED`
  EVIDENCE: exits 1 and prints the reasoning — a disallowed page is never fetched, so the
  crawler never sees the `noindex`, and already-indexed URLs persist as bare links.
  **And the escape hatch is proven OPEN:** `NOINDEX_POSTURE_INJECT=disallow-cleared` adds a
  `# INDEX-CLEARED: <date> <observer>` line and the guard passes. A guard that forbade the
  correct end state unconditionally would be a trap discovered on the day it mattered.

- [x] P2-G4: it lands in the published output
  EVIDENCE: `cmp public/robots.txt dist/robots.txt` identical; `dist/robots.txt` sits beside
  `favicon.ico` and `sw.js`, whose live behaviour is measured above.

---

## Phase 3 — the meta tag, as belt and braces

- [x] P3-G1: all three HTML entries carry it
  CHECK: `index.html`, `operator.html`, `portal.html`, and the built copies of each
  EXPECT: `<meta name="robots" content="noindex, nofollow" />`
  EVIDENCE: `portal.html` had carried it since it shipped; the tenant shell and the operator
  console had nothing, and now do. All three `dist/*.html` carry it. The guard fails when any one
  loses it (`NOINDEX_POSTURE_INJECT=no-meta`).

---

## Phase 4 — the catch-all is deliberately left alone

- [x] P4-G1: `/* /index.html 200` survives, and a guard says so out loud
  CHECK: `public/_redirects`; `NOINDEX_POSTURE_INJECT=no-catchall`
  EXPECT: present on the real tree; exit 1 when removed
  EVIDENCE: both. Manufacturing a real 404 by breaking that rule is the tempting third fix and
  the wrong trade: the rule is what makes client-side routing work on reload and on a deep link,
  and on a host that is already `noindex` a soft 404 costs nothing. The guard's failure message
  says this, so the next person to try it is argued with rather than merely blocked.

---

## Phase 5 — the guards are themselves guarded, and they are wired

- [x] P5-G1: every posture rule fails on a broken input
  CHECK: `node scripts/check-gate-controls.mjs`
  EXPECT: six mutations rejected, two correct trees accepted
  EVIDENCE: `check:noindex-posture` section — 8 controls, all green, inside a run of **35
  controls total, exit 0**.

- [x] P5-G2: the guard is reachable, and deleting the wiring fails the build
  CHECK: the wiring proof in `check-gate-controls.mjs`
  EXPECT: `check:noindex-posture` present as an npm script, inside `verify`, and as a
  `build.yml` step
  EVIDENCE: "all 7 guards reachable from package.json and build.yml" — 6 before this campaign.

- [x] P5-G3: CI classifies the new inputs, **measured by replaying the classifier**
  CHECK: the classifier's own regex assignments were extracted verbatim from `build.yml` and run
  against fabricated changed-file lists — the verdict comes from the workflow, not from a copy
  of it. The same probe was run against `git show HEAD:.github/workflows/build.yml` as the
  negative control.
  EXPECT: after — `noindex=true`, `verify=true`; before — `verify=false`
  EVIDENCE: exactly that.

  | changed file | before | after |
  |---|---|---|
  | `public/_headers` | `build=true verify=false` | `build=true verify=true noindex=true` |
  | `public/robots.txt` | — | `verify=true noindex=true` |
  | `index.html` | — | `verify=true noindex=true` |
  | `docs/PROGRESS.md` | — | `verify=true noindex=false` |

  So before this campaign a `public/_headers`-only change ran **no guard at all**: the file was
  a `build` input and nothing else. That is the hole the wiring closes, and it is the hole a
  future "just tweak the headers" commit would have fallen into.

- [x] P5-G4: the whole of `npm run verify` still passes, and the one red part is measured
  EVIDENCE: **all 21 static guards green**, including Knip (exit 0, five pre-existing
  configuration hints unchanged) and `npm run build` (typecheck, three entries, service worker,
  119 precache entries). Vitest reported **14 failed / 2135 passed across 5 files** — and that is
  machine contention, measured rather than asserted:

  - this campaign changes **zero files under `src/`**, so no product code under test moved;
  - 11 of the 14 failures are `Test timed out in 5000ms`, and the run's own numbers give it away:
    148s wall against 792s of environment time and 315s of setup, i.e. heavy parallel load
    (nineteen sibling worktrees on this machine);
  - `src/lib/p2Reliability.spec.ts` is among the five, and it is the known contention canary;
  - **re-run in isolation, the same five files pass 56/56 in 17 seconds.**

  Not a regression, and not this branch's. Not "extend the timeout" either.

---

## Phase 6 — the live check, which is the point of the whole exercise

- [x] P6-G1: the claim about production is measured against production
  CHECK: `npm run check:live-seo`
  EXPECT: today, FAIL — with the exact reason, on both origins
  EVIDENCE: 32 failures across 16 URLs, and the distribution proves the check discriminates
  rather than blanket-failing: `/portal` reports **one** failure (the missing header) because it
  already carries the meta tag, `/robots.txt` reports **three** (header, `text/html`, and the
  HTML-document rule catching the shell it is served as), everything else reports two.

- [x] P6-G2: it compares the served bytes against the repository, not against a pinned string
  EVIDENCE: `expectedRobots` is read from `public/robots.txt` at run time. This is the marketing
  repository's lesson made structural: a gate that asserts a property of a file in the repository
  can be green while the host serves something else. It also means the eventual flip to
  `Disallow: /` needs no edit to the script and still cannot drift unnoticed.

- [x] P6-G3: it runs on a schedule rather than by hand, once
  EVIDENCE: `.github/workflows/live-seo-posture.yml` — daily plus `workflow_dispatch`, uploads
  the observations as an artifact, needs no `npm ci` because the script uses only Node built-ins.
  It is deliberately NOT a pull-request check: a PR cannot change what production serves.

- [ ] **P6-G4: the live host actually carries the header. NOT MET, AND NOT MINE TO MEET.**
  This is a frontend deployment, and a frontend deployment from this tree is currently unsafe
  for a reason that has nothing to do with SEO — see below. `npm run check:live-seo` is red
  today, on purpose, and turns green on the deploy without any further edit.

---

## What is not done, stated plainly

**The fix is inert until a frontend deployment.** Cloudflare Pages publishes a directory; there
is no way to add two files to an existing deployment. So `app.inplace.digital` is still fully
indexable as of this commit, and `check:live-seo` still fails.

**Why this branch was not deployed.** Measured, not assumed: the production migration ledger
head is `0242` while this tree carries migrations through `0267` (`docs/PROGRESS.md`; the
31.08.2026 read-only measurement against `rkftlbctohswhbbiaqin`). Deploying this tree's frontend
would put a bundle that expects twenty-five unapplied migrations in front of the production
database. The three static files are harmless; the bundle they would travel with is not. The
deploy belongs to the pending `0243`–`0267` rollout, whose mandatory order is migrations → Edge →
frontend, and which is an owner decision (`OPEN-DECISIONS #56`: production authorisation is
required, and a local PASS is never a deploy approval).

**Not attempted, and it is the owner's:** the Search Console `Removals → Temporary removals`
request for the URLs already in the index. Without it they leave at the next crawl rather than
promptly.

**Deliberately not changed:** `public/_redirects` (P4-G1), the `<title>` (once the host is
`noindex` it leaves the index and stops competing; changing it would alter the browser tab and
the organisation-name prefix `AuthContext` applies, for no additional gain), and
`<link rel="canonical">` (Google ignores a canonical on a `noindex` page, and pointing the
application at the marketing site would assert an equivalence that is not true).
