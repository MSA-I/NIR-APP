async function source(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url));
}

function assertIncludes(value: string, expected: string): void {
  if (!value.includes(expected)) {
    throw new Error(`missing source contract: ${expected}`);
  }
}

function assertExcludes(value: string, forbidden: string): void {
  if (value.includes(forbidden)) {
    throw new Error(`forbidden source contract: ${forbidden}`);
  }
}

function assertOrdered(value: string, parts: string[]): void {
  let offset = 0;
  for (const part of parts) {
    const position = value.indexOf(part, offset);
    if (position < 0) {
      throw new Error(`missing or out-of-order source contract: ${part}`);
    }
    offset = position + part.length;
  }
}

Deno.test("interpret-document reserves once, persists provider evidence, then settles", async () => {
  const value = await source("../interpret-document/index.ts");
  const handler = value.slice(value.indexOf("export async function handler"));
  assertOrdered(handler, [
    "recoverStoredProviderEvidence",
    "const beginResult = await admin.rpc",
    "providerPayload = buildProviderPayload",
    "reservation = await reserveOrganizationEgress",
    "if (egressLease.idempotent)",
    "const providerAttempt = await runReservedEgress",
    "const result = await createOpenAiProvider",
    "await releaseOrganizationEgress",
    "await recoverInterpretationFromEgress",
  ]);
  assertIncludes(value, "service_recover_document_interpretation_from_egress");
  assertIncludes(handler, "evidenceSha256 = settlement.evidence_sha256");
  assertIncludes(handler, "interpretation_started_at: interpretationStartedAt");
  assertIncludes(value, "getOrganizationEgressEvidence");
  assertIncludes(handler, "recoveredFromEvidence: true");
  const providerFailureSettlement = handler.slice(
    handler.indexOf("if (!outcome.ok)"),
    handler.indexOf("const settlement = await releaseOrganizationEgress"),
  );
  assertOrdered(providerFailureSettlement, [
    "await releaseOrganizationEgress",
    "egressSettled = true",
    "await markFailed",
  ]);
  assertExcludes(handler, "payloadSha256");
  assertExcludes(handler, "JSON.stringify(result.interpretation)");
  assertExcludes(handler, "providerAccessError");
  assertExcludes(handler, "persistenceAccessError");
});

Deno.test("document-processing binds download ACK and holds the lease through complete or fail", async () => {
  const value = await source("../document-processing/index.ts");
  const claimStart = value.indexOf("async function claim(");
  const claimEnd = value.indexOf("async function heartbeat", claimStart);
  const claimBody = value.slice(claimStart, claimEnd);
  assertOrdered(claimBody, [
    "const reservation = await reserveOrganizationEgress",
    ".createSignedUrl(",
    "download_lease_id: downloadLease.lease_id",
    "download_lease_token: downloadLease.lease_token",
  ]);
  assertIncludes(claimBody, "correlationId: result.data.processing_attempt_id");
  const acknowledgeStart = value.indexOf("async function acknowledgeDownload");
  const acknowledgeEnd = value.indexOf(
    "async function heartbeat",
    acknowledgeStart,
  );
  const acknowledge = value.slice(acknowledgeStart, acknowledgeEnd);
  assertIncludes(
    acknowledge,
    "service_acknowledge_document_processing_download",
  );
  assertIncludes(acknowledge, "p_egress_lease_id: request.download_lease_id");
  assertIncludes(
    acknowledge,
    "p_egress_lease_token: request.download_lease_token",
  );
  assertExcludes(acknowledge, "releaseOrganizationEgress");
  assertIncludes(value, "const STORAGE_CONTROL_TIMEOUT_MS = 10_000");
  assertIncludes(value, "AbortSignal.timeout(STORAGE_CONTROL_TIMEOUT_MS)");
  for (const action of ["heartbeat", "complete", "markFailed"]) {
    const start = value.indexOf(`async function ${action}`);
    const end = value.indexOf("\n}", start);
    const functionBody = value.slice(start, end);
    assertIncludes(
      functionBody,
      "p_egress_lease_id: request.download_lease_id",
    );
    assertIncludes(
      functionBody,
      "p_egress_lease_token: request.download_lease_token",
    );
  }
  assertIncludes(value, "p_retryable: request.retryable");
  assertIncludes(value, '"evidence_sha256"');
  assertIncludes(value, '"business_applied"');
  const completeStart = value.indexOf("async function complete");
  const completeEnd = value.indexOf("async function markFailed", completeStart);
  assertOrdered(value.slice(completeStart, completeEnd), [
    'admin.rpc("service_record_document_ocr_evidence"',
    'admin.rpc("complete_document_processing_job"',
    '"service_recover_document_extraction_from_egress"',
  ]);
  assertIncludes(
    value,
    "p_processing_attempt_id: request.processing_attempt_id",
  );
  assertIncludes(value, "p_evidence_sha256: recorded.data.evidence_sha256");
  assertExcludes(value, "requireJobOrganizationWritable");
  assertExcludes(value, ".from('organizations')");
});

