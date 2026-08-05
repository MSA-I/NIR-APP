# Third-Party Notices — SupplyFlow

SupplyFlow uses the open-source components listed below. Every entry's license was read from the
package's own `package.json` in `node_modules` at the resolved version, not from a registry summary.

**Policy.** Only permissive licenses (MIT, ISC, BSD, Apache-2.0) are accepted. **GPL, AGPL,
proprietary and source-available code is never copied into the product.** Pre-release dependencies
are not used unless no stable compatible alternative exists and the reason is recorded here.

Last verified: **2026-08-04**, against the resolved tree in `node_modules`.

---

## Runtime dependencies

| Package | Resolved version | License |
|---|---|---|
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `react-router` | 8.3.0 | MIT |
| `@supabase/supabase-js` | 2.110.7 | MIT |
| `@sentry/react` | 10.69.0 | MIT |
| `recharts` | 2.15.4 | MIT |
| `lucide-react` | 0.563.0 | ISC |
| `react-hook-form` | 7.81.0 | MIT |
| `@hookform/resolvers` | 3.10.0 | MIT |
| `zod` | 3.25.76 | MIT |
| `papaparse` | 5.5.4 | MIT |
| `xlsx` (SheetJS CE) | 0.20.3 | Apache-2.0 |

## Build and tooling dependencies

| Package | Resolved version | License |
|---|---|---|
| `vite` | 6.4.3 | MIT |
| `@vitejs/plugin-react` | 5.2.0 | MIT |
| `tailwindcss` | 4.3.3 | MIT |
| `@tailwindcss/vite` | 4.3.3 | MIT |
| `typescript` | 5.8.3 | Apache-2.0 |
| `playwright-core` | 1.62.1 | Apache-2.0 |
| `@types/node` | 22.20.1 | MIT |
| `@types/react` | 19.2.17 | MIT |
| `@types/react-dom` | 19.2.3 | MIT |
| `@types/papaparse` | 5.5.2 | MIT |

### Notes on specific packages

- **`xlsx` (SheetJS Community Edition)** is installed from the vendor tarball
  `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, **not from the npm registry** — SheetJS
  stopped publishing CE to npm. Apache-2.0. Because it is not a registry dependency, `npm audit`
  cannot report advisories for it; upgrades must be tracked manually against the SheetJS changelog.
- **`react-router` 8.3.0** carries the one advisory allowlisted by the quality gate
  (`GHSA-qwww-vcr4-c8h2`, see `scripts/check-quality-gates.ps1:62`). The gate fails closed on any
  other high or critical finding, and also fails if the allowlisted advisory count is not exactly one.
- **`playwright-core`** is a project `devDependency` on purpose. Unlike `playwright`, it does not
  download browsers at install time — the gate launches the system-installed Chrome/Edge. It was
  moved into the repo because the gate had become dependent on a runtime cache outside the repo,
  and a gate that depends on something outside the repo is a gate that can be lost.
- **`react-hook-form` and `@hookform/resolvers` are currently installed but imported nowhere in
  `src/`**, and `zod` is imported in exactly one file (`src/lib/documentExport.ts`). Recorded as
  known dependency debt; removal or adoption is a separate decision.

---

## Planned additions — licenses to verify at install time

These are named in the enterprise foundation plan. **The entries below are intentions, not
verifications.** Each must be checked against its resolved `node_modules/<pkg>/package.json` and
moved into the tables above before the wave that installs it is considered complete, and each must
pass the gate's `npm audit --audit-level=high` step.

| Package | Target version | Wave | Expected license | Purpose |
|---|---|---|---|---|
| `vitest`, `@vitest/coverage-v8` | latest stable | 1 | MIT | Unit/integration test runner |
| `msw` | latest stable | 1 | MIT | Network simulation shared by dev and tests |
| `@testing-library/react`, `@testing-library/user-event` | latest stable | 1 | MIT | Component testing |
| `jsdom` | latest stable | 1 | MIT | DOM environment for tests |
| `@tanstack/react-query` (+ devtools) | **5.101.4** | 1 | MIT | Data fetching, cache, invalidation |
| `@tanstack/react-table` | **8.21.3** | 2 | MIT | Enterprise table engine |
| `react-pdf` | **10.4.1** | 6 | MIT | In-app PDF rendering |
| `tus-js-client` | **4.3.1** | 6b | MIT | Resumable uploads |
| `workbox-*` | latest stable | 8 | MIT | App-shell caching only — never API responses |
| `idb` **or** `dexie` | latest stable | 8 | ISC / Apache-2.0 | IndexedDB for the offline receiving queue |
| `@zxing/browser`, `@zxing/library` | latest stable | 8 | MIT / Apache-2.0 | Barcode scanning pilot, behind a feature flag |

**Version constraints that are decisions, not preferences:**

- **`@tanstack/react-table` must be 8.21.3, not 9.x.** Version 9.0.0 was published on 2026-08-04.
  The brief forbids pre-release dependencies and requires a documented reason for anything that is
  not the stable compatible choice; a major released the same day is not that.
- **Do not install `pdfjs-dist` yourself.** `react-pdf@10.4.1` pins `pdfjs-dist@5.4.296` (Apache-2.0)
  exactly. The current standalone release is 6.2.108, and a second copy in the tree produces a
  worker/API version mismatch. Import `{ pdfjs }` from `react-pdf` and load the worker via `?url`.
- **`pdfjs-dist`'s shipped CSS contains raw hex colour literals.** It must be excluded from the
  zero-hex enforcement grep documented at `DESIGN.md:359`, and the exclusion must be narrow and named
  rather than a relaxation of the rule.

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
