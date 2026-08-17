// Splitting a long document across concurrent provider calls.
//
// The numbers here are the production ones, not invented sizes. An 8-page, 17,135-character price
// list failed provider_timeout three separate times while documents of 5-9KB completed in 34-45
// seconds. The threshold is therefore not a taste question: it is the line between the sizes that
// finished and the size that never did, and these tests pin it to that measurement so a later
// change has to argue with the data rather than with a constant.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ExtractionContract,
  type InterpretationContract,
  type ProviderPayload,
} from "./core.ts";
import {
  mergeSplitResults,
  planInterpretation,
  planPageChunks,
  runInterpretationPlan,
  sliceExtractionByPages,
} from "./split.ts";

const SUPPLIER_ID = "11111111-1111-4111-8111-111111111111";

function pagedExtraction(pages: number, charsPerPage: number): ExtractionContract {
  const blocks = Array.from({ length: pages }, (_unused, index) => ({
    id: `block-p${index + 1}`,
    page: index + 1,
    type: "text" as const,
    bbox: [0, 0, 1, 1] as [number, number, number, number],
    text: `page ${index + 1} `.padEnd(charsPerPage, "x"),
    confidence: 0.9,
  }));
  return {
    schema_version: "1",
    document: {
      page_count: pages,
      detected_languages: ["he"],
      plain_text: blocks.map((block) => block.text).join("\n\n"),
      partial: false,
    },
    blocks,
    tables: [],
    marks: [{
      id: "mark-last",
      page: pages,
      kind: "circle",
      bbox: [0, 0, 0.1, 0.1],
      nearby_block_ids: ["block-p1", `block-p${pages}`],
      confidence: 0.7,
      fingerprint: null,
    }],
  };
}

function segmentedInterpretation(
  documentType: InterpretationContract["document_type"],
  pages: number,
  lineItems: number,
  supplierId: string | null,
): InterpretationContract {
  return {
    schema_version: "1",
    document_type: documentType,
    document_type_confidence: 0.95,
    packet_segments: [{
      ordinal: 1,
      start_page: 1,
      end_page: pages,
      document_type: documentType,
      confidence: 0.95,
    }],
    supplier: {
      suggested_id: supplierId,
      suggested_name: "ספק בדיקה",
      confidence: 0.9,
      evidence_block_ids: ["block-p1"],
    },
    fields: [],
    line_items: Array.from({ length: lineItems }, (_unused, index) => ({
      source_row: index + 1,
      values: { sku: `sku-${index + 1}` },
      evidence_block_ids: [],
    })),
    suggested_annotations: [],
  };
}

const NO_USAGE = {
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  cached_input_tokens: null,
  reasoning_output_tokens: null,
};

test("a document that fits in one call is not split", () => {
  // 8,000 characters: inside the band that measured 34-45 seconds and completed.
  assert.equal(planPageChunks(pagedExtraction(4, 2_000)), null);
  // Page count alone never triggers it, and a one-page document cannot be cut by page at all.
  assert.equal(planPageChunks(pagedExtraction(1, 40_000)), null);
});

test("a document whose text the blocks do not account for is sent whole", () => {
  const source = pagedExtraction(8, 2_200);
  // Blocks now carry a fraction of the text. Slicing by page range would silently drop the rest,
  // so the honest move is to send the document whole and let it fail visibly if it is too big.
  source.blocks = source.blocks.map((block) => ({ ...block, text: "x" }));
  assert.equal(planPageChunks(source), null);
});

test("the price list that timed out three times is cut into whole pages", () => {
  const chunks = planPageChunks(pagedExtraction(8, 2_142));
  assert.ok(chunks, "the 17KB document was not split");
  assert.deepEqual(chunks, [
    { start_page: 1, end_page: 4 },
    { start_page: 5, end_page: 8 },
  ]);
});

test("the fan-out is bounded, and the pieces grow instead", () => {
  const chunks = planPageChunks(pagedExtraction(40, 4_000));
  assert.ok(chunks);
  assert.ok(chunks.length <= 4, `fanned out to ${chunks.length} concurrent calls`);
  // Still a complete, contiguous cover: no page may be dropped to stay under the cap.
  assert.equal(chunks[0].start_page, 1);
  assert.equal(chunks[chunks.length - 1].end_page, 40);
  for (let index = 1; index < chunks.length; index += 1) {
    assert.equal(chunks[index].start_page, chunks[index - 1].end_page + 1);
  }
});

test("a slice is numbered from page one and keeps its global block ids", () => {
  const source = pagedExtraction(8, 2_142);
  const slice = sliceExtractionByPages(source, { start_page: 5, end_page: 8 });
  assert.equal(slice.document.page_count, 4);
  assert.deepEqual(slice.blocks.map((block) => block.page), [1, 2, 3, 4]);
  // Local pages are required by the response validator, which rejects segments that do not start
  // at page 1. The IDs must NOT be renumbered with them, or evidence_block_ids stop resolving
  // once the pieces are merged back together.
  assert.deepEqual(slice.blocks.map((block) => block.id), [
    "block-p5",
    "block-p6",
    "block-p7",
    "block-p8",
  ]);
  assert.equal(slice.document.plain_text.includes("page 5"), true);
  assert.equal(slice.document.plain_text.includes("page 4"), false);
  // A neighbour on a page this call cannot see is not a neighbour it can reason about.
  assert.deepEqual(slice.marks[0].nearby_block_ids, ["block-p8"]);
});

