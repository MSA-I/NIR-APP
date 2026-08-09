# Database / Supabase / Security — Final Handoff

Date: 2026-08-09

## Outcome

The final database review is release-gate green for the reviewed migration and focused suites. The
main late P1 finding is closed: OCR provider output is now committed as immutable evidence in a
separate RPC transaction before any public extraction mutation. A rollback, worker crash, lost RPC
response, expired lease, lifecycle flip, or recoverable failed job does not require another provider
request and cannot erase the committed result.

## What changed and why

- Added attempt-bound OCR evidence recording with a PostgreSQL-canonical payload SHA-256 and a
  separate full-evidence SHA-256.
- Replaced the extraction completion command with an evidence-consuming command. It never records
  provider evidence and therefore cannot roll that evidence back with the business apply.
- Added writable-only extraction recovery from immutable egress evidence. It supports the current
  attempt in `leased` (including expired) or `failed` state and never contacts the provider.
- Added recovery-before-reclaim to `claim_document_processing_job`: an expired attempt with a
  delivered result is recovered before a new attempt can be created. Recovery failures fail closed;
  they do not silently fall through to a second OCR request.
- Kept tenant, job, attempt, document, source checksum, contract, acknowledged egress lease, owner,
  token, evidence hash and canonical payload hash bound together.
- Preserved evidence on read-only lifecycle states. Normal completion reports
  `business_applied=false`; after authorized reactivation, the recovery command applies the exact
  evidence without a provider retry.
- Preserved the separate immutable provider-evidence recovery path for document interpretation.
- Removed raw `suppliers` table access for supplier agents; their own identity remains available
  through the narrow supplier portal projection.
- Restored service-role CRUD grants for the three managed integration adapter tables while leaving
  browser access unchanged.
- Reconciled the SECURITY DEFINER registry at 73 entries and documented why each new OCR boundary
  cannot safely become invoker.
- Updated the old P9 fixture to create approvals through the real server command and to provide a
  real approving actor for immutable 3-way approval snapshots.

## Final OCR RPC contract

```text
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
```

Record result keys:

```text
job_id, org_id, processing_attempt_id, egress_lease_id,
evidence_sha256, payload_sha256, lease_outcome, idempotent
```

Complete result keys:

```text
job_id, processing_attempt_id, egress_lease_id, extraction_id,
evidence_sha256, payload_sha256, business_applied, access_mode, idempotent
```

Recovery result keys:

```text
job_id, processing_attempt_id, evidence_lease_id, extraction_id,
evidence_sha256, payload_sha256, access_mode, idempotent, recovered_from_failed
```

Old complete and heartbeat overloads are absent. Browser execution is revoked from every worker
command; only `service_role` can execute them.

## Files touched in this workstream

- `supabase/migrations/0097_tenant_offboarding_export.sql`
- `supabase/tests/p25_tenant_offboarding_export.sql`
- `supabase/tests/smart_document_processing.sql`
- `supabase/tests/p18_document_automation_calibration.sql`
- `supabase/tests/p17_financial_supplier_view.sql`
- `supabase/tests/p9_five_domains.sql`
- `handoff/improvement-campaign-20260809-db-security-final.md`

No historical migration was rewritten. All production database changes remain forward-only in
`0097_tenant_offboarding_export.sql`.

## Tests added or strengthened

- OCR evidence A/A replay returns the same evidence and payload hashes with `idempotent=true`.
- OCR evidence A/B replay fails with immutable-evidence conflict.
- Transaction A records evidence; transaction B applies extraction and is rolled back; evidence
  remains and extraction does not.
- A worker crash followed by job and egress expiry recovers before reclaim; attempt count remains
  one and no second provider request is created.
- Lifecycle read-only completion preserves evidence without a public extraction; authorized
  reactivation recovers it.
- Changed source rejects extraction while preserving the already committed provider evidence.
- Stale token, wrong owner, wrong checksum, wrong contract, retryable failure, duplicate retry,
  browser ACL, tenant isolation and immutable evidence checks remain covered.

