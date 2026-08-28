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
 * ── Why this is a SELECTION and not a row of buttons ─────────────────────────────────────────
 *
 * The first build gave every line its own "מוצר חדש" button and left every line's details on
 * screen. The owner rejected that shape before it shipped (28.08.2026): "אין צורך שעבור כל פריט
 * יהיה כפתור משלו כי זה יוצר עומס, וברשימה של מאות מוצרים לא רואים את הסוף."
 *
 * He is describing the real document. A price list or a long invoice is hundreds of lines, and a
 * per-line dialog makes the work O(lines) — hundreds of dialogs, each asking for what the document
 * already printed. What the work actually IS on a new account is one decision — "these lines are
 * new products, create them" — so the surface is a checkbox list with ONE action over the
 * selection, and each row stays a single quiet line until someone opens it.
 *
 * ── What "create" does, and what it refuses to do twice ──────────────────────────────────────
 *
 * Per distinct product in the selection: a `products` row, then ONE `import_supplier_prices` call
 * carrying every price at once. That is the same pair `QuickCreateProduct` performs —
 * `import_supplier_prices` owns every `supplier_products` write (0023 revoked direct DML) —
 * batched instead of repeated.
 *
 * A line whose name already exists in the catalogue is MATCHED to it rather than created again.
 * `products` has no unique constraint on name (`0001_init.sql:87-100`), so a bulk create over a
 * document that repeats a product, or over a catalogue that already holds it, would fork the
 * catalogue silently. Two lines naming the same product create it once and both map to it.
 *
 * ── What this component decides: nothing ─────────────────────────────────────────────────────
 *
 * The mapping is written nowhere. It is reported upward, `reviewedProposal` puts it in the
 * proposal, and `apply_reviewed_document` checks each id against this tenant's own catalogue and
 * labels it `reviewer` (0110:86-93). A mapping is a person's decision recorded as one, never a
 * match.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, Plus } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../auth/AuthContext';
import { ok, toHebrewError } from '../../lib/errors';
import { unwrap } from '../../lib/useQuery';
import { fetchAll } from '../../lib/supabasePaging';
import { nameKey } from '../../lib/nameKey';
import { reasonOr } from '../../lib/reason';
import { fmtMoneyExact, fmtNum, todayISO } from '../../lib/format';
import { ConfirmDialog, ICON, Note, useToast } from '../ui';
import { quickProductRow } from '../QuickCreateProduct';
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

export interface BulkPlan {
  /** Lines whose name is already in the catalogue: matched, never created a second time. */
  matched: { line: AssessmentLine; productId: string }[];
  /** Distinct new products to insert, each with the lines that asked for it. */
  create: { name: string; unit: string; price: number | null; lines: AssessmentLine[] }[];
  /** Lines the document gave no name — nothing can be created from them. */
  unnamed: AssessmentLine[];
}

/**
 * What pressing "create" would do, worked out before anything is written.
 *
 * Separated from the component so the confirmation can state it and a spec can drive it: the two
 * ways a bulk create goes wrong — a duplicate catalogue entry, and a silent skip of a line that
 * could not be named — are both decided here.
 */
