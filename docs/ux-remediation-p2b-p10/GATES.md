# Gates: UX remediation P2b-P10

OWNS: docs/UX-REMEDIATION-DOCUMENTS-20260904.md, docs/UX-REMEDIATION-REVIEW-LOG-20260904.md, docs/ux-remediation-p2b-p10/**, DESIGN.md, src/App.tsx, src/index.css, src/components/assistant/**, src/components/document-review/**, src/components/QuickCreateSupplier.tsx, src/components/QuickSupplierPicker.tsx, src/components/DocumentStatusBadge.tsx, src/components/FileUpload.tsx, src/components/UploadCenter.tsx, src/pages/DocumentsInbox.tsx, src/pages/DocumentReview.tsx, src/pages/PriceLists.tsx, src/lib/assistant/**, src/lib/documentStatus.ts, src/lib/useDocumentProcessing.ts, src/lib/i18n/dictionaries/he.ts, src/lib/i18n/dictionaries/en.ts, src/**/*.spec.ts, src/**/*.spec.tsx, scripts/check-ux-remediation-p2b-p10-browser.cjs, scripts/check-ux-remediation-p3-browser.cjs, scripts/check-ux-remediation-p4-browser.cjs, scripts/i18n-baseline.json, supabase/migrations/**, supabase/tests/**, supabase/functions/assistant/**, scripts/check-quality-gates.ps1, artifacts/ux-remediation-p2b-p10/**

Scope: complete every authorized package from P2b through P10, excluding cancelled P7 and P4b, then prove local integration, CI, rollout and live behavior required by each changed surface.

- [x] G0: the execution plan reflects all 16 owner decisions before product code changes
  EVIDENCE: main plan now removes P7/P4b from the DAG, fixes P3 order behavior, locks P4 document-level feedback, expands P5 progress, and applies P9 decisions #368-#372.

- [x] P2B1: P2b replacements preserve evidence and reduce controls, panels and text in both viewports
  CHECK: npm.cmd run test -- src/lib/documentStatus.spec.tsx src/pages/documentsArchiveView.spec.tsx src/components/UploadCenter.spec.tsx src/components/document-review/DocumentReviewWorkspace.spec.tsx src/components/document-review/DocumentExportPreview.spec.tsx src/components/document-review/PriceListReviewConfirmation.spec.tsx
  EXPECT: passed
  EVIDENCE: focused Vitest passed 93/93; browser measured folder controls 24->23 desktop and 21->20 mobile, review panels 10->9 and text blocks 35->34; source-line evidence, static/live status and export-template disclosure tests passed.

- [x] P2B2: legacy /inbox filing link reaches the equivalent processing filter result
  EVIDENCE: desktop and mobile browser runs reached /documents?processing=unassigned, selected the visible unassigned filter and rendered no filing filter; direct legacy unfiled token maps to unassigned in documentStatus tests.

- [x] P3A: a document without a supplier can select or create one and then approve through protected commands
  CHECK: npm.cmd run test -- src/components/document-review/supplierResolutionUx.spec.tsx
  EXPECT: passed
  EVIDENCE: supplierResolutionUx passed 6/6; the wider affected set passed 109/109. Desktop and mobile browser selected an existing supplier, required confirmation of the machine-read name, created through create_supplier_from_document with reason and idempotency key, then sent the created supplier through apply_reviewed_document.

- [x] P3B: supplier creation and resolution DB contracts pass tenant, role, replay, audit-reason and zero-write denial cases
  EVIDENCE: p109 passed five cases against Postgres before and after a clean 0001-0316 reset: owner create, same-result replay, changed-payload conflict, role/reason/cross-tenant zero-write refusals, non-null supplier audit reason, grants and one bounded read. Supabase advisors added no 0316-specific finding. Demo restore then proved owner, office and accountant sign-in plus profiles.

- [x] P3C: supplier_unresolved is read in the folder UI; order warnings name cancelled, closed and fully received states; credit still requires its source invoice
  EVIDENCE: unit/browser evidence shows one get_document_folder_review_states call for all visible ids, a visible supplier-not-identified badge, every scoped supplier/currency order without a status filter, named cancelled/closed/fully-received warnings, and a disabled credit approval after manual supplier selection when source invoice remains unresolved. Desktop/mobile screenshots and p3-metrics.json are under artifacts/ux-remediation-p2b-p10/.

- [x] P4A: training controls are absent and one document-level feedback action persists and rereads its note
  CHECK: npm.cmd run test -- src/components/document-review/documentFeedbackUx.spec.tsx
  EXPECT: passed
  EVIDENCE: documentFeedbackUx passed 2/2 and DocumentReviewProposals passed 5/5. Browser injected live annotation, rule and rule-application rows but rendered none of the training console; exactly one resting action opened one note field, persisted it, refetched and reread the note in desktop and mobile screenshots.

- [x] P4B: document feedback mutation rejects role and cross-tenant access, replays idempotently and audits a non-null reason
  EVIDENCE: p110 passed four Postgres cases: owner create/read, exact replay, duplicate-press collapse, immutable changed-note conflict, accountant/reason/cross-tenant/interpretation zero-write refusals, non-null audit reason and no direct browser DML. The old annotation feedback ledger stayed untouched. Browser RPC body carried document, interpretation, note, stable key and reason.

- [ ] P5A: state matrix maps every state to wait, retry, review, file or explicit no-action without erasing safety distinctions
  CHECK: npm.cmd run test -- src/lib/documentStateRecovery.spec.tsx
  EXPECT: passed
  EVIDENCE: pending

- [ ] P5B: progress strip exposes more real processing states while list badges stay compact
  EVIDENCE: pending

- [ ] P6A: mobile source starts above y=1200, approval follows the source, and page height is at most 3.0 screens; desktop is at most 2.5 screens
  CHECK: npm.cmd run test -- src/components/document-review/documentReviewLayoutUx.spec.tsx
  EXPECT: passed
  EVIDENCE: pending

- [ ] P6B: storage and approval remain two sentences; reconciliation folds only when gap is known, in tolerance and has no missing rung
  EVIDENCE: pending

- [ ] P8A: every failed scan code and unknown fallback has one action or explicit no-action and never shows the corner editor
  CHECK: npm.cmd run test -- src/components/document-review/documentScanRecovery.spec.tsx
  EXPECT: passed
  EVIDENCE: pending

- [ ] P8B: replacement supersedes the old document softly, keeps its source readable, rejects role/tenant violations, replays safely and audits a reason
  EVIDENCE: pending

- [ ] P9A: suggested-question failure recovers without reload; auto-restore occurs only through 10 minutes; suggestions depend on user tenure/data
  CHECK: npm.cmd run test -- src/components/assistant/assistantRemediation.spec.tsx
  EXPECT: passed
  EVIDENCE: pending

- [ ] P9B: product-help answer for unresolved supplier includes a route, authorized roles are checked entry-by-entry, and Fact.as_of is an offset datetime
  EVIDENCE: pending

- [ ] P9C: assistant feedback note is stored and read back
  EVIDENCE: pending

- [ ] P9D: glass, backdrop filters and decorative light bodies are absent; floating panel remains; no AI disclosure was added
  EVIDENCE: pending

- [ ] P10A: final bilingual wording contains no targeted jargon, raw internal error wording or hard-coded Hebrew product copy
  CHECK: npm.cmd run test -- src/lib/i18n/uxRemediationCopy.spec.ts
  EXPECT: passed
  EVIDENCE: pending

- [ ] I1: dictionary, plural, orphan, JSX-space and contrast guards pass
  CHECK: npm.cmd run check:i18n
  EXPECT: passed
  EVIDENCE: pending

- [ ] I2: full local verification passes on the final tree
  CHECK: npm.cmd run verify
  EXPECT: passed
  EVIDENCE: pending; current interim check:migration-numbers correctly reports the reserved 0315 gap from another live branch. Do not reuse that number. Full final-tree verification waits for 0315 to enter the integration base.

- [ ] I3: TypeScript and production bundle pass on the final tree
  CHECK: npm.cmd run build
  EXPECT: built in
  EVIDENCE: pending

- [ ] I4: desktop and mobile browser flows prove all visual and interaction claims with screenshots
  CHECK: node scripts/check-ux-remediation-p2b-p10-browser.cjs
  EXPECT: ux-remediation-p2b-p10 browser passed
  EVIDENCE: pending

- [ ] R1: PR CI passes build, verify, SQL, browser and affected Edge contracts on the final SHA
  EVIDENCE: pending

- [ ] R2: migrations are backed up, dry-run, applied forward-only with ledger and postflight, without replaying prior migrations
  EVIDENCE: pending

- [ ] R3: assistant Edge is deployed and the live unresolved-supplier help call returns an authorized linked answer
  EVIDENCE: pending

- [ ] R4: Pages deployment is canonical main, asset hashes match, changed routes pass desktop/mobile smoke, and live SEO posture passes
  EVIDENCE: pending

- [ ] R5: final diff contains no P7 or P4b implementation and preserves unrelated WIP
  EVIDENCE: pending
