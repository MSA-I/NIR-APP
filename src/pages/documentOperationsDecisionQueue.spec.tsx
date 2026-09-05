/**
 * The operations console's three decision defects, measured against production BEFORE this was
 * written (`docs/qa/2026-09-04/evidence/PR39-OWN-02-MEASUREMENT.txt`).
 *
 * `OWN-02` — the price column renders `current ← proposed` unconditionally, so four different
 *   facts arrive on screen as the same `— ← —`. Production, org `1111…`, 737 queue rows: ONE is an
 *   empty run, 736 are real lines, 675 carry a proposed price and no current one (`create_product`
 *   — the product is not in the catalogue yet, so there is no previous price and that is correct),
 *   61 carry no price at all, and NOT ONE row in the whole queue has both. Every assertion below is
 *   therefore per row, on that row's own shape; a count over the table would have been green the
 *   whole time.
 * `OWN-07` — two numbers answer "how much is waiting for your decision": the tile's 40
 *   (`documents_review_required`, a count of DOCUMENTS whose latest job is `review`) and the
 *   table's 737 (price-list LINES). Neither said which.
 * `OWN-08` — `attemptUiStatus` returns the canonical status for four states only, so
 *   `awaiting_scan` — nine of this tenant's documents, attempt_count 0 — fell past every branch to
 *   the residual and reached the owner as „מצב לא ידוע".
 *
 * Copy is asserted twice, the way `documentOperationsContract.spec.ts` already does it: the words
 * in the rendered DOM, and the KEY in the source. Words alone pass a screen that stopped rendering
 * them; keys alone pass a tile relabelled in the dictionary.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { he } from '../lib/i18n/dictionaries/he';
import { fmtMoneyRounded } from '../lib/format';
import { attemptUiStatus } from './documentOperationsModel';

const runtime = vi.hoisted(() => ({
  attempts: [] as Record<string, unknown>[],
  priceReviews: [] as Record<string, unknown>[],
  refetch: vi.fn(async () => true),
  operationsMetrics: {
    window_days: 30,
    documents_waiting: 0,
    documents_processing: 0,
    documents_stuck: 0,
    documents_review_required: 40,
    documents_failed: 0,
    documents_completed: 8,
    retry_count: 0,
    average_processing_duration_ms: null,
    last_processing_at: null,
  },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ organizationAccess: { canWrite: true }, profile: { role: 'owner' } }),
}));

vi.mock('../lib/supabase', () => ({
  supabase: { functions: { invoke: vi.fn() }, rpc: vi.fn(async () => ({ data: null, error: null })) },
}));

vi.mock('../lib/useDocumentProcessing', () => ({
  DOCUMENT_PROCESSING_CHANGED_EVENT: 'supplyflow:document-processing-changed',
  useDocumentProcessing: () => ({ snapshots: {}, refetch: runtime.refetch }),
}));

vi.mock('../lib/useQuery', () => ({
  unwrap: (result: { data: unknown; error: unknown }) => {
    if (result.error) throw result.error;
    return result.data;
  },
  useQuery: (query: () => Promise<unknown>) => {
    const source = String(query);
    const data = source.includes('get_document_operations_metrics')
      ? runtime.operationsMetrics
      : source.includes('get_document_control_attempts')
        ? runtime.attempts
        : source.includes('get_document_control_price_review_queue')
          ? runtime.priceReviews
          : [];
    return { data, loading: false, fetching: false, error: null, refetch: runtime.refetch };
  },
}));

const screenSource = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentOperations.tsx'), 'utf8');
const ILS = 'ILS';

/**
 * Five rows, four of which the shipped column cannot tell apart. The document ids repeat on
 * purpose: the queue counts LINES and the reconciliation sentence counts DOCUMENTS, so a fixture
 * where those two numbers coincide would prove nothing about either.
 */
