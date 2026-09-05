# Gates: UX remediation P2b-P10

OWNS: docs/UX-REMEDIATION-DOCUMENTS-20260904.md, docs/UX-REMEDIATION-REVIEW-LOG-20260904.md, docs/ux-remediation-p2b-p10/**, DESIGN.md, src/App.tsx, src/index.css, src/components/assistant/**, src/components/document-review/**, src/components/QuickCreateSupplier.tsx, src/components/QuickSupplierPicker.tsx, src/components/DocumentStatusBadge.tsx, src/components/FileUpload.tsx, src/components/UploadCenter.tsx, src/pages/DocumentsInbox.tsx, src/pages/DocumentReview.tsx, src/pages/PriceLists.tsx, src/lib/assistant/**, src/lib/documentStatus.ts, src/lib/documentStateRecovery.ts, src/lib/useDocumentProcessing.ts, src/lib/i18n/dictionaries/he.ts, src/lib/i18n/dictionaries/en.ts, src/**/*.spec.ts, src/**/*.spec.tsx, scripts/check-ux-remediation-p2b-p10-browser.cjs, scripts/check-ux-remediation-p3-browser.cjs, scripts/check-ux-remediation-p4-browser.cjs, scripts/check-ux-remediation-p5-browser.cjs, scripts/check-ux-remediation-p6-browser.cjs, scripts/check-ux-remediation-p8-browser.cjs, scripts/check-ux-remediation-p9-browser.cjs, scripts/i18n-baseline.json, supabase/migrations/**, supabase/tests/**, supabase/functions/assistant/**, scripts/check-quality-gates.ps1, scripts/suite-manifest.baseline.json, artifacts/ux-remediation-p2b-p10/**

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

- [x] P5A: state matrix maps every state to wait, retry, review, file or explicit no-action without erasing safety distinctions
  CHECK: npm.cmd run test -- src/lib/documentStateRecovery.spec.tsx
  EXPECT: passed
  EVIDENCE: documentStateRecovery passed 3/3 and the focused status/upload/progress set passed 62/62. All ten canonical states map to wait, retry, review, file or explicit none; failed and stuck remain distinct. Upload states still distinguish stored-without-registry from registered-without-reading, including their different retry safety.

- [x] P5B: progress strip exposes more real processing states while list badges stay compact
  EVIDENCE: DocumentProcessingProgress passed 13/13 and browser captured queued, scan approval, reading, reading-complete/preparing and interpreting in both viewports. Compact list screenshots show two ordinary assignments as the same single-word badge, no loading/unavailable/superseded badges, and no queue jargon. Owner reversal #375 is therefore implemented as more watched-progress states, not fewer.

- [x] P6A: mobile source starts above y=1200, approval follows the source, and page height is at most 3.0 screens; desktop is at most 2.5 screens
  CHECK: npm.cmd run test -- src/components/document-review/documentReviewLayoutUx.spec.tsx
  EXPECT: passed
  EVIDENCE: p6 browser metrics measured mobile source y=270, source bottom=691.8, approval y=1366.3, height=2530/844=2.998 screens; desktop height=1826/900=2.029 screens. Desktop/mobile screenshots show source-first mobile order, side-by-side desktop order and a visibly titled primary-decision boundary. Focused layout/workspace/proposal/page tests passed 81/81.

- [x] P6B: storage and approval remain two sentences; reconciliation folds only when gap is known, in tolerance and has no missing rung
  EVIDENCE: browser counted exactly one stored sentence and one not-approved sentence. Reconciliation tests cover measured zero, in-tolerance nonzero, over-tolerance, unknown and missing-rung cases; only gapKnown && !overTolerance && missing_rungs.length===0 folds. DocumentReview source contains one workspace composition and document type is a compact value row with correction/draft links.

- [x] P8A: every failed scan code and unknown fallback has one action or explicit no-action and never shows the corner editor
  CHECK: npm.cmd run test -- src/components/document-review/documentScanRecovery.spec.tsx
  EXPECT: passed
  EVIDENCE: documentScanRecovery and DocumentReview passed 18/18. The browser exercised corrupt, both size limits, resource failure, timeout, scan-too-small, claim-attempt limit, document-deleted and an unknown worker code in desktop and mobile; each rendered exactly one retry, replacement or explicit no-action, no corner handle and no "read as-is" action. Representative screenshots and p8-metrics.json are under artifacts/ux-remediation-p2b-p10/.

- [x] P8B: replacement supersedes the old document softly, keeps its source readable, rejects role/tenant violations, replays safely and audits a reason
  EVIDENCE: p111 passed five Postgres cases after the exact 0318 file was applied locally: owner and office success, source row retained with deleted_at/deleted_by and unchanged storage path, Storage object retained, replacement active, one reasoned document_superseded audit, exact replay, latest-scan-state enforcement, role/tenant/unit/reason/source/replacement/idempotency denials and zero writes on every refusal. Browser uploaded and registered one replacement, called supersede_failed_document once with a stable key and reason, navigated to the new document and removed the old name from the active list in both viewports. Full clean-chain reset remains R2, not this package claim.

- [x] P9A: suggested-question failure recovers without reload; auto-restore occurs only through 10 minutes; suggestions depend on user tenure/data
  CHECK: npm.cmd run test -- src/components/assistant/assistantRemediation.spec.tsx
  EXPECT: passed
  EVIDENCE: the focused assistant frontend set passed 129/129. Browser forced a suggested-question timeout, kept the exact question in the composer, retried successfully with the navigation-entry count unchanged, auto-restored a five-minute conversation, kept a conversation older than ten minutes in the explicit history list, and switched from usage questions at zero live suppliers to data questions after the same bounded HEAD count reported data. Desktop/mobile screenshots and p9-metrics.json record every state.

- [ ] P9B: product-help answer for unresolved supplier includes a route, authorized roles are checked entry-by-entry, and Fact.as_of is an offset datetime
  EVIDENCE: local implementation is proved: productHelpRegistry/routeAccess tests cover the eight entry-by-entry audience expansions and keep onboarding owner-only; helpAndDrafts passed 17/17 with the unresolved-supplier entry, owner/office link, accountant refusal and each static fact normalized from YYYY-MM-DD to midnight Z; browser rendered the /documents source and "updated" timestamp in both viewports. Required post-deploy live Edge call remains pending, so this gate stays unchecked.

- [x] P9C: assistant feedback note is stored and read back
  EVIDENCE: client/component tests passed with p_note trimmed into assistant_record_feedback followed by a tenant-scoped assistant_feedback read; browser entered a non-helpful note, captured the RPC body, returned the stored row from the read and rendered that readback in desktop and mobile screenshots.

- [x] P9D: glass, backdrop filters and decorative light bodies are absent; floating panel remains; no AI disclosure was added
  EVIDENCE: assistantRemediation source guards and browser DOM/computed-style checks prove zero assistant-gradient/assistant-mote nodes, backdrop-filter none, no AI disclosure, a fixed 24rem desktop card and full-screen mobile surface. The new-check action uses Plus, the panel remains reachable and DESIGN.md/index.css now describe the same opaque Onyx contract. Both viewports were inspected from screenshots.

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
