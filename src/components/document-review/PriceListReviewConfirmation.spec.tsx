import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DocumentProcessingSnapshot, PriceListPredictedLine } from '../../lib/useDocumentProcessing';

const mocks = vi.hoisted(() => ({
  role: 'owner',
  /** The tenant's catalogue. Emptied by the first-run test — that is the whole state under test. */
  catalogue: [] as Array<{ id: string; name: string; unit: string; sku: string | null }>,
  rpc: vi.fn(),
  insert: vi.fn((rows: Array<Record<string, unknown>>) => ({
    data: rows.map((row, index) => ({
      id: `new-product-${index}`, name: row.name, unit: row.unit, sku: row.sku,
    })),
    error: null,
  })),
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { id: `${mocks.role}-1`, role: mocks.role, org_id: 'org-1' } }),
}));

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: mocks.catalogue, error: null }),
        }),
      }),
      insert: (rows: Array<Record<string, unknown>>) => ({
        select: async () => mocks.insert(rows),
      }),
    }),
    rpc: (...args: unknown[]) => mocks.rpc(...args),
  },
}));

import { PriceListReviewConfirmation } from './PriceListReviewConfirmation';

const LINE_COUNT = 22;
const UNMATCHED_LINES = 2;
const QUALIFIED_DRY_RUN = {
  interpretation_id: 'interpretation-1', supplier_id: 'supplier-1',
  currency: 'USD',
  qualified_create_count: 2, existing_product_count: 1, ambiguous_count: 0,
  missing_qualification_count: 0, invalid_price_count: 0, mutated: false,
  rows: [
    { source_row: 1, sku: 'NEW-1', barcode: null, product_name: 'מוצר חדש 1', unit_price: 10, outcome: 'qualified_create' },
    { source_row: 2, sku: 'NEW-2', barcode: null, product_name: 'מוצר חדש 2', unit_price: 11, outcome: 'qualified_create' },
    { source_row: 3, sku: 'SKU-1', barcode: null, product_name: 'מוצר קיים', unit_price: 12, outcome: 'existing_product' },
  ],
};

beforeEach(() => {
  mocks.role = 'owner';
  mocks.catalogue = [{ id: 'product-1', name: 'מוצר בדיקה', unit: 'unit', sku: 'SKU-1' }];
  mocks.insert.mockClear();
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === 'get_price_list_calibration_preparation_queue') return { data: [], error: null };
    if (name === 'get_qualified_product_creation_dry_run') {
      return { data: QUALIFIED_DRY_RUN, error: null };
    }
    return { data: null, error: null };
  });
});

/**
 * A shadow prediction per line: every line matched to the one product the catalogue mock offers,
 * except the last two — one whose SKU matched nothing, one whose price could not be read. That is
 * the shape a real price list arrives in, and it is the only shape that distinguishes "one button"
 * from "one button plus the exceptions".
 */
function predictions(count = LINE_COUNT): PriceListPredictedLine[] {
  return Array.from({ length: count }, (_, index) => {
    const unmatched = index >= count - UNMATCHED_LINES;
    return {
      id: `shadow-line-${index}`,
      org_id: 'org-1',
      shadow_run_id: 'shadow-run-1',
      document_id: 'document-1',
      interpretation_id: 'interpretation-1',
      line_index: index,
      source_row: index + 1,
      predicted_action: unmatched ? 'review' : 'apply_existing_price',
      reason_code: unmatched
        ? index === count - 1 ? 'line_price_unreadable' : 'line_product_unmatched'
        : null,
      matched_by: unmatched ? null : 'sku',
      product_id: unmatched ? null : 'product-1',
      supplier_product_id: null,
      sku: unmatched ? null : `SKU-${index}`,
      barcode: null,
      product_name: `מוצר ${index + 1}`,
      unit: 'unit',
      proposed_unit_price: unmatched ? null : index + 10,
      current_unit_price: null,
      currency: 'USD',
      price_change_percent: null,
      product_would_be_created: false,
      created_at: '2026-08-17T00:00:00Z',
    };
  });
}

/* The calibration-queue fixtures stood here — `CALIBRATION_LINES`, `CALIBRATION_PAGED`,
   `preparationQueue` and `servePreparationQueue`, which modelled the server handing the queue over
   one window at a time. They served `PriceListAutomationReadiness` alone, and that component was
   deleted from the product on 04.09.2026 (owner ruling). See the describe block below. */