## Verification performed

- `supabase db reset`: PASS, migrations `0001` through `0097`, seed and container restart.
- `supabase/tests/smart_document_processing.sql`: PASS,
  `smart_document_processing_passed`.
- `supabase/tests/p25_tenant_offboarding_export.sql`: PASS,
  `P25 tenant offboarding/export/egress tests passed`.
- `supabase/tests/p18_document_automation_calibration.sql`: PASS,
  `P18 document automation calibration/shadow/operations checks passed`.
- `supabase/tests/p17_financial_supplier_view.sql`: PASS (exit 0, transaction rolled back).
- `supabase/tests/p22_trial_read_only.sql`: PASS (exit 0, transaction rolled back).
- `supabase/tests/roadmap_db_contracts.sql`: PASS,
  `roadmap_db_contracts: all assertions passed`.
- `supabase/tests/p7_integration_adapters.sql`: PASS,
  `p7_integration_adapters_passed`.
- `supabase/tests/p9_five_domains.sql`: PASS, `p9_five_domains_passed`.
- `npm.cmd run check:exemptions`: PASS, pin 73; `+18 / -4` over the 0057 seed of 59.
- `private.scope_enforcement_violations()`: 0 rows.
- RPC catalog: exactly the eight expected claim/ack/heartbeat/record/complete/fail/extraction-
  recovery/interpretation-recovery signatures; no stale overload.
- `git diff --check` on reviewed database/test files: PASS.

Important runner note: SQL files containing Hebrew must be copied byte-for-byte into the database
container and run with `psql -f`. PowerShell's native text pipeline replaced Hebrew characters with
question marks and caused a false layout-signature failure.

## Frozen file hashes (SHA-256)

```text
0097_tenant_offboarding_export.sql  E56DFCA0EE8873E04A0676E9599D73AFC8311A238D6BAA9FA1CA7FC523CCFC92
p25_tenant_offboarding_export.sql   73E96A0DF6FF11CE776422B0E164CF0E5A5A3470D39D70D1783B36D1D4D958D9
smart_document_processing.sql       7D64789F4930CE3729CA8515A5B9B6445FDCC5EC4DABCFF08BB7C61370BB78DB
p18_document_automation_calibration.sql B916E16E9C5F876E6FC7A991635972733CC11E7AB68D4FA3015BA44B387EE951
p17_financial_supplier_view.sql     E0281B606F1EEE2F23E2447961D7976ACE22FCDFF7B71A8381D8D77762B3F865
p9_five_domains.sql                 2877EB776E320C7A4D5343469F921F249CE96C53B3E428405152B37E85394F33
```

Recompute these hashes after any reviewer or caller-contract edit; a mismatch means the focused
database gates must be rerun.

## Assumptions and explicit decisions

- OCR maximum acknowledged egress duration is 3,720 seconds: the configured 3,600-second job
  timeout plus the configured 120-second request timeout. This is bounded configuration, not an
  invented business threshold.
- Provider evidence may be recorded after lease expiry or a lifecycle change because that command
  mutates no public business state.
- Recovery is permitted only while the tenant is writable and only for the job's current attempt.
- A stale older attempt may retain immutable evidence but cannot mutate the current job.
- Live third-party integration proof remains explicitly deferred; no endpoint, tenant or credential
  was invented.

## Remaining risks / release prerequisites

- The Edge/worker caller must be reviewed against the exact frozen signatures and exact result-key
  sets above. It must await `service_record_document_ocr_evidence` before calling complete.
- The full repository `npm run build` and `npm run quality` are release-review responsibilities and
  are not replaced by these focused database gates.
- Migration `0097` must be applied only after `0096`; deploy Edge/worker callers that understand the
  split contract in the coordinated backend release window.
- Production migration, secrets, deployment and live verification were not performed by this
  database subagent.

## Review status

Implementation and focused verification are complete. Independent QA/release review is still
required; this handoff is not permission to deploy by itself.
