/**
 * Splitting a long document across several provider calls.
 *
 * WHY, with the measurements it came from. `document_interpretations.duration_ms` in production,
 * against the extraction that produced each one:
 *
 *   chars   line items   seconds
 *    1,447           3       6.5
 *    3,988          36      38.4
 *    5,394          72      43.2
 *    7,822          74      33.9
 *    8,856          79      45.0   <- and 41.7 on a second run of the same file
 *   17,135           -    failed provider_timeout, three separate times
 *
 * Around nine thousand characters the call lands at forty-odd seconds, and the one document twice
 * that size never finished. Raising the per-attempt ceiling to 90 seconds buys headroom for the
 * middle of that table; it does not buy a document that needs several times the work. This module
 * is the other half: keep each call near the size that is known to complete, and run the calls
 * concurrently so the total stays inside the same egress lease the single call already had.
 *
 * Concurrency, not sequence, is load-bearing. The fenced budget bounds WALL time, so two 60-second
 * calls in parallel fit where two in sequence would not.
 *
 * The one measurement that argues against the threshold is a 27-page scan: 18,615 characters that
 * interpreted in 14.8 seconds, because a sparse scan yields few line items. It will be split
 * unnecessarily and cost one extra call. That is the deliberate trade — the cost of an unneeded
 * split is one call, the cost of a missed one is a document the owner cannot use at all.
 */
import {
  buildProviderPayload,
  type ExtractionContract,
  type InterpretationContract,
  InterpretationError,
  type InterpretationProvider,
  type LearningRuleSummary,
  type ProviderPayload,
  type ProviderResult,
  type ProviderUsage,
  type SupplierCandidate,
} from "./core.ts";

/** Above this much text, one call is no longer a safe bet. See the table above. */
export const SPLIT_TEXT_THRESHOLD_CHARS = 12_000;
/** What each call should be near: the largest size measured to complete comfortably. */
export const SPLIT_TARGET_CHARS = 9_000;
/**
 * Concurrent provider calls per document. Four keeps provider pressure modest and bounds the blast
 * radius of a document that is simply too large — past this the pieces grow again rather than the
 * fan-out, and a genuinely enormous file still fails honestly instead of fanning out unbounded.
 */
export const MAX_SPLIT_CALLS = 4;
/**
 * Blocks must actually carry the document's text for a page slice to be a text slice. Below this
 * fraction the text lives somewhere the page ranges cannot address, and splitting would silently
 * drop content — so the document is sent whole, and fails visibly if it is too big.
 */
const MIN_BLOCK_TEXT_COVERAGE = 0.5;
/** Schema ceiling on the merged result (InterpretationSchema: line_items max 500). */
const MAX_MERGED_LINE_ITEMS = 500;
const MAX_MERGED_FIELDS = 200;
const MAX_MERGED_ANNOTATIONS = 200;

export interface PageChunk {
  start_page: number;
  end_page: number;
}

/**
 * The page ranges to interpret separately, or null when the document should be sent whole.
 *
 * Null is the common answer and the cheap one: everything below the threshold, every single-page
 * document, and every document whose text the blocks do not account for.
 */
export function planPageChunks(source: ExtractionContract): PageChunk[] | null {
  const totalChars = source.document.plain_text.length;
  const pageCount = source.document.page_count;
  if (totalChars <= SPLIT_TEXT_THRESHOLD_CHARS || pageCount < 2) return null;

  const blockChars = source.blocks.reduce((sum, block) => sum + block.text.length, 0);
  if (blockChars < totalChars * MIN_BLOCK_TEXT_COVERAGE) return null;

  const desired = Math.min(
    MAX_SPLIT_CALLS,
    Math.max(2, Math.ceil(totalChars / SPLIT_TARGET_CHARS)),
  );
  const pagesPerChunk = Math.ceil(pageCount / desired);
  const chunks: PageChunk[] = [];
  for (let start = 1; start <= pageCount; start += pagesPerChunk) {
    chunks.push({
      start_page: start,
      end_page: Math.min(pageCount, start + pagesPerChunk - 1),
    });
  }
  // A single chunk is not a split; it is the whole document with extra bookkeeping.
  return chunks.length > 1 ? chunks : null;
}

/**
 * One page range as a standalone extraction, numbered from page 1.
 *
 * Local page numbers are not cosmetic: the response validator requires packet segments to start at
 * page 1 and tile up to `page_count`, so a chunk that announced global page numbers would be
 * rejected as malformed. Block, table and mark IDs are left alone — they are opaque, they stay
 * unique across the document, and `evidence_block_ids` therefore still resolve after the merge.
 */