function snapshot(
  priceListPredictions: PriceListPredictedLine[],
  count = LINE_COUNT,
): DocumentProcessingSnapshot {
  const lineItems = Array.from({ length: count }, (_, index) => ({
    source_row: index + 1,
    values: { description: `מוצר ${index + 1}`, unit_price: index + 10 },
    evidence_block_ids: [],
  }));
  return {
    documentId: 'document-1', stage: 'review',
    document: {
      id: 'document-1', org_id: 'org-1', unit_id: null, entity_type: 'inbox', entity_id: null,
      storage_path: 'org-1/price-list.pdf', file_name: 'price-list.pdf', mime_type: 'application/pdf',
      document_kind: 'price_list', uploaded_by: 'owner-1', supplier_id: null, document_date: null,
      deleted_at: null, created_at: '2026-08-17T00:00:00Z',
    },
    job: { id: 'job-1', status: 'review', last_error_code: null, last_error_message: null },
    jobs: [], extraction: null, extractions: [],
    interpretation: {
      id: 'interpretation-1', org_id: 'org-1', document_id: 'document-1', provider: 'openai',
      model: 'fixture', prompt_version: 'v1', schema_version: '1', suggested_supplier_id: null,
      payload: {
        schema_version: '1', document_type: 'price_list', document_type_confidence: 0.99,
        supplier: { suggested_id: null, suggested_name: 'ספק בדיקה', confidence: 0.99, evidence_block_ids: [] },
        fields: [], line_items: lineItems, suggested_annotations: [],
      },
    },
    interpretations: [], annotations: [], ruleApplications: [], learningRules: [], reviewCorrections: [],
    typeReviewDecisions: [], filings: [], feedback: [], exportTemplates: [], exportTemplateVersions: [],
    exports: [], packet: null, packetSegments: [], actorNames: new Map(),
    priceListDecision: null, priceListLines: [], priceListPredictions,
  } as unknown as DocumentProcessingSnapshot;
}

