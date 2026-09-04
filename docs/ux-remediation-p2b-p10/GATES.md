# Gates: UX remediation P2b-P10

OWNS: docs/UX-REMEDIATION-DOCUMENTS-20260904.md, docs/UX-REMEDIATION-REVIEW-LOG-20260904.md, docs/ux-remediation-p2b-p10/**, DESIGN.md, src/App.tsx, src/index.css, src/components/assistant/**, src/components/document-review/**, src/components/DocumentStatusBadge.tsx, src/components/FileUpload.tsx, src/components/UploadCenter.tsx, src/pages/DocumentsInbox.tsx, src/pages/DocumentReview.tsx, src/pages/PriceLists.tsx, src/lib/assistant/**, src/lib/documentStatus.ts, src/lib/i18n/dictionaries/he.ts, src/lib/i18n/dictionaries/en.ts, src/**/*.spec.ts, src/**/*.spec.tsx, scripts/check-ux-remediation-p2b-p10-browser.cjs, scripts/i18n-baseline.json, supabase/migrations/**, supabase/tests/**, supabase/functions/assistant/**, check-quality-gates.ps1, artifacts/ux-remediation-p2b-p10/**

Scope: complete every authorized package from P2b through P10, excluding cancelled P7 and P4b, then prove local integration, CI, rollout and live behavior required by each changed surface.

- [x] G0: the execution plan reflects all 16 owner decisions before product code changes
  EVIDENCE: main plan now removes P7/P4b from the DAG, fixes P3 order behavior, locks P4 document-level feedback, expands P5 progress, and applies P9 decisions #368-#372.

- [ ] P2B1: P2b replacements preserve evidence and reduce controls, panels and text in both viewports
  CHECK: npm.cmd run test -- src/components/document-review/uxRemediationP2b.spec.tsx src/pages/documentsArchiveView.spec.tsx
  EXPECT: passed
  EVIDENCE: pending

- [ ] P2B2: legacy /inbox filing link reaches the equivalent processing filter result
  EVIDENCE: pending

- [ ] P3A: a document without a supplier can select or create one and then approve through protected commands
  CHECK: npm.cmd run test -- src/components/document-review/supplierResolutionUx.spec.tsx
  EXPECT: passed
  EVIDENCE: pending

- [ ] P3B: supplier creation and resolution DB contracts pass tenant, role, replay, audit-reason and zero-write denial cases
  EVIDENCE: pending

- [ ] P3C: supplier_unresolved is read in the folder UI; order warnings name cancelled, closed and fully received states; credit still requires its source invoice
  EVIDENCE: pending

- [ ] P4A: training controls are absent and one document-level feedback action persists and rereads its note
  CHECK: npm.cmd run test -- src/components/document-review/documentFeedbackUx.spec.tsx
  EXPECT: passed
  EVIDENCE: pending

- [ ] P4B: document feedback mutation rejects role and cross-tenant access, replays idempotently and audits a non-null reason
  EVIDENCE: pending

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
  EVIDENCE: pending

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

