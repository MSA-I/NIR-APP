# Database / Supabase / Security — Final Handoff

Date: 2026-08-09

## Outcome

The reviewed database merge and focused security gates are green. Upstream migrations 0086–0089
remain unchanged and the improvement-campaign migrations now replay as 0100–0111. The merged
database preserves tenant isolation, reasoned/audited financial commands, supplier isolation,
external-egress evidence, idempotency, and a DB-first document-worker rollout path.

No production migration or deployment was performed by this subagent. Independent release review,
the repository-wide build/quality gates, production preflight, deployment, and live verification
remain mandatory.

## Merge reconciliation

- Resolved supabase/functions/send-invite/index.ts by preserving upstream supplier invitation and
  consent behavior together with campaign lifecycle, external-egress reservation/release, and
  idempotency behavior.
- Supplier invitations require supplierId; non-supplier invitations reject it. The supplier RPC
  overload is selected only for supplier invitations.
- Resolved supabase/tests/p14_apply_interpretation.sql with role switching outside the exception
  subtransaction and the safer p14_capture_error helper. The PostgREST boundary still proves
  browser EXECUTE denial.
- Removed all merge markers from owned files.

## Migration lineage

The campaign migrations were renumbered before deployment:

| Previous | Final | Purpose |
|---|---|---|
| 0086 | 0100 | Document reprocessing and price-list safety |
| 0087 | 0101 | Inactive supplier commerce guards |
| 0088 | 0102 | Scope-enforcement source-marker hardening |
| 0089 | 0103 | Calibration, shadow mode, and document operations |
| 0090 | 0104 | Financial supplier read boundary |
| 0091 | 0105 | Organization branding |
| 0092 | 0106 | Invoice-line 3-way match |
| 0093 | 0107 | Management dashboard snapshot |
| 0094 | 0108 | Trial/grace/read-only enforcement |
| 0095 | 0109 | Supplier purchase-order portal |
| 0096 | 0110 | Inventory intelligence read model |
| 0097 | 0111 | Tenant offboarding/export and worker-egress hardening |

Upstream 0086 item_not_ordered_exception_type, 0087
receipt_credit_automation_and_manual_exceptions, 0088
supplier_bank_details_insert_stepup, and 0089 terms_consent_on_accept replay before 0100 and were
not rewritten.

## Dashboard due-date semantics

Migration 0107 now follows the explicit product decision for overdue payment requests:

- only active requests with an explicit due_date participate in overdue/due-today calculations;
- if at least one active request is dated, the dated subset produces a real numeric result and
  undated active requests do not suppress that measurement; and
- if no active request has a due_date, overdue and dueToday are JSON null so the UI renders “—”,
  never a fabricated zero.

P21 proves both the mixed-coverage case and the zero-dated-evidence case.

## 3-way candidate hierarchy

Migration 0106 no longer combines product, supplier-SKU, and barcode matches with an OR. For each
invoice line it selects candidates only from the first identity level that produces evidence:

1. product_id;
2. supplier SKU;
3. normalized barcode; and
4. relevant remaining quantity among candidates at that same identity level.

Relevant remaining quantity is the lesser of ordered and received quantity, minus quantities from
the latest immutable approval snapshot of every prior non-deleted invoice. Draft/review invoices
do not consume candidate capacity. A same-level tie is resolved only when exactly one candidate is
an exact remaining-quantity match, or—when none is exact—exactly one candidate can carry the line
within the approved quantity tolerance. Otherwise every same-level candidate is retained so the
line becomes review-required. There is no row-order or first-match fallback.

P20 proves conflicting product/SKU/barcode evidence respects the hierarchy, a multi-order line is
assigned when only one remaining balance can carry it, and a non-decisive multi-order tie remains
ambiguous for human allocation.

The duplicate-line identity path is also set-based. invoice_three_way_raw materializes
invoice_line_candidates into an invoice-wide CTE, derives normalized identified products and
candidate counts once, and caches duplicate flags in one JSONB map for the line loop. It also
materializes invoice_effective_line_matches exactly once into a per-assessment JSONB cache reused
by both the line loop and order-item aggregation. The previous invoice_line_identified_product
helper was removed, so neither identity nor effective allocations are recomputed once per line or
line pair. P20 statically asserts that the raw assessment contains exactly one effective-match
helper call and assesses a 40-line duplicate fixture under a five-second statement timeout; the
final EXPLAIN ANALYZE measured 29.117 ms locally and all 40 warning records were preserved. This
timing is local regression evidence, not a production latency SLA.

