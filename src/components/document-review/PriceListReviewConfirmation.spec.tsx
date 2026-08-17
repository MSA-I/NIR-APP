import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { DocumentProcessingSnapshot, PriceListPredictedLine } from '../../lib/useDocumentProcessing';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'owner-1', role: 'owner', org_id: 'org-1' } }),
}));
const mocks = vi.hoisted(() => ({
  insert: vi.fn((rows: Array<Record<string, unknown>>) => ({
    data: rows.map((row, index) => ({
      id: `new-product-${index}`, name: row.name, unit: row.unit, sku: row.sku,
    })),
    error: null,
  })),
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
    rpc: vi.fn(),
  },
}));

import { PriceListReviewConfirmation } from './PriceListReviewConfirmation';

const LINE_COUNT = 22;
const UNMATCHED_LINES = 2;

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
      price_change_percent: null,
      product_would_be_created: false,
      created_at: '2026-08-17T00:00:00Z',
    };
  });
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

  it('יוצר את המוצרים החדשים בפעולה אחת ומשאיר שם חריג לטיפול פרטני', async () => {
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

    const bulk = await screen.findByTestId('price-list-bulk-create');
    expect(bulk).toHaveTextContent(`יצירת ${NEW_LINES - 1} מוצרים חדשים`);
    expect(screen.getByText(/שורות שהשם שנקרא בהן חריג יישארו לטיפול פרטני/)).toBeInTheDocument();

    await userEvent.click(bulk);
    await userEvent.click(screen.getByRole('button', { name: 'יצירת המוצרים' }));

    await waitFor(() => expect(mocks.insert).toHaveBeenCalledTimes(1));
    const inserted = mocks.insert.mock.calls[0][0];
    expect(inserted).toHaveLength(NEW_LINES - 1);
    expect(inserted.map((row) => row.sku)).not.toContain(`NEW-${NEW_LINES - 1}`);
    // Created, linked and marked: the confirm button now commits them without a per-line form.
    await waitFor(() => expect(screen.getByTestId('price-list-intake-confirm'))
      .toHaveTextContent(`קליטת ${NEW_LINES - 1} המחירים שנבחרו`));
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
    const select = screen.getAllByRole('combobox')[row];
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
    expect(screen.getAllByRole('combobox')).toHaveLength(UNMATCHED_LINES);

    // Neither exception in this fixture carries a readable price, so linking one to a product
    // leaves it incomplete — and an incomplete line must not vanish out from under the reviewer
    // into a list they have been told is finished.
    await userEvent.selectOptions(screen.getAllByRole('combobox')[0], 'product-1');
    expect(screen.getAllByRole('combobox')).toHaveLength(UNMATCHED_LINES);
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

  it('מציג את כפתור הקליטה בסרגל המוצמד, פעם אחת, ומשאיר את "פרטים נוספים" בזרימה', async () => {
    phone();
    render(
      <MemoryRouter>
        <PriceListReviewConfirmation snapshot={snapshot(predictions())} actorId="owner-1" onRefetch={async () => true} />
      </MemoryRouter>,
    );

    const confirm = await screen.findByTestId('price-list-intake-confirm');
    await waitFor(() => expect(confirm).toBeEnabled());
    expect(screen.getAllByTestId('price-list-intake-confirm')).toHaveLength(1);

    const sticky = screen.getByTestId('sticky-primary-action');
    expect(sticky).toContainElement(confirm);
    // A disclosure toggle is not what this screen is for; it must not ride in the bar beside the
    // one action, and it must not disappear from the page either.
    expect(sticky).not.toContainElement(screen.getByTestId('price-list-details-toggle'));

    // The paged line list ends at the bottom of the document; the spacer is what keeps its last
    // row out from under the bar.
    await userEvent.click(screen.getByTestId('price-list-show-unmatched'));
    expect(document.body.lastElementChild)
      .toBe(screen.getByTestId('sticky-primary-action-clearance'));
  });
});