const PRICE_ROWS = [
  {
    review_key: 'line-pair', document_id: 'doc-a', file_name: 'pair.pdf', supplier_name: 'ספק א',
    source_row: 3, predicted_action: 'apply_existing_price', product_name: 'קמח', matched_product_name: 'קמח',
    sku: 'A1', current_unit_price: 12, proposed_unit_price: 15, currency: ILS,
    document_line_count: 2, document_reviewed_count: 0, is_empty_run: false,
  },
  {
    review_key: 'line-new', document_id: 'doc-a', file_name: 'new-product.pdf', supplier_name: 'ספק א',
    source_row: 4, predicted_action: 'create_product', product_name: 'סוכר', matched_product_name: null,
    sku: 'A2', current_unit_price: null, proposed_unit_price: 15, currency: ILS,
    document_line_count: 2, document_reviewed_count: 0, is_empty_run: false,
  },
  {
    review_key: 'line-unpriced', document_id: 'doc-b', file_name: 'no-price.pdf', supplier_name: 'ספק ב',
    source_row: 1, predicted_action: 'review', product_name: 'מרגרינה', matched_product_name: null,
    sku: null, current_unit_price: null, proposed_unit_price: null, currency: ILS,
    document_line_count: 61, document_reviewed_count: 0, is_empty_run: false,
  },
  {
    review_key: 'line-current-only', document_id: 'doc-b', file_name: 'no-proposal.pdf', supplier_name: 'ספק ב',
    source_row: 2, predicted_action: 'review', product_name: 'שמן', matched_product_name: 'שמן',
    sku: null, current_unit_price: 12, proposed_unit_price: null, currency: ILS,
    document_line_count: 61, document_reviewed_count: 0, is_empty_run: false,
  },
  {
    review_key: 'run-empty', document_id: 'doc-c', file_name: 'empty-run.pdf', supplier_name: null,
    source_row: null, predicted_action: 'review', product_name: null, matched_product_name: null,
    sku: null, current_unit_price: null, proposed_unit_price: null, currency: null,
    document_line_count: 0, document_reviewed_count: 0, is_empty_run: true,
  },
];

const ATTEMPTS = [
  {
    job_id: 'job-scan', document_id: 'doc-scan', file_name: 'consolidated-page-1.png',
    status: 'awaiting_scan', attempt_count: 0,
    created_at: '2026-09-02T21:41:00.000Z', updated_at: '2026-09-02T21:43:00.000Z',
    queue_age_seconds: 180_000, price_list_outcome: null, is_stuck: false, stuck_reason: null,
    last_error_code: null,
  },
  {
    // The control. A status no ladder has ever heard of must STILL read „מצב לא ידוע": the residual
    // is not the defect — naming a known state with it was.
    job_id: 'job-alien', document_id: 'doc-alien', file_name: 'alien-status.pdf',
    status: 'teleported', attempt_count: 0,
    created_at: '2026-09-02T21:41:00.000Z', updated_at: '2026-09-02T21:43:00.000Z',
    queue_age_seconds: 180_000, price_list_outcome: null, is_stuck: false, stuck_reason: null,
    last_error_code: null,
  },
];

async function renderConsole() {
  runtime.attempts = ATTEMPTS.map((row) => ({ ...row, id: row.job_id }));
  runtime.priceReviews = PRICE_ROWS.map((row) => ({ ...row, id: row.review_key }));
  const { default: DocumentOperations } = await import('./DocumentOperations');
  render(createElement(
    ToastProvider,
    null,
    createElement(
      MemoryRouter,
      { initialEntries: ['/documents/operations'] },
      createElement(Routes, null, createElement(Route, {
        path: '/documents/operations',
        element: createElement(DocumentOperations),
      })),
    ),
  ));
}

/** The desktop table row carrying this file name — the mobile card list repeats every cell. */
function tableRow(file: string): HTMLElement {
  const row = screen.getAllByRole('row').find((candidate) => candidate.textContent?.includes(file));
  if (!row) throw new Error(`no table row for ${file}`);
  return row;
}