describe('אישור מחירון', () => {
  it('parses a malformed receipt with the caller translation and never calls a hook from the parser', () => {
    const source = readFileSync('src/components/document-review/PriceListReviewConfirmation.tsx', 'utf8');
    const parser = source.slice(source.indexOf('function parseReceipt'), source.indexOf('async function recoverStoredReceipt'));
    expect(parser).not.toContain('useT()');
    expect(parser).toContain("throw new Error(t('priceListReview.receiptMalformed'))");
  });

  it('keeps receipt outcome counts but removes revision and idempotency implementation details', () => {
    const source = readFileSync('src/components/document-review/PriceListReviewConfirmation.tsx', 'utf8');
    const receipt = source.slice(source.indexOf('{receipt && ('), source.indexOf('<ConfirmDialog'));
    expect(receipt).not.toContain('receipt.revision');
    expect(receipt).not.toContain('receipt.idempotent');
    expect(receipt).toContain('receipt.accepted_count');
    expect(receipt).toContain('receipt.rejected_count');
    expect(receipt).toContain('receipt.unchanged_count');
  });

  it('קולט את השורות שזוהו בלחיצה אחת ומשאיר את הרשת הידנית מקופלת', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    // 20 of 22 prefilled, so the button commits them without the reviewer touching a line.
    expect(confirm).toHaveTextContent(`עדכון ${LINE_COUNT - UNMATCHED_LINES} המחירים`);
    // One sentence, and it counts what the reader can act on rather than what the matcher managed.
    expect(screen.getByTestId('price-list-intake-summary').textContent).toBe(
      `${LINE_COUNT} שורות במחירון · ${LINE_COUNT - UNMATCHED_LINES} מוכנות לקליטה · ${UNMATCHED_LINES} דורשות מוצר חדש.`,
    );
    // "פרטים נוספים" was removed outright (owner ruling 04.09.2026). The lines are reachable through
    // the one door that names the work waiting behind it, and through nothing else.
    expect(screen.queryByTestId('price-list-details-toggle')).toBeNull();
    expect(screen.getByTestId('price-list-show-unmatched')).toBeInTheDocument();
    expect(screen.queryByText(/אני מאשר שורה זו לקליטה/)).not.toBeInTheDocument();
    // The month and the audit note answer themselves and moved into the line panel; neither may
    // stand between the reader and the only button on the screen.
    expect(screen.queryByText('החודש קובע לאיזו גרסת מחירון ישויכו המחירים שנבחרו.')).toBeNull();
    // Nor may the three metadata tiles that used to sit above the decision.
    expect(screen.queryByText('הספק שהוצע בפירוש')).toBeNull();
    expect(screen.queryByText('עמודים שנקראו')).toBeNull();
    // No automatic intake ran on this document, so the screen must not describe one — and must not
    // call a finished reading "בעיבוד" while it waits for a person.
    expect(screen.getByText('ממתין לאישורך')).toBeInTheDocument();
    expect(screen.queryByText(/המערכת קולטת אוטומטית שורות בטוחות/)).not.toBeInTheDocument();
  });

  it('פותח רק את השורות שדורשות טיפול, ומאפשר לראות את כולן', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('price-list-intake-confirm')).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(UNMATCHED_LINES);
    expect(screen.getByText(/לא נמצא מק״ט או ברקוד/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('price-list-unmatched-filter'));
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(LINE_COUNT);
  });

  it('מציג את ראיית שורת המקור בסיכום עברי קומפקטי בלי שמות שדות גולמיים', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('price-list-intake-confirm')).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    const cards = screen.getAllByRole('article');
    expect(cards[0]).toHaveTextContent('תיאור:');
    expect(cards[0]).toHaveTextContent('מחיר ליחידה:');
    expect(cards[0]).not.toHaveTextContent('description');
    expect(cards[0]).not.toHaveTextContent('unit_price');
  });

  it('מחלק רשימה ארוכה לעמודים ומסמן עמוד שלם בסימון אחד', async () => {
    const LONG = 120;
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions(LONG), LONG)} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('price-list-intake-confirm')).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    await userEvent.click(screen.getByTestId('price-list-unmatched-filter'));
    // 120 lines, 50 to a page: the reviewer sees a window, not the whole list.
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(50);
    expect(screen.getAllByTestId('price-list-pager')[0].textContent).toContain('עמוד');

    await userEvent.click(screen.getAllByTestId('price-list-page-next')[0]);
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(50);

    // Clearing a whole page, then marking it again, is one click each way.
    const selectAll = screen.getByTestId('price-list-page-select-all');
    expect(selectAll).toBeChecked();
    await userEvent.click(selectAll);
    expect(screen.getByTestId('price-list-intake-confirm'))
      .toHaveTextContent(`עדכון ${LONG - UNMATCHED_LINES - 50} המחירים`);
    await userEvent.click(selectAll);
    expect(screen.getByTestId('price-list-intake-confirm'))
      .toHaveTextContent(`עדכון ${LONG - UNMATCHED_LINES} המחירים`);
  });

  /**
   * The first price list a new tenant uploads, which is where this screen is read for the first
   * time and where it used to read worst: the catalogue is empty, so nothing matches, so the one
   * button on offer said "קליטת 0" and was disabled — the screen asked the customer to do the
   * only thing it could not do. The reported symptom was a scan that read 74 lines perfectly and
   * a screen that answered with a red banner, a yellow banner and a dead button.
   */
  it('בקטלוג ריק מציע ליצור את המוצרים במקום להציע קליטה של אפס', async () => {
    const NEW_LINES = 4;
    mocks.catalogue = [];
    const unknown = predictions(NEW_LINES).map((line, index) => ({
      ...line,
      predicted_action: 'create_product' as const,
      matched_by: null,
      product_id: null,
      sku: `NEW-${index}`,
      product_name: `מוצר חדש ${index + 1}`,
      unit: 'יח׳',
      proposed_unit_price: 10 + index,
      product_would_be_created: true,
    }));

    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(unknown, NEW_LINES)} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    // What the customer is told, and what they are offered: a step, not a failure — and now in one
    // sentence with one button under it, instead of a blue note beside a disabled "קליטת 0".
    const summary = await screen.findByTestId('price-list-intake-summary');
    expect(summary.textContent).toBe(`${NEW_LINES} מוצרים במחירון — אף אחד מהם עדיין לא קיים אצלך.`);
    const create = screen.getByTestId('price-list-create-all');
    expect(create).toHaveTextContent(`יצירת ${NEW_LINES} המוצרים מהמחירון`);
    expect(create).toBeEnabled();
    // A button that could only ever have said "קליטת 0" is not disabled here, it is absent: there is
    // nothing to take in, so the screen offers the one act that changes that and no second control.
    expect(screen.queryByTestId('price-list-intake-confirm')).toBeNull();

    await userEvent.click(create);

    // One insert, one product per distinct name, each carrying the unit the scan read.
    await waitFor(() => expect(mocks.insert).toHaveBeenCalledTimes(1));
    const inserted = mocks.insert.mock.calls[0][0];
    expect(inserted).toHaveLength(NEW_LINES);
    expect(inserted.map((row) => row.name)).toEqual([
      'מוצר חדש 1', 'מוצר חדש 2', 'מוצר חדש 3', 'מוצר חדש 4',
    ]);
    // `normalizeUnitInput` canonicalises what the scan read — "יח׳" is stored as "יחידה", the
    // same form the per-line create writes, so a bulk create cannot fork the unit vocabulary.
    expect(new Set(inserted.map((row) => row.unit))).toEqual(new Set(['יחידה']));

    // And now the confirm button has something to confirm — the prices the scan already read. The
    // creation is reported by the same sentence that asked for it, not by a note added beneath it.
    await waitFor(() => expect(screen.getByTestId('price-list-intake-summary'))
      .toHaveTextContent('נוצרו 4 מוצרים'));
    await waitFor(() => expect(screen.getByTestId('price-list-intake-confirm'))
      .toHaveTextContent(`עדכון ${NEW_LINES} המחירים`));
  });

  it('בלי תחזית שמורה אינו ממלא כלום, אומר זאת, ומשאיר את האישור הידני זמין', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot([])} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('price-list-intake-summary')).toBeInTheDocument());
    // Nothing was compared, which is not the same fact as nothing matching — so the sentence may not
    // claim the catalogue lacks these products, and there is nothing to confirm.
    expect(screen.getByTestId('price-list-intake-summary'))
      .toHaveTextContent('לא נמצאה התאמה אוטומטית למסמך הזה');
    expect(screen.getByTestId('price-list-intake-summary').textContent)
      .not.toContain('עדיין לא קיים אצלך');
    expect(screen.queryByTestId('price-list-intake-confirm')).toBeNull();
    expect(screen.getByTestId('price-list-create-all')).toBeEnabled();

    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    expect(screen.getAllByText(/אני מאשר שורה זו לקליטה/)).toHaveLength(LINE_COUNT);
  });
});

