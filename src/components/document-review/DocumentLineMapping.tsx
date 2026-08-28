/**
 * The control that was missing under "מוצר לא מזוהה — נדרש מיפוי".
 *
 * The reconciliation table has said that sentence since 0110 shipped, and `DocumentAssessmentPanel`
 * carried an `edits` map, a `reviewedProposal` builder that reads it and a server command that
 * accepts a reviewer's `product_id` — with one piece never built. The panel's own comment admitted
 * it: "the edits map is wired for the line editor that lands with the mapping UI". The only way to
 * reach `setEdits` was an `sr-only` button that CLEARED it.
 *
 * So a document whose lines the catalogue does not recognise produced a blocking finding, a
 * sentence naming the remedy, and no way to perform it. The tester's words (28.08.2026): "לא ברור
 * מה קורה אם מעלים חשבונית שלא זיהה את הפריטים.. זה מסורבל שם, לא הצלחתי להבין מה עושים."
 *
 * ── Why this is the same screen and not a trip to /products ──────────────────────────────────
 *
 * On a brand-new account the catalogue is EMPTY, so every line is unmatched and the remedy is not
 * "pick the right product" — it is "teach the system this product". `QuickCreateProduct` already
 * performs exactly that pair of writes (a `products` row, then `import_supplier_prices` for the
 * supplier), which is why it is reused here rather than re-implemented: the invoice already names
 * the supplier, the description, the unit and the price, so the dialog opens filled in.
 *
 * ── What this component decides: nothing ─────────────────────────────────────────────────────
 *
 * It writes no mapping anywhere. It reports the reviewer's choice upward, `reviewedProposal` puts
 * it in the proposal, and `apply_reviewed_document` checks each id against this tenant's own
 * catalogue and labels it `reviewer` (0110:86-93). A mapping is a person's decision recorded as
 * one, never a match.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { toHebrewError } from '../../lib/errors';
import { fetchAll } from '../../lib/supabasePaging';
import { fmtMoneyExact, fmtNum } from '../../lib/format';
import { ICON, Note } from '../ui';
import { QuickCreateProduct } from '../QuickCreateProduct';
import type { AssessmentLine } from './assessment';
import type { Product } from '../../lib/types';

interface CatalogueProduct {
  id: string;
  name: string;
  unit: string | null;
}

/** What the document printed on this line, as one readable string. */
export function lineTitle(line: AssessmentLine): string {
  return line.description || line.sku || line.barcode || `שורה ${line.line_index + 1}`;
}

/** Quantity · unit · price, skipping whatever the document did not carry. Never a fabricated 0. */
export function lineFacts(line: AssessmentLine): string {
  const parts: string[] = [];
  if (line.quantity != null) parts.push(`${fmtNum(line.quantity)}${line.unit ? ` ${line.unit}` : ''}`);
  if (line.unit_price != null) parts.push(`${fmtMoneyExact(line.unit_price)} ליחידה`);
  return parts.join(' · ');
}