test("merged pieces of one price list stay one price list", () => {
  const merged = mergeSplitResults([
    {
      chunk: { start_page: 1, end_page: 4 },
      result: {
        interpretation: segmentedInterpretation("price_list", 4, 60, SUPPLIER_ID),
        provider_request_id: "req-1",
        model: "gpt-5.6-terra",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          cached_input_tokens: null,
          reasoning_output_tokens: null,
        },
      },
    },
    {
      chunk: { start_page: 5, end_page: 8 },
      result: {
        interpretation: segmentedInterpretation("price_list", 4, 40, SUPPLIER_ID),
        provider_request_id: "req-2",
        model: "gpt-5.6-terra",
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          total_tokens: 12,
          cached_input_tokens: null,
          reasoning_output_tokens: null,
        },
      },
    },
  ]);
  // Two adjacent price_list segments are one price list. Without coalescing them the contract's
  // own rule forces document_type to "other", and a perfectly ordinary price list would file as
  // unclassified purely because it was long enough to be cut.
  assert.equal(merged.result.interpretation.packet_segments.length, 1);
  assert.deepEqual(merged.result.interpretation.packet_segments[0], {
    ordinal: 1,
    start_page: 1,
    end_page: 8,
    document_type: "price_list",
    confidence: 0.95,
  });
  assert.equal(merged.result.interpretation.document_type, "price_list");
  assert.equal(merged.result.interpretation.line_items.length, 100);
  // Page order, so the merged list reads exactly as the document does.
  assert.equal(merged.result.interpretation.line_items[0].values.sku, "sku-1");
  assert.equal(merged.result.interpretation.line_items[60].values.sku, "sku-1");
  assert.equal(merged.result.usage.total_tokens, 42);
  assert.equal(merged.summary.line_items.produced, 100);
  assert.equal(merged.summary.document_type_agreed, true);
});

test("pieces that disagree about the document are reported as a mixed packet", () => {
  const merged = mergeSplitResults([
    {
      chunk: { start_page: 1, end_page: 2 },
      result: {
        interpretation: segmentedInterpretation("price_list", 2, 3, SUPPLIER_ID),
        provider_request_id: null,
        model: "gpt-5.6-terra",
        usage: NO_USAGE,
      },
    },
    {
      chunk: { start_page: 3, end_page: 4 },
      result: {
        interpretation: segmentedInterpretation("invoice", 2, 2, null),
        provider_request_id: null,
        model: "gpt-5.6-terra",
        usage: NO_USAGE,
      },
    },
  ]);
  assert.equal(merged.result.interpretation.packet_segments.length, 2);
  assert.equal(merged.result.interpretation.document_type, "other");
  // Not a hedged number: nobody measured the confidence of a document nobody claimed.
  assert.equal(merged.result.interpretation.document_type_confidence, null);
  // The supplier survives from the piece that actually named one, carrying only that piece's
  // evidence -- pooling both would attach one call's citation to another call's answer.
  assert.equal(merged.result.interpretation.supplier.suggested_id, SUPPLIER_ID);
  assert.deepEqual(merged.result.interpretation.supplier.evidence_block_ids, ["block-p1"]);
  assert.equal(merged.summary.document_type_agreed, false);
});

test("the pieces are sent concurrently, because sequential calls would not fit the lease", async () => {
  let inFlight = 0;
  let peak = 0;
  const provider = {
    interpret: async (payload: ProviderPayload) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Resolves only once every piece is in flight. A sequential runner never gets here, which is
      // the point: concurrency is what keeps the total inside the same fenced budget that one call
      // already had, and two 60-second calls in sequence would outlive the egress lease.
      while (inFlight < 2) await new Promise((resolve) => setTimeout(resolve, 1));
      const pages = payload.extraction.document.page_count;
      return {
        interpretation: segmentedInterpretation("price_list", pages, 2, SUPPLIER_ID),
        provider_request_id: null,
        model: "gpt-5.6-terra",
        usage: NO_USAGE,
      };
    },
  };
  const plan = planInterpretation(pagedExtraction(8, 2_142), [], [], "price_list");
  assert.equal(plan.payloads.length, 2);
  const merged = await runInterpretationPlan(provider, plan);
  assert.equal(peak, 2, "the pieces were sent one after another");
  assert.equal(merged.result.interpretation.line_items.length, 4);
});

test("an unsplit plan reports itself as unsplit", async () => {
  const provider = {
    interpret: () =>
      Promise.resolve({
        interpretation: segmentedInterpretation("invoice", 1, 3, SUPPLIER_ID),
        provider_request_id: null,
        model: "gpt-5.6-terra",
        usage: NO_USAGE,
      }),
  };
  const plan = planInterpretation(pagedExtraction(1, 500), [], [], null);
  assert.equal(plan.chunks, null);
  const merged = await runInterpretationPlan(provider, plan);
  assert.deepEqual(merged.summary.chunks, []);
  assert.equal(merged.result.interpretation.document_type, "invoice");
});