Invoice header arithmetic is now an independent server-authoritative invariant:

    abs((amount_before_vat + vat_amount) - total_amount) <= 1

A violation adds invoice_header_arithmetic_discrepancy and blocks approval even when the separate
line-to-net, line-to-VAT, and line-grand comparisons are each within one shekel. The check runs
before line-evidence branching, so service-ingested and legacy invoices without line evidence do
not bypass it. P20 proves the 101 + 18 versus 116 example is blocked at the approval command.
It also proves the inclusive boundary: an exact ₪1 header-identity difference does not add the
blocking reason, while any difference greater than ₪1 does.

## Security-definer and scope enforcement

- Registered open_manual_exception(text,uuid,exception_type,text) in the machine-enforced
  SECURITY DEFINER registry only after measuring its post-upstream source.
- Measured PostgreSQL md5(pg_proc.prosrc):
  6f1d9039b9dfeeada46c9ab981e281b0.
- Enforcement kind is assert_unit: the 0087 command locks the exact purchase order/invoice,
  derives the persisted unit, applies scope enforcement, requires a reason, and audits the
  exception.
- private.scope_enforcement_violations() returns 0 rows after the final replay and test run.
- npm.cmd run check:exemptions passes with pin 75 across 9 migrations:
  +19 / -3 over the 0057 seed of 59.
- Supplier agents do not receive raw suppliers table access; their own identity is exposed only
  through the narrow supplier-portal projection.

## OCR evidence and expand/contract rollout

Migration 0111 records attempt-bound OCR evidence before applying public extraction mutations. It
binds tenant, job, processing attempt, document, source checksum, contract, acknowledged egress
lease, worker owner/token, canonical payload hash, and immutable evidence hash.

The JSON extraction size contract is now measured from canonical UTF-8 JSON text with
octet_length(payload::text), not PostgreSQL's binary JSONB storage overhead. An exact 25 MiB
canonical payload is accepted; 25 MiB + 1 byte is rejected.

Evidence-first worker signatures:

    service_record_document_ocr_evidence(
      uuid, uuid, text, uuid, uuid, text, text, text, text, text,
      jsonb, integer, jsonb
    ) -> jsonb

    complete_document_processing_job(
      uuid, uuid, text, uuid, uuid, text
    ) -> jsonb

    service_recover_document_extraction_from_egress(
      uuid, uuid, uuid, text
    ) -> jsonb

Legacy deployed-worker signatures are intentionally retained for the expand phase:

    heartbeat_document_processing_job(uuid, text, integer)
    complete_document_processing_job(
      uuid, text, text, text, text, text, text, jsonb, integer, jsonb
    )
    fail_document_processing_job(uuid, text, text, text)

All worker signatures are SECURITY DEFINER, executable by service_role, and not executable by
authenticated. A legacy/in-flight attempt that has not started managed egress can settle safely
and is audited. Once the attempt has a document_signed_url egress lease, the legacy
heartbeat/complete/fail wrappers reject downgrade with
document_processing_legacy_contract_forbidden.

The old wrappers must be removed only in a later contract migration, after:

1. the evidence-first Edge worker is deployed everywhere;
2. production confirms no legacy version is still calling the old signatures;
3. no pre-egress in-flight attempt needs the bridge; and
4. focused Smart/P25 and live queue checks are rerun.

An earlier read-only production preflight observed 22 total document-processing jobs, 0 queued, and
0 leased. That observation must be refreshed immediately before rollout and is not current
deployment proof.

## Final focused verification

Every SQL suite below was copied byte-for-byte into the local Supabase database container and run
with:

    docker exec -e PGPASSWORD=postgres -e PGTZ=Asia/Jerusalem
      supabase_db_supplyflow-p0 psql -X -q -At -U supabase_admin -d postgres
      -v ON_ERROR_STOP=1 -f /var/lib/postgresql/<suite>.sql

Focused verification completed across clean local replays. The final dashboard-only 0107 change
was followed by a fresh reset and P21 run. The later 0106 candidate-hierarchy change was followed
by another fresh reset, P20, and P20 approval concurrency. The other suites had passed on the
immediately preceding merged 0111 replay and are not consumers of either narrowed contract:

