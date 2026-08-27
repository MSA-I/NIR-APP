# Gates: subscription plan contract and application catalogue

Scope: identify and close the forward-only subscription-plan migration gap, then expose the canonical plan benefits and verified billing prices in the authenticated application without publishing prices publicly.

- [x] G1: one repository-owned contract check proves the canonical prices, quotas, introductory window, monotonic capability ladder, and UI source-of-truth wiring
  CHECK: node scripts/check-subscription-plan-contract.mjs
  EXPECT: subscription plan contract verification passed
  EVIDENCE: PowerShell, repository root, exit 0; `subscription plan contract verification passed`.

- [x] G2: the focused subscription UI component and page tests pass
  CHECK: npm.cmd exec vitest run -- src/components/orgSubscriptionPanel.spec.tsx src/pages/pricing.spec.tsx
  EXPECT: Test Files  2 passed
  EVIDENCE: PowerShell, repository root, exit 0; 2 files and 46 tests passed.

- [x] G3: the complete local static and unit verification gate passes
  CHECK: npm.cmd run verify
  EXPECT: Test Files
  EVIDENCE: PowerShell, repository root, exit 0; all static guards passed, 158 files and 1,658 tests passed.

- [x] G4: the production bundle typechecks and builds
  CHECK: npm.cmd run build
  EXPECT: built in
  EVIDENCE: PowerShell, repository root, exit 0; TypeScript clean, 3,347 modules transformed, production and PWA bundles built.

- [x] G5: the new forward-only migration passes its focused SQL suite on a clean compatible database lineage
  EVIDENCE: `0212 -> 0213 -> p79` and `0212 -> 0213 -> p70` each ran in one local PostgreSQL transaction with `ON_ERROR_STOP=1`, emitted their success token, and rolled back.

- [ ] G6: authenticated desktop and mobile subscription screens visually show the canonical plan benefits and only server-authoritative prices; public pricing remains price-free
  EVIDENCE: unmet. First headed run found no Playwright-managed Chromium. Second used installed Chrome but the fixture harness timed out before locating `#email`; no product screenshot was produced.

- [x] G7: final Git diff contains only subscription-contract files and preserves unrelated WIP
  EVIDENCE: isolated worktree `subscription-plans-20260827`; `git diff --check` exit 0; original checkout untouched.

- [ ] G8: every advertised in-product capability has a real runtime consumer or is explicitly identified as an external service boundary
  EVIDENCE: unmet. `history.full` and `notifications.email` are catalogued by 0213 but still have no runtime consumer; `support.premium` is intentionally an external service boundary.
