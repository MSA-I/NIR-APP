# Gates: UX remediation P1 + P2a

OWNS: CLAUDE.md, DESIGN.md, docs/UX-REMEDIATION-DOCUMENTS-20260904.md, docs/UX-REMEDIATION-REVIEW-LOG-20260904.md, docs/ux-remediation-p1-p2a/GATES.md, scripts/check-ux-remediation-p1-p2a-browser.cjs, scripts/i18n-baseline.json, src/components/FileUpload.tsx, src/components/Fab.tsx, src/components/QuickCapture.tsx, src/components/DocumentStatusBadge.tsx, src/components/assistant/AnswerView.tsx, src/components/document-review/PriceListReviewConfirmation.tsx, src/components/document-review/ReconciliationStrip.tsx, src/pages/DocumentsInbox.tsx, src/lib/i18n/dictionaries/he.ts, src/lib/i18n/dictionaries/en.ts, src/**/*.spec.ts, src/**/*.spec.tsx

Scope: implement only P1 and P2a from the approved UX remediation plan, preserve every P3+ surface, and collect runtime desktop and mobile evidence.

## Depth Tree

- Leaf A: P1 correctness defects 1.1-1.5, including stable retry records and explicit discard.
- Leaf B: P2a deletions 2.1, 2.3, 2.5, 2.7, 2.8 and 2.10, including the R-1 DESIGN.md reversal.
- Integration: dictionaries, regression suite, browser flows, density counts, screenshots and scope audit.

- [x] G0: the four stale CLAUDE.md claims were re-measured before product code changed
  EVIDENCE: 04.09.2026 at HEAD 8f7296e4: package verify inventory 32 and build.yml verify job inventory 32 with no missing command; npm.cmd run check:contrast exit 0 with 53 text pairs, 7 non-text pairs and 1 direction contract; npm.cmd run check:workflow-triggers exit 0 with 2 unfiltered pull_request triggers; quality-gate.yml workflow_dispatch sets edge, ocr, audit, sql and browser but not render.

- [x] G1: P1 upload recovery fails once, retries successfully, and uploads the original bytes exactly once
  CHECK: npm.cmd run test -- src/components/uploadDocument.spec.ts src/components/DocumentListUploadRecovery.spec.tsx
  EXPECT: passed
  EVIDENCE: focused Vitest passed (uploadDocument + QuickCapture 43/43; P1/P2a group 125/125); full Vitest passed 2415/2415. Browser desktop and mobile each measured one TUS POST, two registration calls, one stable client key and one document id.

- [x] G2: P1 user-visible failures are Hebrew-only and an untouched optional date is sent as null
  CHECK: npm.cmd run test -- src/components/document-review/PriceListReviewConfirmation.spec.tsx src/pages/documentsArchiveView.spec.tsx src/components/DocumentListUploadRecovery.spec.tsx
  EXPECT: passed
  EVIDENCE: component tests passed; both browser metrics record documentDate=null, the visible failure contains the Hebrew recovery sentence, and the browser assertion found no internal code in visible body text.

- [x] G3: P1 retry state is visible, starts no camera action, allows a new batch, and supports discard without deleting a stored source
  CHECK: npm.cmd run test -- src/components/layoutMobileNavigation.spec.tsx src/components/DocumentListUploadRecovery.spec.tsx src/components/quickCaptureQuality.spec.tsx
  EXPECT: passed
  EVIDENCE: DocumentListUploadRecovery proves a second batch leaves the first retry available, discard removes only the browser record, and retry keeps TUS at two uploads for two source files. Mobile browser screenshot mobile-quick-capture-retry.png shows RotateCcw and visible text "ניסיון חוזר (1)" while the accessible name remains explicit.

- [x] G4: all six P2a deletions are absent while stuck status and the assistant disclosure remain usable
  CHECK: npm.cmd run test -- src/components/document-review/reconciliationStrip.spec.tsx src/lib/documentStatus.spec.tsx src/components/document-review/PriceListReviewConfirmation.spec.tsx src/components/assistant/assistantPanel.spec.tsx src/pages/documentsArchiveView.spec.tsx
  EXPECT: passed
  EVIDENCE: focused tests passed 125/125; browser assertions found no payable card, duplicate page meta, row telemetry, receipt revision/idempotency badge or assistant count badge. The stuck label and disclosure contents remained visible.

- [x] G5: desktop browser flow proves P1 recovery, no duplicate upload, null date, P2a removals and the unchanged inbox redirect
  CHECK: node scripts/check-ux-remediation-p1-p2a-browser.cjs --viewport desktop --evidence-dir artifacts/ux-remediation-p1-p2a-20260904/after
  EXPECT: ux-remediation-p1-p2a browser desktop passed
  EVIDENCE: command exit 0 with "ux-remediation-p1-p2a browser desktop passed". Screenshots: desktop-documents.png, desktop-upload-retry.png, desktop-status-list.png, desktop-invoice-review.png, desktop-price-list-receipt.png and desktop-assistant-scope.png.

- [x] G6: mobile browser flow proves the visible retry action and captures every visual P1/P2a state
  CHECK: node scripts/check-ux-remediation-p1-p2a-browser.cjs --viewport mobile --evidence-dir artifacts/ux-remediation-p1-p2a-20260904/after
  EXPECT: ux-remediation-p1-p2a browser mobile passed
  EVIDENCE: command exit 0 with "ux-remediation-p1-p2a browser mobile passed". Screenshots mirror G5 plus mobile-quick-capture-retry.png; visual review confirmed the retry label fits below the puck.

- [x] G7: before/after density evidence exists for desktop and mobile, with no increase in controls, panels or text blocks
  EVIDENCE: desktop and mobile: invoice review panels 11->10 and text blocks 37->35; price-list text blocks 16->14; controls unchanged (19/17 and 16/14 respectively); status fixture emits zero row telemetry. JSON and screenshots are under artifacts/ux-remediation-p1-p2a-20260904/{before,after}.

- [x] G8: both dictionaries remain structurally valid after orphaned copy is removed
  CHECK: npm.cmd run check:i18n
  EXPECT: passed
  EVIDENCE: check:i18n passed: 62 files, 905 pinned Hebrew lines.

- [x] G9: plural and orphan-key guards pass
  CHECK: npm.cmd run check:plurals
  EXPECT: passed
  EVIDENCE: check:plurals passed: 79 counted phrases; check:orphan-keys also passed in the same final verify.

- [x] G10: orphan-key guard passes
  CHECK: npm.cmd run check:orphan-keys
  EXPECT: passed
  EVIDENCE: check:orphan-keys passed: 5927 leaf keys, no newly stranded key.

- [x] G11: full local verification passes on the final tree
  CHECK: npm.cmd run verify
  EXPECT: passed
  EVIDENCE: npm.cmd run verify exit 0; all 32 commands ran, 48/48 negative gate controls passed, and Vitest passed 226 files / 2415 tests.

- [x] G12: TypeScript and production bundle pass on the final tree
  CHECK: npm.cmd run build
  EXPECT: built in
  EVIDENCE: npm.cmd run build exit 0; tsc --noEmit passed, Vite transformed 3656 modules and generated the PWA bundle.

- [x] G13: final diff contains no P3+ implementation and preserves unrelated untracked WIP
  EVIDENCE: staged allowlist contains 22 implementation/docs/test files plus 25 before/after evidence files; zero unexpected path, zero Supabase/worker/DocumentOperations path, zero unstaged tracked file. Pre-existing untracked WIP was not staged, moved, deleted or edited.
