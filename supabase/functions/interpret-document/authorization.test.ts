import { supplierInterpretationContextAllowed } from "./index.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("expected a truthy value");
}

function assertFalse(value: unknown): void {
  if (value) throw new Error("expected a falsy value");
}

const ACTOR = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const SUPPLIER = "33333333-3333-4333-8333-333333333333";
const DOCUMENT = "44444444-4444-4444-8444-444444444444";
const JOB = "55555555-5555-4555-8555-555555555555";
const CHECKSUM = "etag:0123456789abcdef";

function context() {
  return {
    profile: {
      org_id: ORG,
      role: "supplier",
      active: true,
      supplier_id: SUPPLIER,
    },
    document: {
      id: DOCUMENT,
      org_id: ORG,
      entity_type: "supplier",
      entity_id: SUPPLIER,
      supplier_id: SUPPLIER,
      document_kind: "price_list",
      uploaded_by: ACTOR,
      storage_path: `${ORG}/supplier/${SUPPLIER}/${DOCUMENT}/prices.pdf`,
      deleted_at: null,
    },
    job: {
      id: JOB,
      org_id: ORG,
      document_id: DOCUMENT,
      status: "extracted",
      requested_by: ACTOR,
      input_checksum: CHECKSUM,
      contract_version: "1",
    },
    extraction: {
      id: "66666666-6666-4666-8666-666666666666",
      org_id: ORG,
      job_id: JOB,
      document_id: DOCUMENT,
      input_checksum: CHECKSUM,
      contract_version: "1",
    },
  };
}

Deno.test("supplier interpretation allows the exact owned price-list chain", () => {
  const value = context();
  assert(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects a different supplier", () => {
  const value = context();
  value.document.supplier_id = "77777777-7777-4777-8777-777777777777";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects cross-tenant context", () => {
  const value = context();
  value.extraction.org_id = "88888888-8888-4888-8888-888888888888";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects another uploader", () => {
  const value = context();
  value.document.uploaded_by = "99999999-9999-4999-8999-999999999999";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects a non-price-list document", () => {
  const value = context();
  value.document.document_kind = "invoice";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects a job requested by another actor", () => {
  const value = context();
  value.job.requested_by = "99999999-9999-4999-8999-999999999999";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});

Deno.test("supplier interpretation rejects checksum and version drift", () => {
  const value = context();
  value.extraction.input_checksum = "etag:changed";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));

  const versionDrift = context();
  versionDrift.extraction.contract_version = "2";
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    versionDrift.profile,
    versionDrift.document,
    versionDrift.job,
    versionDrift.extraction,
  ));
});

Deno.test("supplier interpretation rejects a non-canonical storage path", () => {
  const value = context();
  value.document.storage_path = `${ORG}/supplier/${SUPPLIER}/prices.pdf`;
  assertFalse(supplierInterpretationContextAllowed(
    ACTOR,
    value.profile,
    value.document,
    value.job,
    value.extraction,
  ));
});