/**
 * The exception path, counted in taps.
 *
 * A line the matcher could not key used to cost three interactions in a fixed order: tick "אני
 * מאשר שורה זו לקליטה" — which is what unlocked the fields — then pick a product, then retype the
 * price the machine had already read off that very row. The tick came first because the controls
 * were disabled without it, i.e. the reviewer approved a line before being allowed to say what it
 * was.
 */
describe('שורה שדורשת טיפול — פעולה אחת, לא שלוש', () => {
  /**
   * The ordinary unmatched line: the document printed a price for it, the matcher just could not
   * key it to a product. The shared fixture nulls the price on both exceptions, which collapses
   * two different failures — "no product" and "no price" — into one shape.
   */
  const pricedButUnmatched = (rows: PriceListPredictedLine[]) => rows.map((row, index) =>
    index === rows.length - UNMATCHED_LINES ? { ...row, proposed_unit_price: 42 } : row);

  it('בוחרים מוצר, המחיר שנקרא נכנס לבד, והשורה מצטרפת לספירה', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(pricedButUnmatched(predictions()))} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    await userEvent.click(screen.getByTestId('price-list-unmatched-filter'));

    // The line whose SKU matched nothing, but whose price the document printed. Its select is live
    // before any tick: describing the line is the work, approving it is the conclusion.
    const row = LINE_COUNT - UNMATCHED_LINES;
    const select = screen.getAllByTestId('price-list-row-product')[row];
    expect(select).toBeEnabled();
    await userEvent.selectOptions(select, 'product-1');

    const price = screen.getAllByLabelText(/מחיר ידני/)[row] as HTMLInputElement;
    expect(price.value).toBe('42');
    expect(screen.getAllByRole('checkbox', { name: /אני מאשר שורה זו לקליטה/ })[row]).toBeChecked();
    expect(confirm).toHaveTextContent(`עדכון ${LINE_COUNT - UNMATCHED_LINES + 1} המחירים`);
  });

  it('שורה שמחירה לא נקרא נשארת ב„דורשות טיפול” גם אחרי שנבחר לה מוצר', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('price-list-intake-confirm')).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    expect(screen.getAllByTestId('price-list-row-product')).toHaveLength(UNMATCHED_LINES);

    // Neither exception in this fixture carries a readable price, so linking one to a product
    // leaves it incomplete — and an incomplete line must not vanish out from under the reviewer
    // into a list they have been told is finished.
    await userEvent.selectOptions(screen.getAllByTestId('price-list-row-product')[0], 'product-1');
    expect(screen.getAllByTestId('price-list-row-product')).toHaveLength(UNMATCHED_LINES);
    expect(screen.getAllByRole('checkbox', { name: /אני מאשר שורה זו לקליטה/ })[0]).not.toBeChecked();
    expect(screen.getByTestId('price-list-intake-confirm'))
      .toHaveTextContent(`עדכון ${LINE_COUNT - UNMATCHED_LINES} המחירים`);
  });

  it('ביטול סימון ידני מנצח — תיקון מחיר אחריו אינו מחזיר את הסימון', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    await userEvent.click(screen.getByTestId('price-list-unmatched-filter'));

    // A line the server matched: complete, ticked. Untick it, then edit its price.
    const tick = screen.getAllByRole('checkbox', { name: /אני מאשר שורה זו לקליטה/ })[0];
    expect(tick).toBeChecked();
    await userEvent.click(tick);
    expect(tick).not.toBeChecked();

    await userEvent.type(screen.getAllByLabelText(/מחיר ידני/)[0], '9');
    expect(tick).not.toBeChecked();
    expect(confirm).toHaveTextContent(`עדכון ${LINE_COUNT - UNMATCHED_LINES - 1} המחירים`);
  });

});

