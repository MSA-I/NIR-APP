# Mixed-PDF controlled pilot protocol

Status: `PROTOCOL_ONLY / NOT_AUTHORIZED / NOT_RUN / NO_POLICY_CHANGE`.

This protocol does not authorize a pilot. Execution requires a separate, explicit Production
authorization naming one organization and one source document. `document.packet_split` remains
off by default; `private.autonomy_policy_definitions.kill_switch` remains the off-only emergency
stop. Never infer current Production state from this file: read it immediately before execution.

## Entry gate

1. Record exact Git SHA, migration ledger head, Edge versions and OCR worker image.
2. Name one authorized organization and one approved mixed-PDF fixture. Record original Storage
   path, byte size and SHA-256 without copying document contents into the report.
3. Read `private.autonomy_policy_for_org(org_id,'document.packet_split')`; require configured-off,
   `kill_switch=false`, and no processing job already active for the fixture.
4. Capture before counts for documents, jobs, packets, segments, child documents, extractions,
   interpretations, usage events and relevant audit rows. No unrelated business count may move.
5. Confirm a tested organization-disable command and Platform Admin step-up session are available
   before enable. A one-organization pilot authorization does not authorize any global kill switch.

## One execution

1. Platform Admin enables `document.packet_split` for the named organization only, with fresh
   password, exact reason and correlation id. No global/default/targeting change.
2. Submit the one approved document once. Do not retry an ambiguous response; reconcile by source
   checksum and job id.
3. Verify page ranges are contiguous, non-overlapping and cover exactly the attempted source pages.
4. Verify every child points to the immutable parent checksum, has its own bytes/hash/job, and no
   child changes the parent or another segment.
5. Verify usage is charged once, source and child hashes match Storage bytes, and each business
   output remains review-only until its existing human/automation gate independently permits it.

## Mandatory exit

1. Disable the organization policy immediately after evidence capture, even on failure. If the
   organization disable fails, stop, classify the pilot `BLOCKED`, record the exact policy state,
   and escalate to the named Platform incident owner. Do not attempt another document or report
   successful restoration.
2. A global off-only kill switch may be raised only under a separate, explicitly named global
   emergency authorization that acknowledges every-tenant blast radius. It is never an automatic
   fallback and is never authorized by this one-organization protocol.
3. Capture after counts, audit/security events, policy state and zero unrelated mutations.
4. Classify result `PASS`, `FAIL` or `BLOCKED`. One PASS proves one fixture only and never authorizes
   another organization, another document, threshold change or global rollout.
5. Store sanitized evidence outside the repository; never store source bytes, credentials or raw
   OCR payload here.