export function planBulkCreate(
  lines: readonly AssessmentLine[],
  catalogue: readonly CatalogueProduct[],
): BulkPlan {
  const existing = new Map(catalogue.map((product) => [nameKey(product.name), product.id]));
  const plan: BulkPlan = { matched: [], create: [], unnamed: [] };
  const pending = new Map<string, BulkPlan['create'][number]>();

  for (const line of lines) {
    const name = (line.description ?? '').trim();
    if (!name) { plan.unnamed.push(line); continue; }
    const key = nameKey(name);
    const known = existing.get(key);
    if (known) { plan.matched.push({ line, productId: known }); continue; }
    const already = pending.get(key);
    if (already) { already.lines.push(line); continue; }
    pending.set(key, {
      name,
      unit: (line.unit ?? '').trim() || 'יח׳',
      // The first line naming this product decides its price. A document that prices the same
      // product twice differently is a finding of its own, not something to average away here.
      price: line.normalized_unit_price ?? line.unit_price,
      lines: [line],
    });
  }
  plan.create = [...pending.values()];
  return plan;
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
  const { profile } = useAuth();
  const toast = useToast();
  const [catalogue, setCatalogue] = useState<CatalogueProduct[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** One row's details at a time, all shut by default — the list is the subject, not the rows. */
  const [openLine, setOpenLine] = useState<number | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

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

  const byId = useMemo(
    () => new Map((catalogue ?? []).map((product) => [product.id, product])),
    [catalogue]);

  const selectedLines = useMemo(
    () => lines.filter((line) => selected.has(line.line_index)),
    [lines, selected]);

  const plan = useMemo(
    () => planBulkCreate(selectedLines, catalogue ?? []),
    [selectedLines, catalogue]);

  const remaining = lines.filter((line) => !mapped[line.line_index]).length;
  const allSelected = selected.size === lines.length && lines.length > 0;
  const working = disabled || busy;

  function toggle(lineIndex: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(lineIndex)) next.delete(lineIndex);
      else next.add(lineIndex);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(lines.map((line) => line.line_index)));
  }

  /**
   * The two writes, batched — products first, then one price command for all of them.
   *
   * The order is what makes the split honest, the same reasoning `QuickCreateProduct` records: a
   * failure between them leaves products in the catalogue without an offer, a state a person can
   * see and finish in /prices. The reverse order could price rows that do not exist.
   */
  async function createSelected() {
    if (!profile?.org_id || !supplierId) return;
    setConfirming(false);
    setBusy(true);
    try {
      let created: Product[] = [];
      if (plan.create.length > 0) {
        const inserted = ok(await supabase.from('products')
          .insert(plan.create.map((row) => quickProductRow(profile.org_id, row.name, row.unit)))
          .select('*'));
        created = (inserted.data ?? []) as Product[];
        if (created.length !== plan.create.length) throw new Error('product_insert_incomplete');
      }

      // Joined by name, not by position: the insert preserves order today, and relying on that
      // would be a silent mis-mapping the day it stops.
      const createdByKey = new Map(created.map((product) => [nameKey(product.name), product]));
      const priceRows = plan.create.flatMap((row) => {
        const product = createdByKey.get(nameKey(row.name));
        return product && row.price != null && row.price > 0
          ? [{ supplier_id: supplierId, product_id: product.id, price: row.price, available: true }]
          : [];
      });

      let priceFailure: string | null = null;
      if (priceRows.length > 0) {
        try {
          unwrap(await supabase.rpc('import_supplier_prices', {
            p_rows: priceRows,
            p_effective_date: todayISO(),
            p_reason: reasonOr('', 'יצירת מוצרים ומחירים מתוך מסמך שהתקבל'),
          }));
        } catch (failure) {
          priceFailure = toHebrewError(failure);
        }
      }

      setCatalogue((rows) => [
        ...(rows ?? []),
        ...created.map((product) => ({ id: product.id, name: product.name, unit: product.unit })),
      ]);
      for (const row of plan.create) {
        const product = createdByKey.get(nameKey(row.name));
        if (product) for (const line of row.lines) onMap(line.line_index, product.id);
      }
      for (const { line, productId } of plan.matched) onMap(line.line_index, productId);
      setSelected(new Set());

      toast(priceFailure
        ? `נוצרו ${created.length} מוצרים, אך קביעת המחירים נכשלה: ${priceFailure}. אפשר להשלים במסך המחירונים.`
        : [
          created.length > 0 ? `נוצרו ${created.length} מוצרים` : null,
          plan.matched.length > 0 ? `${plan.matched.length} שורות שויכו למוצר קיים` : null,
        ].filter(Boolean).join(' · ') || 'לא היה מה ליצור',
        priceFailure ? 'error' : 'success');
    } catch (failure) {
      toast(toHebrewError(failure), 'error');
    } finally {
      setBusy(false);
    }
  }

  if (lines.length === 0) return null;

  return (
    <div className="card p-4" data-testid="document-line-mapping">
      <h3 className="text-sm font-medium text-ink-soft">שורות שאין להן מוצר בקטלוג</h3>
      {/* Says what the state IS and what closes it, in that order. "0 מתוך 5" would be a counter;
          this is the work list. */}
      <p className="mt-1 text-sm text-ink-body">
        {remaining === 0
          ? 'כל השורות שויכו למוצר. אפשר לאשר את המסמך.'
          : <>סמנו שורות וצרו מהן מוצרים, או פתחו שורה כדי לבחור לה מוצר קיים. נותרו <span className="num">{remaining}</span> מתוך <span className="num">{lines.length}</span>.</>}
      </p>

      {loadError && <Note tone="alert" role="alert" className="mt-3">{loadError}</Note>}

      {!supplierId && (
        <Note tone="await" role="status" className="mt-3">
          כל עוד הספק לא זוהה אי אפשר ליצור מוצרים — מוצר חדש נוצר עם מחיר אצל ספק מסוים.
          אפשר לשייך לשורות מוצרים קיימים, ולזהות את הספק למעלה.
        </Note>
      )}

      {/* The action bar stays at the top of the list rather than under it: on a document with
          hundreds of lines the bottom of the list is not a place anybody reaches. */}
      <div className="sticky top-0 z-10 mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-surface-sunken p-2">
        <label className="flex min-h-11 items-center gap-2 text-sm text-ink-body">
          <input
            type="checkbox"
            className="size-4"
            checked={allSelected}
            disabled={working}
            onChange={toggleAll}
          />
          בחירת הכל
        </label>
        <span className="text-sm text-ink-muted">נבחרו <span className="num">{selected.size}</span></span>
        <button
          type="button"
          className="btn-primary ms-auto min-h-11"
          disabled={working || selected.size === 0 || !supplierId}
          onClick={() => setConfirming(true)}
        >
          {busy
            ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" />
            : <Plus size={ICON.sm} aria-hidden="true" />}
          יצירת מוצרים מהשורות שנבחרו
        </button>
      </div>

      <ul className="mt-2 divide-y divide-line-soft">
        {lines.map((line) => {
          const open = openLine === line.line_index;
          const chosen = mapped[line.line_index];
          const chosenProduct = chosen ? byId.get(chosen) : undefined;
          const rowId = `line-map-${line.line_index}`;
          return (
            <li key={line.line_index}>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 shrink-0"
                  checked={selected.has(line.line_index)}
                  disabled={working}
                  onChange={() => toggle(line.line_index)}
                  aria-label={`סימון ${lineTitle(line)}`}
                />
                {/* One quiet line per row. The details are behind the press, which is the whole
                    difference between a list a person can scan and a wall they scroll. */}
                <button
                  type="button"
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-start hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  aria-expanded={open}
                  aria-controls={`${rowId}-details`}
                  onClick={() => setOpenLine(open ? null : line.line_index)}
                >
                  <ChevronDown
                    size={ICON.sm}
                    aria-hidden="true"
                    className={`shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink"><bdi>{lineTitle(line)}</bdi></span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {chosen
                      ? <span className="text-done-fg">{chosenProduct ? <bdi>{chosenProduct.name}</bdi> : 'שויך'}</span>
                      : 'לא שויך'}
                  </span>
                </button>
              </div>

              {open && (
                <div id={`${rowId}-details`} className="pb-3 pe-2 ps-8">
                  <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    <Fact label="תיאור במסמך" value={line.description} />
                    <Fact label="מק״ט" value={line.sku} />
                    <Fact label="ברקוד" value={line.barcode} />
                    <Fact label="כמות ומחיר" value={lineFacts(line) || null} />
                    <Fact label="סה״כ שורה" value={line.line_total == null ? null : fmtMoneyExact(line.line_total)} />
                  </dl>
                  <label className="label mt-3 block" htmlFor={rowId}>שיוך למוצר קיים</label>
                  <select
                    id={rowId}
                    className="input mt-1"
                    value={chosen ?? ''}
                    disabled={working || catalogue === null}
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
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {/* States what will happen to every selected line, including the ones nothing will happen
          to. A bulk action that silently skips rows is how a person believes work was done. */}
      <ConfirmDialog
        open={confirming}
        busy={busy}
        onClose={() => setConfirming(false)}
        onConfirm={() => void createSelected()}
        title="יצירת מוצרים מהשורות שנבחרו"
        confirmLabel="יצירה"
        message={[
          plan.create.length > 0 ? `${plan.create.length} מוצרים חדשים ייווצרו ויקבלו את המחיר שבמסמך אצל הספק.` : null,
          plan.matched.length > 0 ? `${plan.matched.length} שורות ישויכו למוצר שכבר קיים בקטלוג באותו שם — לא ייווצר מוצר כפול.` : null,
          plan.unnamed.length > 0 ? `${plan.unnamed.length} שורות יידלגו: אין להן שם מוצר במסמך. אפשר לשייך אותן ידנית.` : null,
        ].filter(Boolean).join(' ')}
      />
    </div>
  );
}

/** A detail row that prints — for what the document did not carry, never a blank or a zero. */
function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-ink-muted">{label}:</dt>
      <dd className="min-w-0 break-words text-ink-body">{value ? <bdi>{value}</bdi> : '—'}</dd>
    </div>
  );
}
