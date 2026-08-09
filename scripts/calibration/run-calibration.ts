/**
 * Calibration harness for the autonomy threshold (DEBT-REGISTER §16/§24, OPEN-DECISIONS #109).
 *
 * Owner decision (09.08.2026): the corpus is internet-collected Hebrew business documents
 * (NIR-APP-DOCS/calibration-corpus/<date>), not live-tenant documents — a STATED assumption:
 * this measures the pipeline on generic Hebrew documents; transfer to the live tenant's own
 * paper remains an assumption until 50 real documents are measured (§16's original ask).
 *
 * Zero drift from production where it matters: the payload builder, system prompt, model id,
 * JSON schema and provider retry logic are IMPORTED from the Edge Function's own core.ts —
 * not copied. What DOES differ, and is printed into every result file:
 *   - extraction: pdf.js text layer (one block per page, no tables/marks) instead of the OCR
 *     worker. Faithful for digital PDFs; a scanned PDF with no text layer is SKIPPED and
 *     counted, never guessed.
 *   - supplier_candidates: empty — there is no tenant catalogue here, so supplier matching
 *     measures name detection + confidence, not id resolution.
 *
 * Usage (Node 24, run from the repo root):
 *   node scripts/calibration/run-calibration.ts run     # interpret every corpus PDF -> results
 *   node scripts/calibration/run-calibration.ts score   # join results + adjudication -> report data
 *
 * The OpenAI key is read AT RUN TIME from NIR-APP-DOCS/NIR-API-OPENAI.txt (the documented
 * local-credentials convention) and never written anywhere.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  buildProviderPayload,
  createOpenAiProvider,
  MODEL_ID,
  PROMPT_VERSION,
  type ExtractionContract,
  type InterpretationContract,
} from '../../supabase/functions/interpret-document/core.ts';

const DOCS_ROOT = 'D:/משה פרוייקטים/פיתוח אתרים/NIR-APP-DOCS';
const CORPUS_DIR = process.env.CALIBRATION_CORPUS ?? join(DOCS_ROOT, 'calibration-corpus/20260808');
const RESULTS_DIR = join(CORPUS_DIR, 'results');
const ADJUDICATION = join(CORPUS_DIR, 'adjudication.json');
const KEY_FILE = join(DOCS_ROOT, 'NIR-API-OPENAI.txt');

// The shipped gate, and the two confidences it gates (0076): both must clear it.
const SHIPPED_THRESHOLD = 0.9;

interface DocResult {
  file: string;
  skipped: string | null;
  model: string;
  prompt_version: string;
  page_count: number;
  text_chars: number;
  document_type: string | null;
  document_type_confidence: number | null;
  supplier_name: string | null;
  supplier_confidence: number | null;
  total_amount: number | null;
  line_item_count: number;
  usage: unknown;
}

interface Adjudication {
  file: string;
  /** What a careful human reads off the document. Adjudicator: recorded in the report. */
  true_type: string;
  true_supplier_name: string | null;
  true_total: number | null;
  true_line_count: number | null;
  notes?: string;
}

async function extractPdf(path: string): Promise<{ contract: ExtractionContract; chars: number } | null> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(readFileSync(path));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  await doc.destroy();
  const plain = pages.join('\n\n').replace(/\s+/g, ' ').trim();
  if (plain.length < 40) return null; // scanned image, no text layer — needs the OCR worker
  return {
    chars: plain.length,
    contract: {
      schema_version: '1',
      document: {
        page_count: doc.numPages,
        detected_languages: ['he'],
        plain_text: pages.join('\n\n'),
        partial: false,
      },
      blocks: pages.map((text, index) => ({
        id: `page-${index + 1}`,
        page: index + 1,
        type: 'text' as const,
        bbox: [0, 0, 1, 1] as [number, number, number, number],
        text,
        confidence: null,
      })),
      tables: [],
      marks: [],
    },
  };
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[\s,₪]/g, '');
    return /^-?\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
  }
  return null;
}

function fieldValue(interpretation: InterpretationContract, keys: string[]): unknown {
  for (const field of interpretation.fields) {
    if (keys.includes(field.key.trim().toLowerCase())) return field.value;
  }
  return null;
}