Deno.test("send-invite fences mutation and idempotent Resend delivery", async () => {
  const value = await source("../send-invite/index.ts");
  const handler = value.slice(value.indexOf("Deno.serve"));
  assertOrdered(handler, [
    "reservation = await reserveOrganizationEgress",
    "if (egressLease.idempotent)",
    "await supabase.rpc('create_invitation'",
    "await runReservedEgress",
    "fetch('https://api.resend.com/emails'",
    "releaseOrganizationEgress",
  ]);
  assertIncludes(
    handler,
    "'Idempotency-Key': `supplyflow-invite/${correlationId}`",
  );
  assertIncludes(handler, "AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS)");
  assertIncludes(value, "select('org_id, role, active')");
  assertExcludes(value, ".from('organizations')");
});

Deno.test("send-push settles a partial multi-endpoint result as delivered with failure evidence", async () => {
  const value = await source("../send-push/index.ts");
  assertIncludes(value, "admin.rpc('service_organization_access_mode'");
  assertExcludes(value, ".from('organizations')");
  assertExcludes(value, "organization.status");
  const deliveryStart = value.indexOf(
    "async function deliverQueuedNotifications",
  );
  const deliveryEnd = value.indexOf("Deno.serve", deliveryStart);
  const delivery = value.slice(deliveryStart, deliveryEnd);
  assertOrdered(delivery, [
    "const correlationId = await pushAttemptCorrelation",
    "const reservation = await reserveOrganizationEgress",
    "if (reservation.lease.idempotent)",
    "return await runReservedEgress",
    "sendToSubs(",
    "await recordPushResult",
    "await releaseOrganizationEgress",
  ]);
  assertIncludes(delivery, "? 'partial'");
  assertIncludes(delivery, ": 'no_delivery'");
  assertIncludes(delivery, "recordPushResult(admin, userRows, pushOutcome");
  assertIncludes(delivery, "push_partial_delivery_${result.failed}_failures");
  const sendStart = value.indexOf("async function sendToSubs");
  const sendEnd = value.indexOf("async function recordPushResult", sendStart);
  assertExcludes(value.slice(sendStart, sendEnd), "organizationCanNotify");
  const lifecycleDenials = value.match(/return fail\('org_unavailable'/g) ?? [];
  if (lifecycleDenials.length < 2) {
    throw new Error(
      "direct notification events still hide lifecycle denial as success",
    );
  }
});

Deno.test("outbox-worker parks before egress and jointly settles claim plus lease after it", async () => {
  const value = await source("../outbox-worker/index.ts");
  assertIncludes(value, "admin.rpc('service_park_claimed_integration_outbox'");
  assertIncludes(
    value,
    "admin.rpc('service_settle_claimed_integration_outbox'",
  );
  const handler = value.slice(value.indexOf("Deno.serve"));
  assertOrdered(handler, [
    "const reservation = await reserveOrganizationEgress",
    "await parkClaimedDelivery",
    "if (lease.idempotent)",
    "const outcome = await runReservedEgress",
    "perform: () => deliver(row, allowedHosts)",
    "await settleClaimAndEgress",
  ]);
  assertExcludes(value, "organizationCanDeliver");
});

Deno.test("organization logo storage mutates only inside a settled lease", async () => {
  const value = await source("../upload-organization-logo/index.ts");
  const handler = value.slice(value.indexOf("Deno.serve"));
  assertOrdered(handler, [
    "validatedLogoType(uploadBytes",
    "reservation = await reserveOrganizationEgress",
    "getOrganizationEgressEvidence",
    "if (reservation.lease.idempotent)",
    "const result = await runReservedEgress",
    'admin.storage.from("organization-branding").upload',
    '"set_organization_branding_reference"',
    "releaseOrganizationEgress",
  ]);
  assertIncludes(handler, 'kind: "organization_logo_storage"');
  assertIncludes(handler, 'outcome: "ambiguous"');
  assertIncludes(handler, "logo_reference_failed_orphan_cleanup_failed");
  assertIncludes(handler, "retryable_definitive: !cleanupFailed");
  assertIncludes(handler, "ROTATE_CORRELATION_HEADERS");
  assertIncludes(handler, "databaseFailureIsDefinitive");
});
