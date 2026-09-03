import assert from "node:assert/strict";
import {
  GATEWAY_CONTRACT_HEADER,
  GATEWAY_CONTRACT_VERSION,
  gatewayContractMatches,
  jsonByteLength,
  RequestValidationError,
  validateActionRequest,
  validateExtraction,
} from "./contract.ts";

const jobId = "11111111-1111-4111-8111-111111111111";
const downloadLeaseId = "22222222-2222-4222-8222-222222222222";
const downloadLeaseToken = "33333333-3333-4333-8333-333333333333";
const payload = {
  schema_version: "1",
  document: {
    page_count: 1,
    detected_languages: ["he"],
    plain_text: "בדיקה",
    partial: false,
  },
  blocks: [{
    id: "b1",
    page: 1,
    type: "text",
    bbox: [0, 0, 1, 1],
    text: "בדיקה",
    confidence: 0.9,
  }],
  tables: [],
  marks: [],
  normalizations: [{
    id: "hebrew_visual_order",
    applied: false,
    original_text: null,
    measurements: [{ name: "hebrew_words", value: 1 }],
  }],
};

Deno.test("document processing request and extraction contracts", () => {
  assert.equal(validateExtraction(payload), true);
  assert.equal(
    validateExtraction({
      ...payload,
      document: { ...payload.document, page_count: 0 },
    }),
    false,
  );
  assert.equal(
    validateExtraction({
      ...payload,
      blocks: [{ ...payload.blocks[0], bbox: [0.8, 0, 0.2, 1] }],
    }),
    false,
  );

  // #20 -- the pairing between a stored value and its original, checked at the last point where
  // the payload is still refusable. Each case below is a DIFFERENT way of losing the evidence,
  // and every one of them used to be representable.
  const applied = {
    ...payload,
    normalizations: [{
      id: "hebrew_visual_order",
      applied: true,
      original_text: 'הלבק רוקמ ךמסמ',
      measurements: [
        { name: "hebrew_words", value: 3 },
        { name: "final_letter_first", value: 2 },
        { name: "final_letter_last", value: 0 },
      ],
    }],
  };
  assert.equal(validateExtraction(applied), true);
  // A worker that omits the array entirely: it cannot say whether it rewrote the text, which is
  // exactly the state GATEWAY_CONTRACT_VERSION moved to "3" to make impossible.
  assert.equal(
    validateExtraction(
      Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "normalizations"),
      ),
    ),
    false,
  );
  // Correction applied, original thrown away -- the exact defect #20 names.
  assert.equal(
    validateExtraction({
      ...applied,
      normalizations: [{ ...applied.normalizations[0], original_text: null }],
    }),
    false,
  );
  // ...and the other half: nothing changed, yet a second copy of the text is carried anyway,
  // which would read as a correction nobody made.
  assert.equal(
    validateExtraction({
      ...payload,
      normalizations: [{
        ...payload.normalizations[0],
        original_text: "בדיקה",
      }],
    }),
    false,
  );
  // An unreviewed corrector cannot reach stored evidence by inventing an id.
  assert.equal(
    validateExtraction({
      ...applied,
      normalizations: [{ ...applied.normalizations[0], id: "transliterate" }],
    }),
    false,
  );
  assert.equal(
    validateExtraction({
      ...applied,
      normalizations: [{
        ...applied.normalizations[0],
        measurements: [{ name: "hebrew_words", value: Number.NaN }],
      }],
    }),
    false,
  );
  assert.equal(
    validateExtraction({
      ...applied,
      normalizations: [
        applied.normalizations[0],
        applied.normalizations[0],
      ],
    }),
    false,
  );

  const claim = validateActionRequest({
    action: "claim",
    lease_owner: " worker-1 ",
  });
  assert.deepEqual(claim, {
    action: "claim",
    lease_owner: "worker-1",
    lease_seconds: 120,
  });

  const acknowledged = validateActionRequest({
    action: "ack_download",
    job_id: jobId,
    lease_owner: "worker-1",
    download_lease_id: downloadLeaseId,
    download_lease_token: downloadLeaseToken,
    lease_seconds: 300,
  });
  assert.equal(acknowledged.action, "ack_download");

  const heartbeat = validateActionRequest({
    action: "heartbeat",
    job_id: jobId,
    lease_owner: "worker-1",
    download_lease_id: downloadLeaseId,
    download_lease_token: downloadLeaseToken,
    lease_seconds: 300,
  });
  assert.equal(heartbeat.action, "heartbeat");
  // Omitting the counters is the healthy case for a worker built before they existed, and it must
  // stay valid without moving GATEWAY_CONTRACT_VERSION -- otherwise the running pool has to be
  // replaced in lockstep with the function for a status line.
  assert.equal(heartbeat.progress_done, null);
  assert.equal(heartbeat.progress_total, null);

  const reporting = validateActionRequest({
    action: "heartbeat",
    job_id: jobId,
    lease_owner: "worker-1",
    download_lease_id: downloadLeaseId,
    download_lease_token: downloadLeaseToken,
    lease_seconds: 300,
    progress_done: 7,
    progress_total: 27,
  });
  assert.equal(reporting.action === "heartbeat" && reporting.progress_done, 7);
  assert.equal(reporting.action === "heartbeat" && reporting.progress_total, 27);

  // Rejected, not repaired. Half a pair, a count past its own total and a total past the 100-page
  // extraction limit all describe a worker whose page accounting is wrong; salvaging the readable
  // half would put a number on the screen that no page ever produced.
  for (
    const broken of [
      { progress_done: 7 },
      { progress_total: 27 },
      { progress_done: 28, progress_total: 27 },
      { progress_done: 1, progress_total: 101 },
      { progress_done: -1, progress_total: 27 },
      { progress_done: 1.5, progress_total: 27 },
    ]
  ) {
    assert.throws(
      () =>
        validateActionRequest({
          action: "heartbeat",
          job_id: jobId,
          lease_owner: "worker-1",
          download_lease_id: downloadLeaseId,
          download_lease_token: downloadLeaseToken,
          lease_seconds: 300,
          ...broken,
        }),
      (error) =>
        error instanceof RequestValidationError &&
        error.code === "invalid_request",
      `accepted a malformed progress pair: ${JSON.stringify(broken)}`,
    );
  }

  const complete = validateActionRequest({
    action: "complete",
    job_id: jobId,
    processing_attempt_id: "44444444-4444-4444-8444-444444444444",
    lease_owner: "worker-1",
    download_lease_id: downloadLeaseId,
    download_lease_token: downloadLeaseToken,
    engine: "native",
    model: "parser",
    model_version: "1",
    input_checksum: "etag:0123456789abcdef",
    contract_version: "1",
    payload,
  });
  assert.equal(complete.action, "complete");
  assert.equal(jsonByteLength(complete.resource_metadata), 2);

  const failed = validateActionRequest({
    action: "fail",
    job_id: jobId,
    lease_owner: "worker-1",
    download_lease_id: downloadLeaseId,
    download_lease_token: downloadLeaseToken,
    error_code: "ocr_failed",
  });
  assert.equal(failed.action, "fail");
  assert.equal(failed.retryable, false);

  const retryableFailure = validateActionRequest({
    action: "fail",
    job_id: jobId,
    lease_owner: "worker-1",
    download_lease_id: downloadLeaseId,
    download_lease_token: downloadLeaseToken,
    error_code: "gateway_unavailable",
    retryable: true,
  });
  assert.equal(retryableFailure.action, "fail");
  assert.equal(retryableFailure.retryable, true);

  assert.throws(
    () =>
      validateActionRequest({
        action: "claim",
        lease_owner: "worker-1",
        org_id: jobId,
      }),
    (error) =>
      error instanceof RequestValidationError &&
      error.code === "invalid_request",
  );
  assert.throws(
    () =>
      validateActionRequest({
        ...complete,
        payload: { ...payload, schema_version: "2" },
      }),
    (error) =>
      error instanceof RequestValidationError &&
      error.code === "invalid_extraction",
  );
  assert.throws(
    () => validateActionRequest({ ...failed, retryable: "yes" }),
    (error) =>
      error instanceof RequestValidationError &&
      error.code === "invalid_request",
  );
  assert.throws(
    () =>
      validateActionRequest({
        action: "heartbeat",
        job_id: jobId,
        lease_owner: "worker-1",
        lease_seconds: 300,
      }),
    (error) =>
      error instanceof RequestValidationError &&
      error.code === "invalid_request",
  );
  assert.throws(
    () =>
      validateActionRequest(Object.fromEntries(
        Object.entries(complete).filter(([key]) =>
          key !== "processing_attempt_id"
        ),
      )),
    (error) =>
      error instanceof RequestValidationError &&
      error.code === "invalid_request",
  );
});

Deno.test("gateway contract handshake is exact and header based", () => {
  // Moved 2 -> 3 with `normalizations`, then 3 -> 4 with `hebrew_line_order`. This literal and
  // `GATEWAY_CONTRACT_VERSION` in `worker/ocr/src/gateway.py` are the pair a3603c0 broke by
  // moving only one of them — and this test is the third member of that set, which the 3 -> 4
  // move left behind: both sides were already "4" while this assertion still demanded "3".
  assert.equal(GATEWAY_CONTRACT_VERSION, "4");
  assert.equal(
    gatewayContractMatches(
      new Headers({
        [GATEWAY_CONTRACT_HEADER]: GATEWAY_CONTRACT_VERSION,
      }),
    ),
    true,
  );
  assert.equal(gatewayContractMatches(new Headers()), false);
  assert.equal(
    gatewayContractMatches(
      new Headers({
        [GATEWAY_CONTRACT_HEADER]: "1",
      }),
    ),
    false,
  );
});