export function sliceExtractionByPages(
  source: ExtractionContract,
  chunk: PageChunk,
): ExtractionContract {
  const inRange = (page: number) =>
    page >= chunk.start_page && page <= chunk.end_page;
  const localPage = (page: number) => page - chunk.start_page + 1;

  const blocks = source.blocks.filter((block) => inRange(block.page))
    .map((block) => ({ ...block, page: localPage(block.page) }));
  const blockIds = new Set(blocks.map((block) => block.id));

  return {
    schema_version: "1",
    document: {
      page_count: chunk.end_page - chunk.start_page + 1,
      detected_languages: source.document.detected_languages,
      // Rebuilt from the blocks of these pages rather than sliced out of plain_text: the joiner
      // between pages is an adapter detail, and cutting a string on a guess about it would move
      // half a price row into the wrong call.
      plain_text: blocks.map((block) => block.text).join("\n\n"),
      partial: source.document.partial,
    },
    blocks,
    tables: source.tables.filter((table) => inRange(table.page))
      .map((table) => ({ ...table, page: localPage(table.page) })),
    marks: source.marks.filter((mark) => inRange(mark.page))
      .map((mark) => ({
        ...mark,
        page: localPage(mark.page),
        // A neighbour on a page this call cannot see is not a neighbour it can reason about.
        nearby_block_ids: mark.nearby_block_ids.filter((id) => blockIds.has(id)),
      })),
  };
}

function mergeUsage(parts: readonly ProviderUsage[]): ProviderUsage {
  const sum = (pick: (usage: ProviderUsage) => number | null) => {
    const values = parts.map(pick).filter((value): value is number => value !== null);
    return values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
  };
  return {
    input_tokens: sum((usage) => usage.input_tokens),
    output_tokens: sum((usage) => usage.output_tokens),
    total_tokens: sum((usage) => usage.total_tokens),
    cached_input_tokens: sum((usage) => usage.cached_input_tokens),
    reasoning_output_tokens: sum((usage) => usage.reasoning_output_tokens),
  };
}

/** null beats any number: an unknown confidence must not be averaged into a confident-looking one. */
function weakestConfidence(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return Math.min(...(values as number[]));
}

function mergePacketSegments(
  parts: readonly { chunk: PageChunk; interpretation: InterpretationContract }[],
): InterpretationContract["packet_segments"] {
  const flattened = parts.flatMap(({ chunk, interpretation }) =>
    interpretation.packet_segments.map((segment) => ({
      ...segment,
      start_page: segment.start_page + chunk.start_page - 1,
      end_page: segment.end_page + chunk.start_page - 1,
    }))
  );
  // A price list cut into four calls comes back as four "price_list" segments that are really one
  // document. Coalescing them is what lets document_type stay "price_list" instead of collapsing
  // to "other" — the contract requires "other" whenever more than one segment survives.
  const merged: InterpretationContract["packet_segments"] = [];
  for (const segment of flattened) {
    const previous = merged[merged.length - 1];
    if (
      previous && previous.document_type === segment.document_type &&
      previous.end_page + 1 === segment.start_page
    ) {
      previous.end_page = segment.end_page;
      previous.confidence = weakestConfidence([previous.confidence, segment.confidence]);
      continue;
    }
    merged.push({ ...segment, ordinal: merged.length + 1 });
  }
  return merged.map((segment, index) => ({ ...segment, ordinal: index + 1 }));
}

function mergeSupplier(
  parts: readonly InterpretationContract[],
): InterpretationContract["supplier"] {
  const identified = parts.map((part) => part.supplier)
    .filter((supplier) => supplier.suggested_id !== null);
  const best = identified.length > 0
    ? identified.reduce((a, b) => (b.confidence ?? -1) > (a.confidence ?? -1) ? b : a)
    : parts.map((part) => part.supplier)
      .reduce((a, b) => (b.confidence ?? -1) > (a.confidence ?? -1) ? b : a);
  // Only evidence from the calls that named the SAME supplier. Pooling every chunk's evidence
  // would attach one call's citation to another call's answer.
  const evidence = new Set(
    parts.map((part) => part.supplier)
      .filter((supplier) => supplier.suggested_id === best.suggested_id)
      .flatMap((supplier) => supplier.evidence_block_ids),
  );
  return { ...best, evidence_block_ids: [...evidence] };
}

function mergeFields(
  parts: readonly InterpretationContract[],
): InterpretationContract["fields"] {
  const byKey = new Map<string, InterpretationContract["fields"][number]>();
  for (const field of parts.flatMap((part) => part.fields)) {
    const existing = byKey.get(field.key);
    // A header field appears on the first page and possibly repeats. Highest confidence wins;
    // a tie keeps the earlier page, which is where headers actually live.
    if (!existing || (field.confidence ?? -1) > (existing.confidence ?? -1)) {
      byKey.set(field.key, field);
    }
  }
  return [...byKey.values()].slice(0, MAX_MERGED_FIELDS);
}

