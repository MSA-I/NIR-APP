/**
 * Two server-owned page limits that are NOT the same limit — declared together, once, precisely
 * because they were the same number until migration 0144 and are now easy to confuse.
 *
 * These are copies for the wording of Hebrew sentences, and nothing in the client decides anything
 * with them: whether a packet was actually split without a person is `document_packets
 * .automatic_eligible`, and whether the extraction covered the file is `document_packets
 * .source_partial`. Both are read off the row. When a number moves on the server it moves here,
 * and the two sentences follow it.
 */

/**
 * `ExtractionLimits.max_ai_pages` — `worker/ocr/src/limits.py:25`.
 *
 * How many pages of a SCANNED document the paid provider transcribes. `parsers._parse_pdf` sends
 * `missing[: max_ai_pages]` and nothing beyond it, so a page past the cap is never rendered and
 * never read — and `page_text_is_partial` therefore reports the extraction as partial. It did NOT
 * move in 0144: it is a per-document provider bill, not a review policy.
 */
export const PAID_OCR_PAGE_CAP = 20;

/**
 * The automatic packet-split ceiling — `supabase/migrations/0144_document_packet_page_ceiling.sql`.
 *
 * A packet longer than this is never split without a person, however sure the model was. It moved
 * from 20 to 40, and what that unlocks is a 21–40 page PDF that carries its own text layer: those
 * never enter the OCR branch and come out complete. A SCANNED packet of the same length still has
 * pages past `PAID_OCR_PAGE_CAP` that nobody read, is honestly partial, and is still refused by
 * the `not partial` arm of the very same rule.
 */
export const AUTOMATIC_SPLIT_PAGE_CEILING = 40;