- supabase db reset after the final 0106/0107 changes: PASS; upstream 0086–0089 followed by
  campaign 0100–0111, seed, and container restart.
- p9_five_domains.sql: PASS — p9_five_domains_passed.
- p14_apply_interpretation.sql: PASS — p14_apply_interpretation_passed.
- p17_financial_supplier_view.sql: PASS, exit 0 with ON_ERROR_STOP=1.
- p18_document_automation_calibration.sql: PASS —
  P18 document automation calibration/shadow/operations checks passed.
- p18_price_list_concurrency.sql: PASS —
  P18B concurrent same-document price-list apply checks passed.
- p20_invoice_three_way_match.sql: PASS after the final 0106 change, exit 0 with ON_ERROR_STOP=1;
  identity collisions, independent duplicate-supplier-SKU and duplicate-barcode fixtures,
  wrong-supplier linked order exclusion, unique remaining-capacity selection, unresolved
  multi-order ambiguity, header arithmetic with and without line evidence, approval blocking, the
  exact-₪1 tolerance boundary, single effective-match materialization, and 40-line duplicate scale
  are asserted. The final local EXPLAIN ANALYZE execution time was 29.117 ms.
- p20_invoice_approval_concurrency.sql: PASS —
  p20_invoice_approval_concurrency: all assertions passed, after the final 0106 change.
- p21_dashboard_snapshot.sql: PASS, exit 0 with ON_ERROR_STOP=1; mixed due-date coverage is
  measured from dated rows and zero due-date evidence remains null.
- p22_trial_read_only.sql: PASS, exit 0 with ON_ERROR_STOP=1.
- p23_supplier_portal.sql: PASS, exit 0 with ON_ERROR_STOP=1.
- p25_tenant_offboarding_export.sql: PASS —
  P25 tenant offboarding/export/egress tests passed.
- p7_integration_adapters.sql: PASS — p7_integration_adapters_passed.
- smart_document_processing.sql: PASS — smart_document_processing_passed.
- private.scope_enforcement_violations(): PASS — 0 rows.
- npm.cmd run check:exemptions: PASS — pin 75.
- git diff --check and git diff --cached --check on owned files: PASS.
- Conflict-marker scan on owned files: PASS, no markers.

deno check was not run: Deno is unavailable both on the local host and in the available Edge
container. This handoff does not claim that check passed. Repository-wide npm run build and
npm run quality are release-review gates and are not replaced by the focused database suite.

## Files touched in this merge work

- supabase/functions/send-invite/index.ts
- supabase/functions/admin-provision/index.ts
- supabase/functions/interpret-document/core.ts
- supabase/functions/interpret-document/core.test.ts
- scripts/check-quality-gates.ps1
- supabase/migrations/0100_*.sql through supabase/migrations/0111_*.sql
- supabase/tests/p0_client_dml_acl.sql
- supabase/tests/p14_apply_interpretation.sql
- supabase/tests/p20_invoice_three_way_match.sql
- supabase/tests/p21_dashboard_snapshot.sql
- supabase/tests/p25_tenant_offboarding_export.sql
- supabase/tests/p9_five_domains.sql
- supabase/tests/smart_document_processing.sql
- handoff/improvement-campaign-20260809-db-security-final.md

Technical references were updated to the final migration numbers. General product/release
documentation remains owned by the architecture/release workstreams.

## Frozen file hashes (SHA-256)

    C833EB65D1C9B2B29448603F36407358A3BDA68DAADC1EF17DC6A53D85A842F0 send-invite/index.ts
    AAEA43E775E433203C9ACBB31752B933EBE8196BBF015E0CBF2FD64D619DCAF1 0102_harden_scope_enforcement_source_markers.sql
    2D2E5EB233C1486F54E0823E80A377C4B0FCAF27364C6443D22B5D39AAEB9CDF 0106_invoice_line_three_way_match.sql
    F8D63A81BFD98A83FC295D424C7E7979071232E099EB1E8BC73E76DE08DCAA92 0107_management_dashboard_snapshot.sql
    72C2E727701C69EDB711C18459194C989BF009E845E29901ED8DD1E2B195E788 0111_tenant_offboarding_export.sql
    6051CB95DC05E3C419F3C1BC7EDA1284F8D317A08A134736D8A8B0216D4A4D9F p14_apply_interpretation.sql
    747D7280BE53CD9C59919FC5E9F3FD4F0FBA1FC161916F40D94DDE8E92E127D6 p20_invoice_three_way_match.sql
    ED05FB24047EE809B8F3EC0FAE5683553C011366F150E7A4EE55D6E7EB5A64F6 p21_dashboard_snapshot.sql
    087350CD43E929A053A0788D734BA9A7B438956D2ED03332050BD681CAB744BF p25_tenant_offboarding_export.sql
    0B00F9CEE8C9352DF5FC972604F46625D050408B63F3649ADD5845E96A36E2BB smart_document_processing.sql