describe('OWN-02 · the price column states what the row actually has', () => {
  it('CONTROL — a row with both prices still shows the comparison it was built for', async () => {
    await renderConsole();

    const pair = tableRow('pair.pdf');
    expect(pair.textContent).toContain(fmtMoneyRounded(12, ILS));
    expect(pair.textContent).toContain(fmtMoneyRounded(15, ILS));
    expect(pair.textContent).toContain('←');
  });

  it('renders one true statement per row, not one arrow for all of them', async () => {
    await renderConsole();

    // 675 of production's 737 rows. The proposed price is real and was hidden behind an arrow
    // whose other side can never exist: the product is not in the catalogue yet.
    const proposedOnly = tableRow('new-product.pdf');
    expect(proposedOnly.textContent).toContain(fmtMoneyRounded(15, ILS));
    expect(proposedOnly.textContent).toContain('אין מחיר קודם להשוואה');
    expect(proposedOnly.textContent).not.toContain('←');

    // 61 of production's 737 — the rows the sweep photographed on page 1.
    const unpriced = tableRow('no-price.pdf');
    expect(unpriced.textContent).toContain('לא נקרא מחיר לשורה');
    expect(unpriced.textContent).not.toContain('←');

    const currentOnly = tableRow('no-proposal.pdf');
    expect(currentOnly.textContent).toContain(fmtMoneyRounded(12, ILS));
    expect(currentOnly.textContent).toContain('המסמך לא ציין מחיר חדש');
    expect(currentOnly.textContent).not.toContain('←');

    // The one empty run in production. It must say so and never draw a pair it does not have.
    const emptyRun = tableRow('empty-run.pdf');
    expect(emptyRun.textContent).toContain(he.documentOps.text_12);
    expect(emptyRun.textContent).toContain('אין שורות מחיר');
    expect(emptyRun.textContent).not.toContain('←');
  });

  it('reads a figure with no currency as no price at all, never as a bare number', async () => {
    // format.ts:23-32 — an amount without its unit is not money. The row still has to say which of
    // the two it is, so it joins the unpriced sentence rather than printing a naked 15.
    runtime.priceReviews = [{
      ...PRICE_ROWS[1], review_key: 'line-no-currency', id: 'line-no-currency',
      file_name: 'no-currency.pdf', currency: null,
    }];
    runtime.attempts = [];
    const { default: DocumentOperations } = await import('./DocumentOperations');
    render(createElement(
      ToastProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: ['/documents/operations'] },
        createElement(Routes, null, createElement(Route, {
          path: '/documents/operations',
          element: createElement(DocumentOperations),
        })),
      ),
    ));
    const row = tableRow('no-currency.pdf');
    expect(row.textContent).toContain('לא נקרא מחיר לשורה');
    expect(row.textContent).not.toContain('15');
  });

  it('draws each sentence from the dictionary, not from a literal in the screen', () => {
    // The KEY, wherever the screen names it — the four sentences are chosen through one `noteKey`
    // rather than four `t(...)` call sites, so the literal is what there is to pin.
    for (const key of ['priceNoPrevious', 'priceNoProposal', 'priceNotRead', 'priceNoLines']) {
      expect(screenSource).toContain(`'documentOps.${key}'`);
    }
  });
});

describe('OWN-07 · both counts carry their unit', () => {
  it('names documents on the tile and price-list lines on the queue', async () => {
    await renderConsole();

    // 40 DOCUMENTS. The tile said "waiting for your decision" and left the reader to guess.
    expect(screen.getByText('מסמכים שממתינים להחלטה שלך')).toBeTruthy();
    expect(he.documentOps.sub).toBe('מסמכים שממתינים להחלטה שלך');

    // 737 price-list LINES, from three documents in this fixture. The sentence carries the unit of
    // the rows and the document count — which is what lets a manager reconcile the two figures.
    const documents = new Set(PRICE_ROWS.map((row) => row.document_id)).size;
    expect(documents).toBe(3);
    expect(screen.getByText('כל שורה כאן היא שורת מחירון — 3 מסמכים ממתינים לבדיקת מחירים.')).toBeTruthy();
    expect(screenSource).toContain("t('documentOps.priceQueueUnit'");
  });
});

describe('OWN-08 · the console names every state the ladder names', () => {
  it('keeps the canonical answer instead of overwriting it with the residual', () => {
    expect(attemptUiStatus({ status: 'awaiting_scan', price_list_outcome: null }).labelKey)
      .toBe('documentStatus.awaitingScanApproval');
  });

  it('CONTROL — still answers with the residual for a status nothing can name', () => {
    expect(attemptUiStatus({ status: 'teleported', price_list_outcome: null }).labelKey)
      .toBe('documentOperations.unknownState');
  });

  it('shows the scan-approval state on the row instead of an unknown one', async () => {
    await renderConsole();

    const scan = tableRow('consolidated-page-1.png');
    expect(within(scan).getAllByText(he.documentStatus.awaitingScanApproval).length).toBeGreaterThan(0);
    expect(scan.textContent).not.toContain(he.documentOperations.unknownState);
  });

  it('CONTROL — an unnameable status still reads „מצב לא ידוע" on its row', async () => {
    await renderConsole();

    const alien = tableRow('alien-status.pdf');
    expect(within(alien).getAllByText(he.documentOperations.unknownState).length).toBeGreaterThan(0);
  });

  it('files the scan-approval document under דורש טיפול, never under הושלם', async () => {
    await renderConsole();
    const filter = screen.getAllByLabelText(he.documentOps.aria_label_3)[0];

    // Naming the state and then filing it with finished work would put a document waiting on a
    // person behind the one filter nobody sweeps. It is work that stopped and waits — the same
    // bucket `review` is in, which is where `documentStatus.ts` ranks it.
    fireEvent.change(filter, { target: { value: 'attention' } });
    expect(tableRow('consolidated-page-1.png')).toBeTruthy();

    fireEvent.change(filter, { target: { value: 'completed' } });
    expect(screen.getAllByRole('row').some((r) => r.textContent?.includes('consolidated-page-1.png')))
      .toBe(false);
  });
});
