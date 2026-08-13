# Third-Party Notices — SupplyFlow

SupplyFlow uses the open-source components listed below. Every entry's license was read from the
package's own `package.json` in `node_modules` at the resolved version, not from a registry summary.

**Policy.** Only permissive licenses (MIT, ISC, BSD, Apache-2.0) are accepted. **GPL, AGPL,
proprietary and source-available code is never copied into the product.** Pre-release dependencies
are not used unless no stable compatible alternative exists and the reason is recorded here.

Last verified: **2026-08-13**, against the resolved tree in `node_modules` after `npm ci`.

---

## Runtime dependencies

| Package | Resolved version | License |
|---|---|---|
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `react-router` | 8.3.0 | MIT |
| `@tanstack/react-query` | 5.101.4 | MIT |
| `@tanstack/react-table` | 8.21.3 | MIT |
| `@tanstack/table-core` (dependency of `react-table`) | 8.21.3 | MIT |
| `@supabase/supabase-js` | 2.110.7 | MIT |
| `@sentry/react` | 10.69.0 | MIT |
| `recharts` | 2.15.4 | MIT |
| `lucide-react` | 0.563.0 | ISC |
| `html2canvas-pro` | 2.3.3 | MIT |
| `zod` | 3.25.76 | MIT |
| `papaparse` | 5.5.4 | MIT |
| `react-pdf` | 10.4.1 | MIT |
| `pdfjs-dist` (dependency of `react-pdf`) | 5.4.296 | Apache-2.0 |
| `xlsx` (SheetJS CE) | 0.20.3 | Apache-2.0 |
| `tus-js-client` | 4.3.1 | MIT |
| `idb` | 8.0.3 | ISC |
| `@zxing/browser` | 0.2.1 | MIT |
| `@zxing/library` | 0.23.0 | Apache-2.0 |
| `ts-custom-error` (dependency of `@zxing/library`) | 3.3.1 | MIT |
| `@zxing/text-encoding` (optional dependency of `@zxing/library`) | 0.9.0 | Unlicense OR Apache-2.0 |

## Build and tooling dependencies

| Package | Resolved version | License |
|---|---|---|
| `vite` | 6.4.3 | MIT |
| `@vitejs/plugin-react` | 5.2.0 | MIT |
| `tailwindcss` | 4.3.3 | MIT |
| `@tailwindcss/vite` | 4.3.3 | MIT |
| `typescript` | 5.8.3 | Apache-2.0 |
| `playwright-core` | 1.62.1 | Apache-2.0 |
| `vite-plugin-pwa` | 1.3.0 | MIT |
| `knip` | 6.32.2 | ISC |
| `@types/node` | 22.20.1 | MIT |
| `@types/react` | 19.2.17 | MIT |
| `@types/react-dom` | 19.2.3 | MIT |
| `@types/papaparse` | 5.5.2 | MIT |
| `vitest` | 4.1.10 | MIT |
| `msw` | 2.15.0 | MIT |
| `fake-indexeddb` | 6.2.4 | Apache-2.0 |
| `@testing-library/react` | 16.3.2 | MIT |
| `@testing-library/user-event` | 14.6.3 | MIT |
| `@testing-library/jest-dom` | 7.0.0 | MIT |
| `jsdom` | 30.0.1 | MIT |

### Notes on specific packages