function mergeAnnotations(
  parts: readonly InterpretationContract[],
): InterpretationContract["suggested_annotations"] {
  const seen = new Set<string>();
  const merged: InterpretationContract["suggested_annotations"] = [];
  for (const annotation of parts.flatMap((part) => part.suggested_annotations)) {
    const key = `${annotation.tag_key} ${[...annotation.target_block_ids].sort().join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(annotation);
    if (merged.length >= MAX_MERGED_ANNOTATIONS) break;
  }
  return merged;
}

export interface MergedSplit {
  result: ProviderResult;
  /** Recorded as evidence: how the document was cut, and what the merge had to drop. */
  summary: {
    chunks: PageChunk[];
    line_items: { produced: number; kept: number };
    document_type_agreed: boolean;
  };
}

/**
 * One answer from several. Chunk order is page order, and every list is merged in that order so a
 * price list reads top to bottom exactly as the document does.
 */
export function mergeSplitResults(
  parts: readonly { chunk: PageChunk; result: ProviderResult }[],
): MergedSplit {
  if (parts.length === 0) {
    throw new InterpretationError("provider_invalid_output", 502, false);
  }
  const interpretations = parts.map((part) => part.result.interpretation);
  const packetSegments = mergePacketSegments(
    parts.map(({ chunk, result }) => ({ chunk, interpretation: result.interpretation })),
  );
  const types = new Set(packetSegments.map((segment) => segment.document_type));
  const documentTypeAgreed = types.size === 1;

  const producedLineItems = interpretations.reduce(
    (sum, part) => sum + part.line_items.length,
    0,
  );
  const lineItems = interpretations.flatMap((part) => part.line_items)
    .slice(0, MAX_MERGED_LINE_ITEMS);

  const interpretation: InterpretationContract = {
    schema_version: "1",
    // The contract's own rule, not a preference: more than one surviving segment means the pages
    // did not describe a single document, and "other" is the only honest header for that.
    document_type: documentTypeAgreed
      ? packetSegments[0].document_type
      : "other",
    document_type_confidence: documentTypeAgreed
      ? weakestConfidence(interpretations.map((part) => part.document_type_confidence))
      : null,
    packet_segments: packetSegments,
    supplier: mergeSupplier(interpretations),
    fields: mergeFields(interpretations),
    line_items: lineItems,
    suggested_annotations: mergeAnnotations(interpretations),
  };

  return {
    result: {
      interpretation,
      provider_request_id: parts[0].result.provider_request_id,
      model: parts[0].result.model,
      usage: mergeUsage(parts.map((part) => part.result.usage)),
    },
    summary: {
      chunks: parts.map((part) => part.chunk),
      line_items: { produced: producedLineItems, kept: lineItems.length },
      document_type_agreed: documentTypeAgreed,
    },
  };
}

export interface InterpretationPlan {
  payloads: ProviderPayload[];
  chunks: PageChunk[] | null;
}

/** What to send: one payload for the whole document, or one per page range. */
export function planInterpretation(
  source: ExtractionContract,
  suppliers: readonly SupplierCandidate[],
  rules: readonly LearningRuleSummary[],
  trustedDocumentType: "price_list" | null,
): InterpretationPlan {
  const chunks = planPageChunks(source);
  if (chunks === null) {
    return {
      payloads: [buildProviderPayload(source, suppliers, rules, trustedDocumentType)],
      chunks: null,
    };
  }
  return {
    payloads: chunks.map((chunk) =>
      buildProviderPayload(
        sliceExtractionByPages(source, chunk),
        suppliers,
        rules,
        trustedDocumentType,
      )
    ),
    chunks,
  };
}

/**
 * Run the plan. Concurrent by design — see the module note: the fenced budget bounds wall time, so
 * parallel calls fit where sequential ones would not.
 */
export async function runInterpretationPlan(
  provider: InterpretationProvider,
  plan: InterpretationPlan,
  /**
   * Called as each chunk lands, so the screen can say how much of the wait is left. Observation
   * only: it is never awaited and a throw here must not reach the caller, because a status line
   * has no business failing an interpretation that is succeeding.
   */
  onProgress?: (done: number, total: number) => void,
): Promise<MergedSplit> {
  const total = plan.chunks?.length ?? 1;
  let done = 0;
  const report = () => {
    done += 1;
    try {
      onProgress?.(done, total);
    } catch { /* a counter is not worth an interpretation */ }
  };
  if (plan.chunks === null) {
    const result = await provider.interpret(plan.payloads[0]);
    report();
    return {
      result,
      summary: {
        chunks: [],
        line_items: {
          produced: result.interpretation.line_items.length,
          kept: result.interpretation.line_items.length,
        },
        document_type_agreed: true,
      },
    };
  }
  const chunks = plan.chunks;
  const results = await Promise.all(
    plan.payloads.map((payload) =>
      provider.interpret(payload).then((result) => {
        report();
        return result;
      })
    ),
  );
  return mergeSplitResults(results.map((result, index) => ({ chunk: chunks[index], result })));
}