export function DocumentLineMapping({ lines, supplierId, mapped, onMap, disabled = false }: {
  /** The document lines the server could not attach to a product. */
  lines: readonly AssessmentLine[];
  /** The resolved supplier. Without one a new product cannot be priced, so creation is withheld. */
  supplierId: string | null;
  /** line_index → product_id, as chosen so far. */
  mapped: Readonly<Record<number, string>>;
  onMap: (lineIndex: number, productId: string | null) => void;
  disabled?: boolean;
}) {
  const [catalogue, setCatalogue] = useState<CatalogueProduct[] | null>(null);
  /**
   * The supplier's own name, read rather than borrowed from the resolution candidates.
   *
   * The first draft passed `candidates[0].name` down from the panel, which is the strongest
   * CANDIDATE and not necessarily the supplier the server settled on — a label that is right most
   * of the time is worse here than one that is always right, because the creation dialog prices a
   * product against it. Columns are named explicitly: `select('*')` on `suppliers` is refused
   * (`bank_details` is not readable from the browser).
   */
  const [supplierLabel, setSupplierLabel] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Which line the creation dialog was opened from — null when it is shut. */
  const [creatingFor, setCreatingFor] = useState<AssessmentLine | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await fetchAll<CatalogueProduct>((from, to) => supabase.from('products')
        .select('id, name, unit').eq('active', true).order('name').order('id').range(from, to));
      setCatalogue(rows);
      setLoadError(null);
    } catch (failure) {
      setLoadError(toHebrewError(failure));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!supplierId) { setSupplierLabel(null); return; }
    let cancelled = false;
    void supabase.from('suppliers').select('id, name').eq('id', supplierId).maybeSingle()
      .then(({ data }) => { if (!cancelled) setSupplierLabel((data as { name: string } | null)?.name ?? null); });
    return () => { cancelled = true; };
  }, [supplierId]);

  const supplierOptions = useMemo(
    () => (supplierId ? [{ id: supplierId, name: supplierLabel ?? 'הספק שזוהה במסמך' }] : []),
    [supplierId, supplierLabel]);

  const remaining = lines.filter((line) => !mapped[line.line_index]).length;

  if (lines.length === 0) return null;

  return (
    <div className="card p-4" data-testid="document-line-mapping">
      <h3 className="text-sm font-medium text-ink-soft">שורות שאין להן מוצר בקטלוג</h3>
      {/* Says what the state IS and what closes it, in that order. "0 מתוך 5" would be a counter;
          this is the work list. */}
      <p className="mt-1 text-sm text-ink-body">
        {remaining === 0
          ? 'כל השורות שויכו למוצר. אפשר לאשר את המסמך.'
          : <>לכל שורה כאן יש לבחור מוצר קיים או ליצור מוצר חדש. נותרו <span className="num">{remaining}</span> מתוך <span className="num">{lines.length}</span>.</>}
      </p>

      {loadError && <Note tone="alert" role="alert" className="mt-3">{loadError}</Note>}

      {!supplierId && (
        <Note tone="await" role="status" className="mt-3">
          כל עוד הספק לא זוהה אי אפשר ליצור מוצר חדש — מוצר חדש נוצר עם מחיר אצל ספק מסוים.
          אפשר לשייך לשורות מוצרים קיימים, ולזהות את הספק למעלה.
        </Note>
      )}

      <ul className="mt-3 space-y-3">
        {lines.map((line) => {
          const selectId = `line-map-${line.line_index}`;
          const facts = lineFacts(line);
          return (
            <li key={line.line_index} className="rounded-lg bg-surface-sunken p-3">
              <div className="min-w-0">
                <label className="block text-sm font-medium text-ink" htmlFor={selectId}>
                  <bdi>{lineTitle(line)}</bdi>
                </label>
                {facts && <p className="mt-0.5 text-xs text-ink-muted">{facts}</p>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  id={selectId}
                  className="input min-w-0 flex-1"
                  value={mapped[line.line_index] ?? ''}
                  disabled={disabled || catalogue === null}
                  onChange={(event) => onMap(line.line_index, event.target.value || null)}
                >
                  <option value="">
                    {catalogue === null ? 'טוען מוצרים…' : catalogue.length === 0 ? 'אין עדיין מוצרים בקטלוג' : 'בחר מוצר קיים'}
                  </option>
                  {(catalogue ?? []).map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.unit ? `${product.name} · ${product.unit}` : product.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary min-h-11 whitespace-nowrap"
                  disabled={disabled || !supplierId}
                  onClick={() => setCreatingFor(line)}
                >
                  <Plus size={ICON.sm} aria-hidden="true" /> מוצר חדש
                </button>
                {catalogue === null && <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin text-ink-muted" />}
              </div>
            </li>
          );
        })}
      </ul>

      {creatingFor && supplierId && (
        <QuickCreateProduct
          suppliers={supplierOptions}
          initialName={creatingFor.description ?? ''}
          initialUnit={creatingFor.unit ?? undefined}
          initialPrice={creatingFor.unit_price == null ? undefined : String(creatingFor.unit_price)}
          initialSupplierId={supplierId}
          description="המוצר ייווצר בקטלוג, יקבל את המחיר שבמסמך אצל הספק הזה, וישויך לשורה — ויזוהה מעצמו במסמכים הבאים."
          submitLabel="יצירה ושיוך לשורה"
          reasonFallback="יצירת מוצר ומחיר מתוך מסמך שהתקבל"
          onClose={() => setCreatingFor(null)}
          onCreated={async (product: Product) => {
            // The catalogue is extended locally rather than refetched: the row is already known,
            // and a refetch here would drop every other select back to its loading state.
            setCatalogue((rows) => [...(rows ?? []), { id: product.id, name: product.name, unit: product.unit }]);
            onMap(creatingFor.line_index, product.id);
            setCreatingFor(null);
          }}
        />
      )}
    </div>
  );
}
