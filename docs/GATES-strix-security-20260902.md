# GATES — טיפול בדוח האבטחה של Strix (`fix/strix-security-findings`)

Source: Strix white-box report, 2026-09-02 08:10 UTC. Every claim below was re-measured against
this repository before any code moved; the verdict column is the measurement, not the report.

## Verdicts on the report's claims

| # | Report claim | Verdict | Evidence |
|---|---|---|---|
| C1 | Live secrets **in the repository**; scrub history with BFG, force-push, all contributors re-clone | **FALSE** | `git log --all -- supabase/functions/.env .env .env.local supabase/functions/.env.before-assistant-capture` returns nothing: never tracked, never committed, never pushed. |
| C1b | An OpenAI key sits in a `.git/objects` blob | **PARTLY TRUE — local only** | Full object scan found 4 blobs matching `sk-proj-`. Two reachable ones are `supabase/functions/assistant/input-classification.test.ts`, whose value is the fixture `sk-proj-123456`. One (`c9cdaa79`, 465 bytes) is a real `.env` snapshot and is **unreachable** — never in a commit, so never pushed. It dies with `git prune`. |
| 2 | `.env.before-assistant-capture` not covered by `.gitignore` | **TRUE** | `git check-ignore -v` matched `.env.local` (`*.local`) but not the backup. |
| 4 | Remove `text/html` from the upload allowlist | **RIGHT RISK, WRONG FIX** | HTML is a supported document type end to end: migration `0045` allowlists it, `worker/ocr/src/parsers.py:866` parses it, `self_check.py:1964` has an HTML supplier fixture, and `PriceListUpload.tsx:48` accepts it. Dropping it from one client breaks a live intake path and leaves the stored bytes executable anyway. |
| 5 | `htmlEscape()` in `tenant-export/core.ts` is bypassable | **FALSE** | It escapes `& < > " '` with `&` first, and every call site is text content or a double-quoted attribute. `core.test.ts:38` already asserts the full string. |
| 6 | `orderImage.ts:131` assigns unsanitized data to `innerHTML` | **FALSE** | Every interpolation in `templateMarkup` passes through `esc()`. Only gap: `esc` omitted `'`, and no single-quoted attribute exists to exploit it. |
| 7 | `DocumentsInbox` uses a raw value in `ilike` | **TRUE** (impact overstated) | `DocumentsInbox.tsx:183`. `dq` is debounced local input, not a URL parameter as the report states. |
| 8 | SSRF in `render-document`, `tenant-export`, `worker/ocr/self_check.py` | **FALSE** | Every fetch target is built from `Deno.env.get()` config (`RENDER_SERVICE_URL`, `SUPABASE_URL`); no request-body URL is ever fetched. `self_check.py` states it runs with no network at all. |
| 11 | CORS `*` on 2 Edge Functions | **TRUE, and larger than reported** | Six: `admin-provision`, `organization-storage-purge`, `public-signup`, `render-document`, `tenant-export`, `upload-organization-logo`. |
| CVE | `uuid@8.3.2` via `exceljs` | **TRUE, unreachable** | `package-lock.json:11322`. ExcelJS calls `v4()` only; the out-of-bounds write is in `v3/v5/v6` with a buffer argument. |
| 10 | Pin GitHub Actions to SHAs | **TRUE** | 21 uses, 4 distinct actions, all `actions/*` or `supabase/*`. The report's `@v3`/`@main` do not exist here. |

## Gates

- **G1 — the `.env` backup stops existing and cannot come back.** `supabase/functions/.env.before-assistant-capture` deleted after proving it is a strict subset of `supabase/functions/.env` with byte-identical values for all five shared keys; `.gitignore` covers `supabase/functions/.env*` so a future backup cannot be staged.
- **G2 — an uploaded HTML document cannot execute when a reviewer opens it.** All three raw-source popups request the signed URL with `download` for active content types, so Storage answers `Content-Disposition: attachment`. HTML stays a supported intake type. A spec fails if a call site drops the option.
- **G3 — the Inbox refile search escapes LIKE wildcards.** `%`/`_`/`\` in the search box are literals, matching `serverList.ts`. One spec covers the escaper.
- **G4 — no false positive is "fixed".** SSRF, `htmlEscape` and `orderImage` get a measurement in `DEBT-REGISTER.md`, not a change that adds a dependency for nothing.
- **G5 — `npm run build` and `npm run verify` pass in this worktree.**

## Owner decisions — NOT taken here

- **Rotation** of `OPENAI_API_KEY`, `OCR_WORKER_TOKEN`, `INTERPRET_DOCUMENT_CRON_SECRET`. Requires provider consoles. Given C1, no push ever carried them, so this is hygiene, not incident response.
- **`git prune --expire=now`** on the shared clone to drop blob `c9cdaa79`. Repository-wide, and seven worktrees are live.
- **CORS tightening** on six Edge Functions — behaviour change requiring a redeploy.
- **GitHub Actions SHA pinning** — 21 refs, and pinning without Dependabot trades one rot for another.
