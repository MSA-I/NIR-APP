# SupplyFlow improvement campaign — agent handoffs

תאריך: 09.08.2026. זהו handoff מתואם של עבודת הסוכנים; מצב release בפועל נשאר בדוח
`docs/IMPROVEMENT-CAMPAIGN-2026-08.md` ואינו נגזר מן הסיכומים כאן.

## Agent 1 — Product & Architecture Lead

- **מה/למה:** מיפה את PRODUCT/ARCHITECTURE/OPEN-DECISIONS/DEBT/Plans/handoff, את המיגרציות,
  ה־QA והקשרים בין workstreams; קבע DB contracts לפני UI ושמר החלטות מוצר פתוחות מחוץ לקוד.
- **קבצים:** `docs/ARCHITECTURE.md`, `docs/OPEN-DECISIONS.md`, `docs/CURRENT-STATE.md`, דוח הקמפיין.
- **מיגרציות/בדיקות:** סקר את `0100`–`0111` ואת P16–P25; לא יצר migration עצמאי.
- **הנחות/פתוח/סיכון:** #124–#129 ו־#131 הן הכרעות owner; #130 נשאר fail-closed ופתוח.
- **אימות:** cross-check תיעוד מול קוד ומיגרציות; ביקורת ארכיטקטונית חוזרת לאחר specialist work.

## Agent 2 — Database / Supabase / Security

- **מה/למה:** מסר את גבולות השרת ל־rollback/Shadow, ספק inactive, finance supplier, branding,
  3-way, dashboard, Trial, supplier portal ומלאי; חיזק scope/body-hash בלי להחליש RLS.
- **קבצים/מיגרציות:** `supabase/migrations/0100_*` עד `0111_*`, `scripts/check-exemption-pin.ts`,
  `scripts/check-p0-security.ps1`, `scripts/check-quality-gates.ps1`.
- **בדיקות:** P16–P25, לרבות P20B concurrency, tenant/role/idempotency/financial boundaries.
- **הנחות/פתוח/סיכון:** אין packaging conversion בלי יחס מאושר; snapshot אישור ממשיך לצרוך
  כמות ב־investigation עד הכרעת #130. הכרעת #131 נמסרה ב־`0111` כ־read-only, חלונות
  ביטול/הפעלה מחדש, export עמיד ו־retention fail-closed ללא purge עיוור.
- **אימות:** reset מקומי ומבחני DB ממוקדים; תוצאת השער המלא נרשמת בדוח בלבד.

## Agent 3 — Document AI / Automation

- **מה/למה:** הוסיף calibration corpus, Shadow, structural drift, observability, reprocess ו־batch
  rollback; הרחיב את חוזה חילוץ שורות החשבונית והצמיד אותו ל־0092.
- **קבצים/מיגרציות:** `0100`, `0103`, `interpret-document/core.ts`, בדיקות core/authorization,
  `DocumentOperations.tsx` ומודל התפעול.
- **בדיקות:** P18/P18 concurrency, P20, Deno core/authorization, contract tests למסמכים.
- **הנחות/פתוח/סיכון:** אין thresholds מספריים אוטומטיים; prompt `interpret-document-v9` דורש
  מדידת corpus חי ואינו הוכחת ציות מודל בפני עצמו.
- **אימות:** בדיקות חוזה/נרמול וסקירת evidence immutable; אינטגרציית מודל חיה אינה מפוברקת.

## Agent 4 — Frontend / UX

- **מה/למה:** חיבר מרכז תפעול מסמכים, review שורות/3-way, finance supplier, supplier orders,
  inventory, branding/recovery, lifecycle banners ומצבי offline בעברית RTL.
- **קבצים:** `src/App.tsx`, `InvoiceDetail.tsx`, `InvoiceLineReviewModal.tsx`,
  `DocumentOperations.tsx`, `FinancialSupplier.tsx`, `Inventory.tsx`, `Admin.tsx`, `Settings.tsx`.
- **מיגרציות:** צורך את `0103`–`0111`; אינו מסמיך את הדפדפן לכתיבה פיננסית ישירה.
- **בדיקות:** Vitest contracts, desktop/mobile fixtures, RTL/a11y/browser scenarios.
- **הנחות/פתוח/סיכון:** unknown=`—`, measured zero=`0`; UI ה־offboarding נצמד לפקודות שרת של `0111`.
- **אימות:** typecheck/build, fixtures חזותיים וביקורת QA נפרדת; live browser נרשם בדוח בלבד.

## Agent 5 — Offline / PWA / Reliability

- **מה/למה:** השלים app shell סטטי, drafts/queue ב־IndexedDB, photos כ־Blob, claim אטומי,
  object key יציב, conflict/retry states וסנכרון שאינו מציג הצלחה offline.
- **קבצים:** `public/sw.js`, `offlineDb.ts`, `offlineQueue.ts`, `FileUpload.tsx`, `Receiving.tsx`,
  `OfflineQueueStatus.tsx`, מסמכי offline ותרחישי QA.
- **מיגרציות:** אין mutation DB חדש מחוץ לפקודות הקבלה הקיימות.
- **בדיקות:** unit/component ותרחישי network-loss, refresh, duplicate retry, conflict ו־peer tab.
- **הנחות/פתוח/סיכון:** אין cache ל־API/finance; lease תמונה 15 דקות ללא heartbeat הוא חוב P2 #27.
- **אימות:** specialist review + adversarial cross-tab review; gate browser מלא בדוח.