async function runCorpus() {
  const apiKey = readFileSync(KEY_FILE, 'utf8').trim().split(/\r?\n/).filter((l) => l && !l.startsWith('#')).at(-1)!;
  mkdirSync(RESULTS_DIR, { recursive: true });
  const provider = createOpenAiProvider({ apiKey });
  const files = readdirSync(CORPUS_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
  const results: DocResult[] = [];
  for (const file of files) {
    const resultPath = join(RESULTS_DIR, `${file}.json`);
    if (existsSync(resultPath)) { // idempotent: a re-run never re-bills a finished document
      results.push(JSON.parse(readFileSync(resultPath, 'utf8')) as DocResult);
      continue;
    }
    process.stdout.write(`interpreting ${file} ... `);
    const base: DocResult = {
      file, skipped: null, model: MODEL_ID, prompt_version: PROMPT_VERSION,
      page_count: 0, text_chars: 0, document_type: null, document_type_confidence: null,
      supplier_name: null, supplier_confidence: null, total_amount: null,
      line_item_count: 0, usage: null,
    };
    try {
      const extracted = await extractPdf(join(CORPUS_DIR, file));
      if (!extracted) {
        base.skipped = 'no_text_layer';
        console.log('SKIP (no text layer — needs the OCR worker)');
      } else {
        base.page_count = extracted.contract.document.page_count;
        base.text_chars = extracted.chars;
        const payload = buildProviderPayload(extracted.contract, [], [], null);
        const outcome = await provider.interpret(payload);
        const interpretation = outcome.interpretation;
        base.document_type = interpretation.document_type;
        base.document_type_confidence = interpretation.document_type_confidence;
        base.supplier_name = interpretation.supplier.suggested_name;
        base.supplier_confidence = interpretation.supplier.confidence;
        base.total_amount = numeric(fieldValue(interpretation, ['total_amount', 'total', 'סה"כ', 'סה״כ לתשלום']));
        base.line_item_count = interpretation.line_items.length;
        base.usage = outcome.usage;
        console.log(`${base.document_type} (type ${base.document_type_confidence}, supplier ${base.supplier_confidence})`);
      }
    } catch (error) {
      base.skipped = `error: ${(error as Error).message}`;
      console.log(`ERROR ${(error as Error).message}`);
    }
    writeFileSync(resultPath, JSON.stringify(base, null, 2), 'utf8');
    results.push(base);
  }
  writeFileSync(join(RESULTS_DIR, 'all-results.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n${results.length} documents, ${results.filter((r) => r.skipped).length} skipped.`);
}

/**
 * Would the shipped policy have written a financial record for this interpretation?
 * Mirrors production end to end: the 0076 gate passes only when BOTH confidences clear the
 * threshold, and the writers themselves (apply_document_interpretation / price-list intake)
 * only exist for invoices and price lists — any other type queues regardless of confidence.
 */
function machineWrites(r: DocResult, threshold: number): boolean {
  return r.skipped === null
    && (r.document_type === 'invoice' || r.document_type === 'price_list')
    && r.document_type_confidence !== null && r.document_type_confidence >= threshold
    && r.supplier_confidence !== null && r.supplier_confidence >= threshold;
}

/** Was the interpretation actually right, by the adjudicated ground truth? */
function interpretationCorrect(r: DocResult, truth: Adjudication): boolean {
  if (r.document_type !== truth.true_type) return false;
  if (truth.true_supplier_name !== null) {
    const got = (r.supplier_name ?? '').replace(/["״'’\s]/g, '');
    const want = truth.true_supplier_name.replace(/["״'’\s]/g, '');
    if (!got || (!got.includes(want) && !want.includes(got))) return false;
  }
  if (truth.true_total !== null && r.total_amount !== null
      && Math.abs(r.total_amount - truth.true_total) > 0.01) return false;
  if (truth.true_total !== null && r.total_amount === null) return false;
  return true;
}

function score() {
  const results = JSON.parse(readFileSync(join(RESULTS_DIR, 'all-results.json'), 'utf8')) as DocResult[];
  const truths = JSON.parse(readFileSync(ADJUDICATION, 'utf8')) as Adjudication[];
  const byFile = new Map(truths.map((t) => [t.file, t]));
  const rows = results.filter((r) => r.skipped === null && byFile.has(r.file));

  const sweep: Array<Record<string, number>> = [];
  for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]) {
    let fp = 0, fn = 0, tp = 0, tn = 0;
    for (const r of rows) {
      const truth = byFile.get(r.file)!;
      const writes = machineWrites(r, threshold);
      const correct = interpretationCorrect(r, truth);
      // FN counts only documents a writer EXISTS for — queuing a tender or a blank form is
      // the machine being right, not a miss.
      const writableTruth = truth.true_type === 'invoice' || truth.true_type === 'price_list';
      if (writes && correct) tp += 1;
      else if (writes && !correct) fp += 1;       // wrote what a person would not — the expensive one
      else if (!writes && correct && writableTruth) fn += 1; // queued something that was actually right
      else tn += 1;
    }
    sweep.push({ threshold, auto_written_correct: tp, false_positive: fp, queued_but_correct: fn, queued_and_wrong: tn });
  }

  const out = {
    generated_for: { model: MODEL_ID, prompt_version: PROMPT_VERSION, shipped_threshold: SHIPPED_THRESHOLD },
    corpus: {
      total: results.length,
      skipped_no_text: results.filter((r) => r.skipped === 'no_text_layer').length,
      errored: results.filter((r) => r.skipped?.startsWith('error')).length,
      adjudicated: rows.length,
    },
    sweep,
    per_document: rows.map((r) => {
      const truth = byFile.get(r.file)!;
      return {
        file: r.file,
        machine: { type: r.document_type, type_conf: r.document_type_confidence, supplier: r.supplier_name, supplier_conf: r.supplier_confidence, total: r.total_amount },
        truth: { type: truth.true_type, supplier: truth.true_supplier_name, total: truth.true_total },
        would_write_at_shipped: machineWrites(r, SHIPPED_THRESHOLD),
        correct: interpretationCorrect(r, truth),
      };
    }),
  };
  writeFileSync(join(RESULTS_DIR, 'calibration-score.json'), JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out.sweep, null, 2));
  console.log(`scored ${rows.length} adjudicated documents -> ${join(RESULTS_DIR, 'calibration-score.json')}`);
}

const mode = process.argv[2];
if (mode === 'run') await runCorpus();
else if (mode === 'score') score();
else {
  console.error('usage: node scripts/calibration/run-calibration.ts run|score');
  process.exit(1);
}
