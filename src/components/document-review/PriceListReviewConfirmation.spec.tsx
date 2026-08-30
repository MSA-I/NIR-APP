import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DocumentProcessingSnapshot, PriceListPredictedLine } from '../../lib/useDocumentProcessing';

const mocks = vi.hoisted(() => ({
  role: 'owner',
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
          order: async () => ({
            data: [{ id: 'product-1', name: 'מוצר בדיקה', unit: 'unit', sku: 'SKU-1' }],
            error: null,
          }),
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

/**
 * More rows than the screen used to render.
 *
 * The old fixture returned exactly two, which is why `rows.slice(0, 5)` stayed green while the
 * owner was pressing „אישור האצווה כמסומנת נכונה" over lines the screen had never drawn. Twelve is
 * past that cut, and `CALIBRATION_PAGED` below is past the server page size.
 */
const CALIBRATION_LINES = 12;
/** One row more than the component's page size, so walking the queue takes two requests. */
const CALIBRATION_PAGED = 201;

const preparationQueue = (prepared = false, count = CALIBRATION_LINES) => predictions(count).map((line) => ({
  shadow_run_id: line.shadow_run_id,
  shadow_line_id: line.id,
  document_id: line.document_id,
  file_name: 'price-list.pdf',
  supplier_id: 'supplier-1',
  supplier_name: 'ספק בדיקה',
  line_index: line.line_index,
  source_row: line.source_row,
  predicted_action: line.predicted_action,
  reason_code: line.reason_code,
  product_id: line.product_id,
  matched_product_name: 'מוצר בדיקה',
  sku: line.sku,
  barcode: line.barcode,
  product_name: line.product_name,
  unit: line.unit,
  proposed_unit_price: line.proposed_unit_price,
  current_unit_price: line.current_unit_price,
  preparation_id: prepared ? 'office-preparation-1' : null,
  prepared_by: prepared ? 'office-1' : null,
  prepared_role: prepared ? 'office' : null,
  preparation_created_at: prepared ? '2026-08-23T08:00:00Z' : null,
  preparation_line_count: prepared ? count : null,
}));

type PreparationQueueRow = ReturnType<typeof preparationQueue>[number];

/**
 * The queue the way the server hands it over: one window per call, plus the outstanding total
 * counted over the whole filtered set. Passing a `total` larger than `rows` models a window the
 * caller cannot walk to the end of — the case in which no count on the screen is honest.
 */
function servePreparationQueue(
  rows: PreparationQueueRow[],
  total = rows.length,
  overrides: Partial<PreparationQueueRow> = {},
) {
  return (body: Record<string, unknown>) => {
    const offset = Number(body.p_offset ?? 0);
    const limit = Number(body.p_limit ?? 200);
    return {
      data: rows.slice(offset, offset + limit)
        .map((row) => ({ ...row, ...overrides, pending_total_count: total })),
      error: null,
    };
  };
}

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
  it('קולט את השורות שזוהו בלחיצה אחת ומשאיר את הרשת הידנית מקופלת', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    // 20 of 22 prefilled, so the button commits them without the reviewer touching a line.
    expect(confirm).toHaveTextContent(`קליטת ${LINE_COUNT - UNMATCHED_LINES} המחירים שנבחרו`);
    expect(screen.getByTestId('price-list-intake-summary').textContent)
      .toContain(`${LINE_COUNT - UNMATCHED_LINES} מתוך ${LINE_COUNT} שורות זוהו במלואן`);
    expect(screen.getByTestId('price-list-details-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/אני מאשר שורה זו לקליטה/)).not.toBeInTheDocument();
    expect(screen.getByText('החודש קובע לאיזו גרסת מחירון ישויכו המחירים שנבחרו.')).toBeInTheDocument();
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

  it('מחלק רשימה ארוכה לעמודים ומסמן עמוד שלם בסימון אחד', async () => {
    const LONG = 120;
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions(LONG), LONG)} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('price-list-intake-confirm')).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-details-toggle'));
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
      .toHaveTextContent(`קליטת ${LONG - UNMATCHED_LINES - 50} המחירים שנבחרו`);
    await userEvent.click(selectAll);
    expect(screen.getByTestId('price-list-intake-confirm'))
      .toHaveTextContent(`קליטת ${LONG - UNMATCHED_LINES} המחירים שנבחרו`);
  });

  it('מציג dry-run של מוצרים כשירים בלי ליצור או להפעיל אותם מהמסך', async () => {
    const NEW_LINES = 6;
    // Every line is keyed and priced but absent from the catalogue — the shape of a real supplier
    // list whose numbering nobody has entered yet. The last name is what a scan actually produced.
    const newProducts = predictions(NEW_LINES).map((line, index) => ({
      ...line,
      predicted_action: 'create_product' as const,
      reason_code: null,
      matched_by: null,
      product_id: null,
      sku: `NEW-${index}`,
      product_name: index === NEW_LINES - 1 ? '^^' : `מוצר חדש ${index + 1}`,
      unit: 'יח׳',
      proposed_unit_price: 10 + index,
      product_would_be_created: true,
    }));

    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(newProducts, NEW_LINES)} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('בדיקת כשירות לאוטומציית מוצרים')).toBeInTheDocument();
    expect(screen.getByText('מוכנים ליצירה')).toBeInTheDocument();
    expect(screen.getByText('מוצר חדש 1')).toBeInTheDocument();
    expect(screen.queryByTestId('price-list-bulk-create')).toBeNull();
    expect(screen.queryByRole('button', { name: /יצירת מוצרים|הפעלה/ })).toBeNull();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('בלי תחזית שמורה אינו ממלא כלום, אומר זאת, ומשאיר את האישור הידני זמין', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot([])} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(screen.getByTestId('price-list-intake-summary')).toBeInTheDocument());
    expect(confirm).toBeDisabled();
    expect(screen.getByText(/לא נמצאה התאמה אוטומטית שמורה למסמך הזה/)).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('price-list-details-toggle'));
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
    await userEvent.click(screen.getByTestId('price-list-details-toggle'));
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
    expect(confirm).toHaveTextContent(`קליטת ${LINE_COUNT - UNMATCHED_LINES + 1} המחירים שנבחרו`);
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
      .toHaveTextContent(`קליטת ${LINE_COUNT - UNMATCHED_LINES} המחירים שנבחרו`);
  });

  it('ביטול סימון ידני מנצח — תיקון מחיר אחריו אינו מחזיר את הסימון', async () => {
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    await userEvent.click(screen.getByTestId('price-list-details-toggle'));
    await userEvent.click(screen.getByTestId('price-list-unmatched-filter'));

    // A line the server matched: complete, ticked. Untick it, then edit its price.
    const tick = screen.getAllByRole('checkbox', { name: /אני מאשר שורה זו לקליטה/ })[0];
    expect(tick).toBeChecked();
    await userEvent.click(tick);
    expect(tick).not.toBeChecked();

    await userEvent.type(screen.getAllByLabelText(/מחיר ידני/)[0], '9');
    expect(tick).not.toBeChecked();
    expect(confirm).toHaveTextContent(`קליטת ${LINE_COUNT - UNMATCHED_LINES - 1} המחירים שנבחרו`);
  });

});