- **`xlsx` (SheetJS Community Edition)** is installed from the vendor tarball
  `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, **not from the npm registry** — SheetJS
  stopped publishing CE to npm. Apache-2.0. Because it is not a registry dependency, `npm audit`
  cannot report advisories for it; upgrades must be tracked manually against the SheetJS changelog.
- **`react-router` 8.3.0** previously triggered `GHSA-qwww-vcr4-c8h2` for an RSC Actions runtime
  SupplyFlow does not install. The quality gate retains a fail-closed exception for that advisory
  alone if a registry reports it; the resolved tree currently returns zero vulnerabilities.
- **`playwright-core`** is a project `devDependency` on purpose. Unlike `playwright`, it does not
  download browsers at install time — the gate launches the system-installed Chrome/Edge. It was
  moved into the repo because the gate had become dependent on a runtime cache outside the repo,
  and a gate that depends on something outside the repo is a gate that can be lost.
- **`knip` is pinned exactly at 6.32.2** and runs as `check:dead-code` inside the build gate. Its
  entrypoints are explicit for the SPA, Vitest, repository checks and Supabase Edge Functions.
- **`@tanstack/react-table` is pinned exactly at 8.21.3, not 9.x.** Version 9.0.0 was published on
  2026-08-04; the brief forbids pre-release/day-old majors without a documented reason. The pin is
  saved exact (no `^`) in `package.json` so a routine install cannot drift onto 9.x. Licenses for
  both `@tanstack/react-table` and its single dependency `@tanstack/table-core` were read from the
  resolved `node_modules` packages (MIT, 8.21.3 each). Installed by wave 2 (table engine).
- **`tus-js-client` is pinned exactly at 4.3.1** (no `^`), installed by wave 6b (Upload Center /
  resumable uploads to the `documents` bucket). License read from the resolved
  `node_modules/tus-js-client/package.json`: MIT.
- **`idb` is pinned exactly at 8.0.3** (no `^`), installed by wave 8 for the offline goods-receiving
  store (`src/lib/offlineDb.ts`). License read from the resolved `node_modules/idb/package.json`:
  ISC. ADR-0006 rejected `localStorage` for this job — synchronous, size-limited, and unable to hold
  the photo Blobs the queue carries — so a real IndexedDB wrapper was required. `idb` has no
  dependencies of its own.
- **The barcode reader is three resolved packages, not two.** Wave 8 installed
  `@zxing/browser@0.2.1` (MIT) and `@zxing/library@0.23.0` (Apache-2.0), both exact; the resolved
  tree also pulled `ts-custom-error@3.3.1` (MIT, a dependency of `@zxing/library`) **and**
  `@zxing/text-encoding@0.9.0` (Unlicense OR Apache-2.0, an *optional* dependency of
  `@zxing/library` that npm installs by default). All four licenses were read from their own
  `package.json` in `node_modules` at the
  resolved version. Every one is permissive.
  `@zxing/library` is ~17MB unpacked, so it is reached only through a dynamic `import()` behind the
  `receiving.barcode` flag and is pinned into its own `barcode` rollup chunk beside recharts
  (`vite.config.ts`) — it never enters the entry graph.
- **`react-pdf` is pinned exactly at 10.4.1** (no `^`), which itself pins `pdfjs-dist@5.4.296`
  exactly. `pdfjs-dist` is **not** a direct dependency and must never become one — see the version
  constraint below. Both licenses were read from the resolved `node_modules` packages: `react-pdf`
  10.4.1 MIT, `pdfjs-dist` 5.4.296 Apache-2.0. The pdf.js worker is loaded via `?url` from the same
  resolved copy (`src/components/document-review/pdfWorker.ts`), so worker and API can never
  diverge. Installed by wave 6 (PDF review).

---

## App-shell caching — no additional package

The current app shell is cached by the repository-owned `public/sw.js`, using the browser Cache API.
It caches only navigation/hashed static assets and explicitly excludes Supabase REST, Functions,
Storage and authentication responses. `workbox-*` was not installed and is no longer a planned
dependency for the implemented contract. The IndexedDB queue continues to use the installed `idb`
package documented above.

**Version constraints that are decisions, not preferences:**

- **Do not install `pdfjs-dist` yourself.** `react-pdf@10.4.1` (installed, wave 6) pins
  `pdfjs-dist@5.4.296` (Apache-2.0) exactly. The standalone release is newer (6.x), and a second
  copy in the tree produces a worker/API version mismatch. Import `{ pdfjs }` from `react-pdf` and
  load the worker via `?url` — done once, in `src/components/document-review/pdfWorker.ts`.
- **`pdfjs-dist`'s shipped CSS contains raw hex colour literals.** Its exclusion from the zero-hex
  rule (`DESIGN.md:359`) is **structural, not an allowlist**: the enforcement script
  (`scripts/check-design-tokens.ts:9-31`) walks `.tsx` files under `src/` only, so third-party CSS
  in `node_modules` never enters the scanned set and no per-file exception exists. Verified at
  wave 6. In practice the app imports no pdfjs stylesheet at all: the viewer renders PDF pages with
  the text and annotation layers disabled (`src/components/document-review/PdfSourceView.tsx`), so
  the hex-bearing CSS stays out of the bundle entirely.

## Evaluated and not installed

| Component | Reason |
|---|---|
| Uppy (full) | Its dashboard UI gives no clear advantage over the existing upload experience; only `tus-js-client` is needed |
| Temporal | No long-running multi-system workflow exists yet that requires it; a `WorkflowEngine` interface with a PostgreSQL implementation covers current needs |
| Novu | Multiple notification channels are not yet required; the existing notification system is the initial `NotificationProvider` implementation |
| Meilisearch | PostgreSQL full-text search plus `pg_trgm` has not been measured as insufficient. Not deployed without evidence |
| `json-rules-engine` in the browser | A browser rules engine is not an authorization boundary. Rules stay server-side |
| Odoo / ERPNext code | Never copied. Integration adapters and external-reference mappings only |
| Radix UI / shadcn (wholesale) | The existing custom UI kit is not replaced. Individual missing primitives may be adapted to the existing design tokens; each such adoption gets its own entry here |

---

## Server-side and worker components

The OCR worker image (`worker/ocr/`) bundles **Tesseract OCR 5.3.0** (Apache-2.0) with the `eng` and
`heb` language artifacts, pinned by SHA-256 and verified by the image's own self-check. Document
transcription in production is performed by the OpenAI API (`gpt-5.6-terra`) — a service, not
bundled code; no OpenAI source is included in the product.