/**
 * The calibration and product dry-run surface was DELETED on 04.09.2026, not hidden.
 *
 * Eleven cases stood here and every one of them measured `PriceListAutomationReadiness`: batch
 * preparation, owner approval of a prepared batch, the truncated-window refusal, the office
 * preparer's idempotency key, the dry run's empty state. It was an operator console mounted on the
 * customer's own document, and its dry run greeted a first-time reader with
 * "בדיקת הכשירות נכשלה — פנה לתמיכה" — a red failure for a check they never asked to run.
 *
 * What is asserted now is that none of it can come back to this screen by accident. The gate those
 * cases were preparing is `DEBT §42`, which was already unreachable for its own reasons; §42 records
 * that its surface has to be rebuilt inside the operator console, and the cases with it.
 */
describe('משטח האוטומציה אינו על מסמך של לקוח', () => {
  it('אינו מציג כלי הכנה, כיול או dry-run לבעלים שקורא מחירון', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await screen.findByTestId('price-list-intake-summary');
    expect(screen.queryByText('כלי הכנה לאוטומציה (למתקדמים)')).toBeNull();
    expect(screen.queryByText('כיול מחירון באצווה')).toBeNull();
    expect(screen.queryByText('בדיקת כשירות לאוטומציית מוצרים')).toBeNull();
    // The queue behind it is not merely hidden — it is never asked for.
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_price_list_calibration_preparation_queue', expect.anything());
  });
});

describe('בטלפון — האישור נוסע עם הרשימה', () => {
  afterEach(() => { Reflect.deleteProperty(window, 'matchMedia'); });

  function phone() {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: query.includes('max-width'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  }

  it('מציג את כפתור הקליטה פעם אחת, מעל השורות, ומשאיר את "פרטים נוספים" לצדו', async () => {
    phone();
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getAllByTestId('price-list-intake-confirm')).toHaveLength(1);

    const decision = screen.getByTestId('primary-decision');
    expect(decision).toContainElement(confirm);
    // A disclosure toggle is not what this screen is for. It is gone entirely now, and the door
    // that replaced it must not ride inside the one action either.
    expect(screen.queryByTestId('price-list-details-toggle')).toBeNull();
    expect(decision).not.toContainElement(screen.getByTestId('price-list-show-unmatched'));

    // Nothing is fixed to the phone's bottom edge and nothing is portalled to `<body>` to make room
    // for it: the button sits at the head of the lines, where the summary it answers is printed.
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    expect(screen.queryByTestId('sticky-primary-action')).toBeNull();
    expect(screen.queryByTestId('sticky-primary-action-clearance')).toBeNull();
    const summary = screen.getByTestId('price-list-intake-summary');
    expect(summary.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