## Agent 6 — Integrations / Platform

- **מה/למה:** שמר outbox asynchronous והקשיח signing/retry/dead-letter/monitoring; חיבר Trial
  30+7/read-only, branding tenant-safe ו־server access preflight.
- **קבצים/מיגרציות:** `outbox-worker/*`, shared Edge access guard, `0105`, `0108`, Supabase config.
- **בדיקות:** outbox/Edge tests, P19/P22, storage/lifecycle/tenant checks.
- **הנחות/פתוח/סיכון:** Live Integration Proof הוא `DEFERRED` לפי הכרעת #128; אין יעד/credentials
  מומצאים. offboarding/export נמסר ב־`0111` וב־`tenant-export` ואינו הוכחת אינטגרציה לצד ג׳.
- **אימות:** adapters מקומיים ו־managed-local בלבד; אין טענת delivery לצד ג׳ אמיתי.

## Agent 7 — QA / Adversarial Reviewer

- **מה/למה:** תקף tenant/role/finance, cumulative 3-way, mixed manual match, server clock Trial,
  dashboard zero/unknown, inactive supplier, inventory incoming ו־offline cross-tab.
- **קבצים/מיגרציות:** review בלבד; ממצאיו הובילו לתיקונים ב־0106/0107/0108/0110/0111 וב־UI/Edge/tests/docs.
- **בדיקות:** diff review, `git diff --check`, ארבעה artifacts desktop/mobile; לא הריץ quality בעצמו.
- **הנחות/פתוח/סיכון:** אין P0 ידוע פתוח. האישור הסופי ממתין לסגירת ממצאי export/OCR ולהרצת ה־gates מחדש.
- **אימות:** לא קיבל טענת מיישם; כל ממצא נסגר בראיית קוד/בדיקה או נשאר מפורש.

## Agent 8 — Release Reviewer

- **מצב:** `PENDING` עד quality מלא, ביקורת QA סופית ו־diff קפוא.
- **חובה לפני אישור:** migration order, secrets/config, Edge/cron/storage/frontend, rollback,
  clean tree, exact SHA, production deployment ו־live verification.

## Late acceptance addendum — Agent 3 / tenant export and document reliability

- **What changed / why:** separated OCR evidence persistence from business application, added
  evidence-only recovery for interrupted interpretation settlement, and kept the worker ACK plus
  heartbeat alive through the final completion/failure receipt. Tenant offboarding export now
  snapshots tables and Storage metadata in bounded durable batches before any part claim, emits
  byte-bounded table parts incrementally, and publishes a paged root manifest instead of one
  unbounded artifact array. Download access is fail-closed: root/page bytes are size-and-SHA
  verified, artifact handoff requires manifest-page membership and a side-effect-free DB resolve,
  and the access audit must commit before a response or redirect is returned.
- **Files touched:** `supabase/functions/document-processing/index.ts`,
  `supabase/functions/document-processing/contract.ts`,
  `supabase/functions/interpret-document/index.ts`,
  `supabase/functions/interpret-document/core.ts`, `worker/ocr/src/worker.py`,
  `worker/ocr/src/gateway.py`, `supabase/functions/upload-organization-logo/*`,
  `src/lib/organizationBranding.ts`, `supabase/functions/tenant-export/index.ts`,
  `supabase/functions/tenant-export/core.ts`, tenant-export contract tests, OCR/document contract
  tests, and `scripts/check-quality-gates.ps1`.
- **Migrations:** no migration owned by this addendum. The Edge export contract depends on the
  final `0111_tenant_offboarding_export.sql` RPCs and exact receipts. OCR evidence limits depend on
  the final document egress contract in the database campaign migrations.
- **Tests added / verification:** tenant-export paged-manifest and wiring tests cover snapshot
  before claim, 50-row/1-MiB batching, 26-MiB single-record ceiling, incremental JSON/CSV output,
  exact part paths, root/page byte verification, mandatory access UUIDs, page membership, link
  revalidation, and audit-before-response/redirect. Focused result: 11/11 tenant-export Deno tests
  passed; tenant-export Deno typecheck and format check passed. Earlier focused results: 73/73
  document/branding Deno contracts passed, organization-branding Vitest 4/4 passed, TypeScript
  typecheck passed, and the OCR container self-check passed. Full quality must be rerun after the
  final DB freeze; only the final campaign report may claim its result.
- **Assumptions / unresolved decisions:** no external live-integration target or credentials were
  invented; live integration proof remains explicitly deferred. Access receipts are exact and
  return only the counter matching the access kind: `portal_open_count`, `download_count`, or
  `artifact_link_issued_count`. Root JSON is `manifest_downloaded`, verified page JSON is
  `manifest_page_downloaded`, and only the HTML surface records `portal_opened`. The exported HTML
  portal is a standalone CSP-isolated recovery
  surface and intentionally does not load the application design bundle.
- **Risks:** DB/Edge receipt drift is release-blocking and must be caught by the post-freeze P25
  suite plus the tenant-export Deno gate. Runtime behavior remains unproved until the fresh local
  reset/database suites and complete quality gate finish. No staging, commit, push, migration, or
  deployment was performed by this specialist.