Recompute these hashes after any caller-contract, migration, or focused-test edit. A mismatch means
the relevant database gates must be rerun.

## Deployment order and rollback

1. Refresh the production queue/lifecycle preflight and confirm applied migration history.
2. Apply database migrations 0100–0111 in order; do not rewrite upstream 0086–0089.
3. Execute the OCR worker cutover runbook below, then deploy the evidence-first document Edge
   worker and the merged invitation/provisioning functions.
4. Verify new attempts create and acknowledge managed egress before provider access.
5. Run focused production smoke checks for tenant isolation, supplier invitation scope, document
   processing/recovery, 3-way approval boundaries, trial read-only behavior, and outbox retry.
6. Remove legacy worker overloads only in a future contract migration after the expand criteria
   above are proven.

Database rollback is forward-only: disable affected workers/automation, park queued external work,
use the audited application rollback commands where provided, and ship a corrective migration.
Applied migration history must not be rewritten.

### Managed OCR worker cutover runbook

Production currently uses container `supplyflow-ocr-live`. Its recorded image id is no longer in
the local image store, so rollback must be made durable from the running container before it is
replaced.

1. Build the reviewed worker as `supplyflow-ocr-worker:campaign-<release-sha>`, run its self-check,
   and record the image digest. Do not reuse the mutable `acceptance` tag as deployment evidence.
2. Inspect the live container without printing its environment. Record only its image id, restart
   policy, network, mounts and health status. Keep environment values in process memory only.
3. Query production immediately before cutover and require zero `queued` jobs and zero active
   leases/egress leases. If any row is active, wait for it to settle; do not steal or rewrite it.
4. Stop `supplyflow-ocr-live` immediately after the zero check so it cannot claim new work. Query
   production again after the stop and require zero active processing leases and zero active egress
   leases. New `queued` rows may remain parked. If a lease appeared in the drain-to-stop interval,
   restart the old container, let that attempt settle, and repeat the drain/stop/re-query sequence.
5. Create a recoverable rollback artifact from the stopped old container before renaming it:
   - commit its filesystem to a timestamped `supplyflow-ocr-worker:rollback-*` tag;
   - save that image to the protected release-evidence directory;
   - record the tar SHA-256; and
   - retain the stopped old container under a timestamped rollback name.
6. Create the new `supplyflow-ocr-live` with the old container's environment, network, mounts and
   restart policy, without printing secret values. Start it and require a healthy self-check before
   allowing the parked queue to drain.
7. Run one bounded document-processing smoke and verify evidence-first RPC use, attempt-bound
   evidence, acknowledged egress and unchanged tenant/job counts apart from the explicit smoke.
8. Roll back on startup/health/smoke failure: stop and remove only the new container, rename the
   retained old container back to `supplyflow-ocr-live`, start it, and verify health. If the old
   container is unavailable, load the saved rollback image and recreate it from the captured
   non-secret configuration plus the existing secret source. Database rollback remains a
   forward-fix because 0111 is an expand migration and the legacy wrappers stay available.

Never remove the old container, rollback image or tar until the live postflight and the next
scheduled worker cycle both pass.

## Explicit deferrals and remaining risks

- Live third-party integration proof is DEFERRED by product decision; no provider, endpoint,
  credential, account, or tenant was invented.
- The full build/quality, Edge runtime check, production migration, secrets, deployment, and live
  tenant smoke tests remain release-review responsibilities.
- Migration 0111 and the Edge worker must be coordinated using the expand/contract order above.
- This focused handoff is not production deployment approval by itself.