describe('כיול באצווה ו-dry-run מוצרים', () => {
  it('אינו חושף את משטח האוטומציה לתפקיד שאינו owner/office', async () => {
    mocks.role = 'accountant';
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('כיול מחירון באצווה')).toBeNull();
    expect(screen.queryByText('בדיקת כשירות לאוטומציית מוצרים')).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_price_list_calibration_preparation_queue', expect.anything());
  });

  it('owner רואה כל שורה באצווה, מכין אותה ומאשר אותה בלי להפעיל Platform', async () => {
    const rows = preparationQueue();
    mocks.rpc.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name === 'get_price_list_calibration_preparation_queue') return servePreparationQueue(rows)(body);
      if (name === 'get_qualified_product_creation_dry_run') {
        return { data: QUALIFIED_DRY_RUN, error: null };
      }
      if (name === 'prepare_price_list_calibration_batch') {
        return { data: { preparation_id: 'preparation-1', line_count: CALIBRATION_LINES, idempotent: false }, error: null };
      }
      if (name === 'record_price_list_calibration_batch') {
        return { data: { preparation_id: 'preparation-1', reviewed_count: CALIBRATION_LINES, idempotent: false }, error: null };
      }
      return { data: null, error: null };
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('כיול מחירון באצווה')).toBeInTheDocument();
    expect(screen.getByText((_text, element) => element?.textContent === `${CALIBRATION_LINES} שורות מוכנות לבדיקה`))
      .toBeInTheDocument();
    // Every line of the batch is drawn. „אישור האצווה כמסומנת נכונה" is a claim about all of them,
    // so a screen that renders a prefix of the batch may not offer it (#248).
    await waitFor(() => expect(screen.getAllByTestId('calibration-preparation-row'))
      .toHaveLength(CALIBRATION_LINES));

    await user.type(screen.getByLabelText('סיבת הכנת האצווה (רשות)'), 'בדיקת שורות המסמך');
    await user.click(screen.getByRole('button', { name: 'הכנת האצווה לבדיקת בעלים' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'prepare_price_list_calibration_batch',
      expect.objectContaining({
        p_shadow_run_id: 'shadow-run-1',
        p_line_ids: rows.map((row) => row.shadow_line_id),
        p_idempotency_key: expect.any(String),
        p_reason: 'בדיקת שורות המסמך',
      }),
    ));

    await user.type(await screen.findByLabelText('סיבת אישור האצווה (רשות)'), 'כל השורות נבדקו מול המקור');
    await user.click(screen.getByRole('button', { name: 'אישור האצווה כמסומנת נכונה' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'record_price_list_calibration_batch',
      expect.objectContaining({
        p_preparation_id: 'preparation-1',
        p_idempotency_key: expect.any(String),
        p_reason: 'כל השורות נבדקו מול המקור',
      }),
    ));
    expect(screen.queryByRole('button', { name: /Platform|הפעלת אוטומציה/ })).toBeNull();
  });

  it('קורא את כל שורות המסמך גם כשהן חורגות מעמוד אחד של השרת', async () => {
    const rows = preparationQueue(false, CALIBRATION_PAGED);
    const offsets: unknown[] = [];
    mocks.rpc.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name === 'get_price_list_calibration_preparation_queue') {
        offsets.push(body.p_offset);
        expect(body.p_document_id).toBe('document-1');
        return servePreparationQueue(rows)(body);
      }
      if (name === 'get_qualified_product_creation_dry_run') return { data: QUALIFIED_DRY_RUN, error: null };
      return { data: null, error: null };
    });
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    // A 338-line price list cannot be reviewed through a single window (DEBT-REGISTER §42), and a
    // document that is not the organization's oldest is not in the first window at all — hence the
    // document argument and the walk.
    await waitFor(() => expect(screen.getAllByTestId('calibration-preparation-row'))
      .toHaveLength(CALIBRATION_PAGED));
    expect(offsets).toEqual([0, 200]);
    expect(screen.getByText((_text, element) => element?.textContent === `${CALIBRATION_PAGED} שורות מוכנות לבדיקה`))
      .toBeInTheDocument();
    expect(screen.queryByText(/לא ניתן להציג את כל שורות הכיול/)).toBeNull();
  });

  it('חלון קטוע אינו מציג מספר ואינו מאפשר להכין אצווה', async () => {
    const rows = preparationQueue();
    mocks.rpc.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      // The server counts 338 outstanding rows and hands back 12: a count drawn from what arrived
      // would be a statement about the window, not about the document.
      if (name === 'get_price_list_calibration_preparation_queue') return servePreparationQueue(rows, 338)(body);
      if (name === 'get_qualified_product_creation_dry_run') return { data: QUALIFIED_DRY_RUN, error: null };
      return { data: null, error: null };
    });
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/לא ניתן להציג את כל שורות הכיול/)).toBeInTheDocument();
    expect(screen.getByText((_text, element) => element?.textContent === '— שורות מוכנות לבדיקה'))
      .toBeInTheDocument();
    expect(screen.queryByText(`${CALIBRATION_LINES} שורות מוכנות לבדיקה`)).toBeNull();
    expect(screen.getByRole('button', { name: 'הכנת האצווה לבדיקת בעלים' })).toBeDisabled();
  });

  it('owner מאשר preparation שמשרד הכין בסשן קודם בלי להכין אצווה חלופית', async () => {
    const rows = preparationQueue(true);
    mocks.rpc.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name === 'get_price_list_calibration_preparation_queue') return servePreparationQueue(rows)(body);
      if (name === 'get_qualified_product_creation_dry_run') {
        return { data: QUALIFIED_DRY_RUN, error: null };
      }
      if (name === 'record_price_list_calibration_batch') {
        return { data: { preparation_id: 'office-preparation-1', reviewed_count: CALIBRATION_LINES, idempotent: false }, error: null };
      }
      return { data: null, error: null };
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('האצווה הוכנה על ידי מנהל המשרד.')).toBeInTheDocument();
    expect(screen.queryByLabelText('סיבת הכנת האצווה (רשות)')).toBeNull();
    await user.type(screen.getByLabelText('סיבת אישור האצווה (רשות)'), 'בדיקת בעלים מלאה');
    await user.click(screen.getByRole('button', { name: 'אישור האצווה כמסומנת נכונה' }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith(
      'record_price_list_calibration_batch',
      expect.objectContaining({ p_preparation_id: 'office-preparation-1' }),
    ));
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'prepare_price_list_calibration_batch')).toBe(false);
  });

  it('מסרב לאשר אצווה שמכסה יותר שורות ממה שהמסך הראה', async () => {
    // The office prepared the run's 338 lines; this screen holds 12 of them. `record_…_batch`
    // writes 'correct' over every line_id it was given, so approving here would mark 326 lines
    // nobody looked at.
    const rows = preparationQueue(true);
    mocks.rpc.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name === 'get_price_list_calibration_preparation_queue') {
        return servePreparationQueue(rows, rows.length, { preparation_line_count: 338 })(body);
      }
      if (name === 'get_qualified_product_creation_dry_run') return { data: QUALIFIED_DRY_RUN, error: null };
      return { data: null, error: null };
    });
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/אי אפשר לאשר שורות שלא נראו/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'אישור האצווה כמסומנת נכונה' })).toBeNull();
    expect(screen.queryByLabelText('סיבת אישור האצווה (רשות)')).toBeNull();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'record_price_list_calibration_batch')).toBe(false);
  });

  it('office מכין בלבד, וריטריי משתמש באותו idempotency key', async () => {
    mocks.role = 'office';
    const rows = preparationQueue();
    const keys: unknown[] = [];
    let prepareAttempt = 0;
    mocks.rpc.mockImplementation(async (name: string, body: Record<string, unknown>) => {
      if (name === 'get_price_list_calibration_preparation_queue') return servePreparationQueue(rows)(body);
      if (name === 'get_qualified_product_creation_dry_run') {
        return { data: QUALIFIED_DRY_RUN, error: null };
      }
      if (name === 'prepare_price_list_calibration_batch') {
        keys.push(body.p_idempotency_key);
        prepareAttempt += 1;
        return prepareAttempt === 1
          ? { data: null, error: { message: 'temporary preparation failure' } }
          : { data: { preparation_id: 'preparation-office', line_count: CALIBRATION_LINES, idempotent: true }, error: null };
      }
      return { data: null, error: null };
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    await user.type(await screen.findByLabelText('סיבת הכנת האצווה (רשות)'), 'הכנת משרד');
    const prepare = screen.getByRole('button', { name: 'הכנת האצווה לבדיקת בעלים' });
    await user.click(prepare);
    await waitFor(() => expect(keys).toHaveLength(1));
    await user.click(prepare);
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    expect(await screen.findByText('האצווה הוכנה לבדיקת בעלים.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'אישור האצווה כמסומנת נכונה' })).toBeNull();
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'record_price_list_calibration_batch')).toBe(false);
  });

  it('מציג empty state לכיול ושגיאת dry-run בלי להציע activation', async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_price_list_calibration_preparation_queue') return { data: [], error: null };
      if (name === 'get_qualified_product_creation_dry_run') {
        return { data: null, error: { message: 'qualified_product_dry_run_unavailable' } };
      }
      return { data: null, error: null };
    });
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('אין שורות כיול שממתינות להכנה במסמך הזה.')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/dry-run|בדיקת הכשירות/);
    expect(screen.queryByRole('button', { name: /יצירת מוצרים|הפעלה/ })).toBeNull();
  });

  it('על מסמך שכבר נקלט אינו מציע הכנת אצווה ואומר שהקליטה הסתיימה', async () => {
    const ingested = {
      ...snapshot(predictions()),
      priceListDecision: {
        id: 'decision-1', org_id: 'org-1', document_id: 'document-1', job_id: 'job-1',
        interpretation_id: 'interpretation-1', actor_id: 'owner-1', supplier_id: 'supplier-1',
        submission_id: 'submission-1', outcome: 'auto_applied', reason_code: null,
        decision_confidence: null, accepted_count: LINE_COUNT - UNMATCHED_LINES,
        waiting_count: UNMATCHED_LINES, created_product_count: 0,
        created_at: '2026-08-23T09:00:00Z', reverted_at: null, reverted_by: null, reverted_reason: null,
      },
    } as unknown as DocumentProcessingSnapshot;
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={ingested} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    // „מוכנים ליצירה N" beside a live „הכנת האצווה" button on an ingested price list offered work
    // that is over. The block now states the document's actual state instead.
    expect(await screen.findByText(/המחירון של המסמך הזה כבר נקלט/)).toBeInTheDocument();
    expect(screen.queryByText('כיול מחירון באצווה')).toBeNull();
    expect(screen.queryByText('בדיקת כשירות לאוטומציית מוצרים')).toBeNull();
    expect(screen.queryByRole('button', { name: 'הכנת האצווה לבדיקת בעלים' })).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalledWith('get_price_list_calibration_preparation_queue', expect.anything());
  });

  it('על מסמך שעדיין בעיבוד אינו מציג את משטח הכיול כלל', async () => {
    // Neither open for review nor ingested: the readiness block has nothing true to say about this
    // document yet, so it says nothing rather than counting rows behind a reading that is not done.
    const processing = {
      ...snapshot(predictions()),
      job: { id: 'job-1', status: 'processing', last_error_code: null, last_error_message: null },
    } as unknown as DocumentProcessingSnapshot;
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={processing} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('בעיבוד')).toBeInTheDocument();
    expect(screen.queryByText('כיול מחירון באצווה')).toBeNull();
    expect(screen.queryByText('בדיקת כשירות לאוטומציית מוצרים')).toBeNull();
    expect(screen.queryByText(/המחירון של המסמך הזה כבר נקלט/)).toBeNull();
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
    // A disclosure toggle is not what this screen is for; it must not ride inside the one action,
    // and it must not disappear from the page either.
    expect(decision).not.toContainElement(screen.getByTestId('price-list-details-toggle'));

    // Nothing is fixed to the phone's bottom edge and nothing is portalled to `<body>` to make room
    // for it: the button sits at the head of the lines, where the summary it answers is printed.
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    expect(screen.queryByTestId('sticky-primary-action')).toBeNull();
    expect(screen.queryByTestId('sticky-primary-action-clearance')).toBeNull();
    const summary = screen.getByTestId('price-list-intake-summary');
    expect(summary.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
