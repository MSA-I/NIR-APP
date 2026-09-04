/**
 * יומן עדכון ספקים — who changed a supplier, or one of its prices, and why.
 *
 * ── What this replaces, and what it deliberately does not ─────────────────────────────────────
 *
 * A page-sized table of every raw mutation row in the system was removed on 10.08.2026 (commit
 * 30e0e3e) because it answered no question a business owner actually asks. That reasoning still
 * holds and this screen does not undo it: it is scoped to `suppliers` and `supplier_products` —
 * supplier details and price lists — because that is the question that kept coming back, from the
 * owner, in his own words: "מי העלה/שינה מחיר של מוצר".
 *
 * The ledger itself never went anywhere. `audit_logs` carries a row for every price write, from
 * the row-level `supplier_products_audit` trigger (`0001_init.sql:447`, action `insert`/`update`/
 * `delete`) and from the reasoned commands that own the write — `set_supplier_product_price`
 * (`0023:2246`) and `import_supplier_prices` — each with the operator's `reason`. This screen is
 * a reader; it writes nothing and it is not a second source of truth.
 *
 * ── Why owner only ────────────────────────────────────────────────────────────────────────────
 *
 * Three policies decide it, and their intersection is one role:
 *   - `audit_logs`      → owner, accountant   (`0031:208-211`)
 *   - `suppliers`, `supplier_products`, `products` → owner, office  (`0133:128-172`)
 *
 * An accountant could read the ledger and none of the names in it — every row would say
 * "מחירון" and a UUID. Rather than ship a screen that is empty of meaning for one of its two
 * roles, the route is owner-only. Widening it means widening an RLS policy, which is a decision
 * about who may read the audit ledger, not a rendering choice — so it stays out of this file.
 *
 * Note for whoever adds a link from /prices: that screen is owner + office, so the link belongs
 * behind the same owner check, not next to every row.
 *
 * ── The read stays owner-shaped, and the page grew a floor ────────────────────────────────────
 *
 * Nothing here widens the query to fill the screen. The scope is still the same two entity types
 * under the same RLS, and the reader still asks only for what an owner may already read; what
 * changed on 04.09.2026 is that it no longer stops at 400 rows and calls that the history
 * (`OWN-11`), and that it no longer says a reason was never recorded when the sibling row of the
 * same request records one (`OWN-05`, `PERM-06`, folded in `src/lib/supplierLogLedger.ts`).
 */

import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useMemo, useState } from 'react';
import { Package, ScrollText, Tags, Truck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { DOMAIN } from '../lib/query/keys';
import { useParamState } from '../lib/useParamState';
import { DataTable, ErrorNote, Modal, PageHeader, SkeletonTable, ICON, type Column } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { fieldChanges, renderValue } from '../lib/supplierLogChanges';
import { foldLedger, type LedgerEntry } from '../lib/supplierLogLedger';
import type { AuditLog } from '../lib/types';

/**
 * The entity types this log covers. Everything else stays out of the customer-facing app.
 *
 * `products` joined on 04.09.2026 and joined NARROWLY (`PL-06`). `/products → שמות לאישור`
 * promises „כל אישור נרשם ביומן הביקורת", `set_product_display_name` (`0149`) writes exactly that
 * row — raw name beside the approved one, with the reviewer's reason — and no screen in the
 * product asked for it, so the promise named a ledger nobody could open. It is read here because
 * `audit_logs` is already owner-readable (`0031`) and this screen is already owner-only: nothing
 * about who may read what changed.
 */
const ENTITY_TYPES = ['suppliers', 'supplier_products', 'products'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * And only these two actions of it.
 *
 * The generic `products_audit` trigger writes a row for every product mutation there is. Reading
 * them all would turn יומן עדכון ספקים into a product-change firehose and answer a question this
 * screen is not named after. The two reasoned name actions are the ones the approval screen
 * promised, and they are the ones asked for.
 */
const PRODUCT_NAME_ACTIONS = ['product_display_name_set', 'product_display_name_cleared'] as const;

const ENTITY_KEY: Record<EntityType, TKey> = {
  suppliers: 'supplierLog.entitySuppliers',
  supplier_products: 'supplierLog.entityPriceList',
  products: 'supplierLog.entityProductNames',
};

/**
 * Both dialects in one map: the generic row-trigger verbs (`insert`/`update`/`delete`) and the
 * named reasoned commands. The KEY of each row is the value in `audit_logs.action` and never
 * moves; what a reader sees is the dictionary entry it points at. `actionLabel()` below holds
 * the fallback for an action this table has not learned yet.
 */
const ACTION_KEY: Record<string, TKey> = {
  insert: 'supplierLog.actionInsert',
  update: 'supplierLog.actionUpdate',
  delete: 'supplierLog.actionDelete',
  supplier_deleted: 'supplierLog.actionSupplierDeleted',
  supplier_bank_details_updated: 'supplierLog.actionBankDetailsUpdated',
  supplier_product_price_set: 'supplierLog.actionPriceSet',
  supplier_prices_imported: 'supplierLog.actionPricesImported',
  price_list_auto_action_reverted: 'supplierLog.actionAutoReverted',
  product_display_name_set: 'supplierLog.actionProductNameApproved',
  product_display_name_cleared: 'supplierLog.actionProductNameCleared',
};

/**
 * One fetched page. The first is the same 400 rows this screen has always shown; pressing the
 * control under the table asks for another, and the meta line states the ledger's real size, so a
 * row older than the cap is reachable instead of silently absent (`OWN-11`).
 */
const PAGE_SIZE = 400;

/**
 * A ledger row with the three lookups already resolved, and NO translated text: this is what the
 * cached query returns, and a cached result must not be a result in a language — the words are
 * chosen at render, below.
 */
interface LogRow extends AuditLog {
  entity_type: EntityType;
  correlation_id: string | null;
  actor: string | null;
  supplierId: string | null;
  supplierName: string | null;
  productName: string | null;
  /**
   * The currency the supplier trades in (0217) — every money field on their row, and every price
   * on their price list, is a figure in it. `null` when the supplier row is gone: the log
   * outlives what it describes, and a deleted supplier's currency is genuinely unknown rather
   * than shekels by default.
   */
  currency: string | null;
}

type Row = LogRow & {
  subject: string;
  /** The action to display: the reasoned command's, wherever one owns this write. */
  displayAction: string;
  /** The reason recorded for this write — on this row, or on the command that caused it. */
  displayReason: string | null;
  reasonFromCommand: boolean;
};

/** A price row's own identity, resolved from `supplier_products` so the log is not a wall of UUIDs. */
interface PriceRowIdentity {
  supplier_id: string;
  supplier: { id: string; name: string; default_currency: string } | null;
  product: { id: string; name: string } | null;
}

const price = (values: Record<string, unknown> | null | undefined) => {
  const raw = values?.current_price;
  return typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : null;
};

const counted = (values: Record<string, unknown> | null | undefined, field: string) => {
  const raw = values?.[field];
  return typeof raw === 'number' ? raw : 0;
};

/**
 * What an import did, from the numbers the command itself recorded — or null when this is not one.
 *
 * `import_supplier_prices` stores `row_count`, `created`, `updated` and `unchanged` in the
 * command row's `new_values`. Nothing had ever read them, so the one row that summarises the
 * batch went through the price diff, found no `current_price` on either side, and printed
 * „אין נתוני מחיר" over an import that had just moved six prices.
 */
function importOutcome(row: Pick<LogRow, 'entity_type' | 'entity_id' | 'new_values'>) {
  if (row.entity_type !== 'supplier_products' || row.entity_id !== null) return null;
  if (typeof row.new_values?.row_count !== 'number') return null;
  return {
    updated: counted(row.new_values, 'updated'),
    created: counted(row.new_values, 'created'),
    unchanged: counted(row.new_values, 'unchanged'),
  };
}

// The tracked-field catalogue, `renderValue` and `fieldChanges` live in
// `src/lib/supplierLogChanges.ts`: the diff of an audit row is pure logic over two plain objects,
// and testing it should not require supabase and react-router inside jsdom.

export default function SupplierLog() {
  const { t } = useT();
  // An action with no entry renders as itself rather than as a blank — a new command should look
  // unfamiliar, not invisible — so the fallback is the raw column value, in every language.
  const actionLabel = (action: string) => {
    const key = ACTION_KEY[action];
    return key ? t(key) : action;
  };
  const [selected, setSelected] = useState<Row | null>(null);
  const [entityFilter, setEntityFilter] = useParamState('entity');
  const [supplierFilter, setSupplierFilter] = useParamState('supplier');
  const [loaded, setLoaded] = useState(PAGE_SIZE);

  const { data, loading, error, fetching } = useQuery(async () => {
    // `id` as the second sort key, not decoration: every audit row a single transaction writes
    // carries the SAME `created_at` (`now()` is the transaction's clock), so `created_at` alone is
    // not a total order and two pages of an offset read could drop a row between them or repeat
    // one. The count is asked for so the screen can say how much it is NOT showing.
    const response = await supabase.from('audit_log_read_model')
      .select('*', { count: 'exact' })
      // Two clauses, because the third entity type is admitted by action and not wholesale.
      .or(`entity_type.in.(suppliers,supplier_products),`
        + `and(entity_type.eq.products,action.in.(${PRODUCT_NAME_ACTIONS.join(',')}))`)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(0, loaded - 1);
    const logs = unwrap(response) as AuditLog[];

    const priceRowIds = [...new Set(logs
      .filter((log) => log.entity_type === 'supplier_products' && log.entity_id)
      .map((log) => log.entity_id as string))];
    const supplierIds = [...new Set(logs
      .filter((log) => log.entity_type === 'suppliers' && log.entity_id)
      .map((log) => log.entity_id as string))];
    const actorIds = [...new Set(logs.map((log) => log.user_id).filter((id): id is string => !!id))];

    // Three narrow lookups instead of one join: audit_logs has no FK to the row it describes (it
    // outlives it on purpose), so PostgREST cannot embed them.
    const [priceRows, suppliers, profiles] = await Promise.all([
      priceRowIds.length
        ? supabase.from('supplier_products')
          .select('id, supplier_id, supplier:suppliers(id, name, default_currency), product:products(id, name)')
          .in('id', priceRowIds)
        : Promise.resolve({ data: [], error: null }),
      supplierIds.length
        ? supabase.from('suppliers').select('id, name, default_currency').in('id', supplierIds)
        : Promise.resolve({ data: [], error: null }),
      actorIds.length
        ? supabase.from('profiles').select('id, full_name').in('id', actorIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const priceById = new Map((unwrap(priceRows) as (PriceRowIdentity & { id: string })[])
      .map((row) => [row.id, row]));
    const supplierById = new Map((unwrap(suppliers) as { id: string; name: string; default_currency: string }[])
      .map((row) => [row.id, row]));
    const actorById = new Map((unwrap(profiles) as { id: string; full_name: string }[])
      .map((row) => [row.id, row.full_name]));

    const rows = logs.map<LogRow>((log) => {
      const entityType = log.entity_type as EntityType;
      const identity = entityType === 'supplier_products' && log.entity_id
        ? priceById.get(log.entity_id)
        : undefined;
      const supplierRow = entityType === 'suppliers'
        ? (log.entity_id ? supplierById.get(log.entity_id) : undefined)
        : undefined;
      return {
        ...log,
        entity_type: entityType,
        correlation_id: log.correlation_id ?? null,
        actor: log.user_id ? (actorById.get(log.user_id) ?? null) : null,
        supplierId: entityType === 'suppliers' ? log.entity_id : (identity?.supplier_id ?? null),
        supplierName: (entityType === 'suppliers' ? supplierRow?.name : identity?.supplier?.name) ?? null,
        productName: identity?.product?.name ?? null,
        currency: (entityType === 'suppliers' ? supplierRow?.default_currency : identity?.supplier?.default_currency) ?? null,
      };
    });
    return { rows, total: response.count ?? rows.length };
    // Cached mode with `keepPreviousData` is the paging contract of ADR-0007: growing `loaded` is a
    // new key, and the rows the reader is looking at stay on screen while the larger page arrives
    // instead of collapsing to a skeleton.
  }, [], [DOMAIN.suppliers, 'audit-log', loaded], { keepPreviousData: true, structuralSharing: false });

  const entries: LedgerEntry<LogRow>[] = useMemo(() => foldLedger(data?.rows ?? []), [data]);

  /**
   * Which supplier an import belonged to — read, never guessed (`PL-03`).
   *
   * `import_supplier_prices` writes its audit row with `entity_id = null` (`0032:375`), so the
   * price-line lookup resolves nothing for it and the row could only ever count lines. The
   * supplier IS recorded, on every trigger row of the SAME request: `correlation_id` is a column
   * default since `0062` and one browser request carries one id, so the group is a recorded fact
   * rather than an inference from a shared timestamp.
   *
   * A group naming two suppliers names none. A multi-supplier sheet is one request and several
   * commands, and picking one of its suppliers for the row would be the ledger asserting something
   * nobody wrote.
   */
  const supplierByCorrelation = useMemo(() => {
    const found = new Map<string, string | null>();
    for (const entry of entries) {
      const log = entry.row;
      if (log.entity_type !== 'supplier_products' || !log.correlation_id || !log.supplierName) continue;
      const known = found.get(log.correlation_id);
      if (known === undefined) found.set(log.correlation_id, log.supplierName);
      else if (known !== log.supplierName) found.set(log.correlation_id, null);
    }
    return found;
  }, [entries]);

  const all = useMemo<Row[]>(() => entries.map((entry) => {
    const log = entry.row;
    // The deleted-row case is not a gap to hide: old_values still holds what the row was, and a
    // name read from there is more honest than an em dash that implies nothing was recorded.
    const fallbackName = typeof log.old_values?.name === 'string' ? log.old_values.name : null;
    const rowCount = log.new_values?.row_count;
    // The raw product name as the record kept it, on both sides, so a cleared name still has one.
    const productName = typeof log.new_values?.name === 'string' ? log.new_values.name : fallbackName;
    const importSupplier = log.correlation_id
      ? supplierByCorrelation.get(log.correlation_id) ?? null
      : null;
    if (log.entity_type === 'products') {
      return {
        ...log,
        subject: productName ?? t('supplierLog.entityProductNames'),
        displayAction: entry.action,
        displayReason: entry.reason,
        reasonFromCommand: entry.reasonFromCommand,
      };
    }
    return {
      ...log,
      subject: log.entity_type === 'supplier_products'
        ? [log.productName, log.supplierName].filter(Boolean).join(' · ') || (log.entity_id
          // The row names a price line, and the lookup found none: that line really is gone.
          ? t('supplierLog.filter')
          // `entity_id` is NULL, so the row names no price line at all — it is the import command
          // itself (`0032:375`). Calling it a deleted row asserted a deletion the database never
          // performed, on the ledger whose job is to be the record (`OWN-04`).
          : (typeof rowCount === 'number'
            ? (importSupplier
              ? t('supplierLog.subjectImportedRowsFor', { count: rowCount, supplier: importSupplier })
              : t('supplierLog.subjectImportedRows', { count: rowCount }))
            : t('supplierLog.entityPriceList')))
        : log.supplierName ?? fallbackName ?? t('supplierLog.text'),
      displayAction: entry.action,
      displayReason: entry.reason,
      reasonFromCommand: entry.reasonFromCommand,
    };
  }), [entries, supplierByCorrelation, t]);

  const suppliers = useMemo(() => {
    const map = new Map<string, string>();
    all.forEach((row) => {
      if (!row.supplierId) return;
      const name = row.entity_type === 'suppliers' ? row.subject : row.supplierName;
      if (name) map.set(row.supplierId, name);
    });
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'he'));
  }, [all]);

  const rows = useMemo(() => all.filter((row) =>
    (!entityFilter || row.entity_type === entityFilter)
    && (!supplierFilter || row.supplierId === supplierFilter)), [all, entityFilter, supplierFilter]);

  const columns: Column<Row>[] = [
    {
      key: 'time', header: t('supplierLog.text_2'), priority: 2, sortValue: (r) => r.created_at,
      render: (r) => <span className="text-ink-muted">{fmtDateTime(r.created_at)}</span>,
    },
    {
      key: 'subject', header: t('supplierLog.text_3'), priority: 1, sortValue: (r) => r.subject,
      render: (r) => <bdi className="font-medium text-ink">{r.subject}</bdi>,
    },
    {
      key: 'kind', header: t('supplierLog.text_4'), priority: 3,
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 text-ink-soft">
          {r.entity_type === 'supplier_products'
            ? <Tags size={ICON.xs} aria-hidden="true" />
            : r.entity_type === 'products'
              ? <Package size={ICON.xs} aria-hidden="true" />
              : <Truck size={ICON.xs} aria-hidden="true" />}
          {t(ENTITY_KEY[r.entity_type])}
        </span>
      ),
    },
    {
      key: 'action', header: t('supplierLog.text_5'), priority: 2,
      render: (r) => actionLabel(r.displayAction),
    },
    {
      key: 'change', header: t('supplierLog.text_6'), className: 'num',
      // Every branch says what it means in words. The cell used to read `12.50 ← 14.00` and `—`,
      // which put the entire claim on an arrow and a dash: a reader had to know which side of the
      // arrow was the new price, and a dash never said whether the field was cleared or never set.
      // `—` remains the app-wide "no data" glyph everywhere else — this is scoped to the
      // before/after diff on this screen, so please do not "restore consistency" here.
      render: (r) => {
        // The import command row is not a price line and never had a before and an after. Reading
        // it as one produced „אין נתוני מחיר" on the single row that reports what an import did to
        // six prices — the ledger's own summary denying that any price data existed (`PL-03`).
        const outcome = importOutcome(r);
        if (outcome) return <span className="text-ink-muted">{t('supplierLog.importOutcome', outcome)}</span>;
        // A name approval carries no money either. `fieldChanges` already knows which of the two
        // recorded fields moved, so the cell reads it rather than naming the column here — the log
        // says what the record said, and this file never has to hold the column's name.
        if (r.entity_type === 'products') {
          const changes = fieldChanges(r.old_values, r.new_values, t);
          if (!changes.length) return <span className="text-ink-faint">{t('supplierLog.text_7')}</span>;
          return (
            <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              {changes.map((change) => (
                <span key={change.field} className="inline-flex items-baseline gap-1 text-ink">
                  <span className="text-xs text-ink-muted">{change.label}</span>
                  <bdi className="font-semibold">{change.after}</bdi>
                </span>
              ))}
            </span>
          );
        }
        const before = price(r.old_values);
        const after = price(r.new_values);
        const supplierCurrency = r.currency;
        if (before == null && after == null) return <span className="text-ink-faint">{t('supplierLog.text_7')}</span>;
        if (after == null || before === after) {
          return (
            <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ink-muted">
              <span className="text-xs">{t('supplierLog.text_8')}</span>
              <bdi>{renderValue(before, t, 'money', supplierCurrency)}</bdi>
            </span>
          );
        }
        // No dir override: fmtMoneyExact already emits ₪ on the correct side, and forcing LTR here
        // moved the sign to the end of the number. `bdi` keeps each amount atomic instead.
        return (
          <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="inline-flex items-baseline gap-1 text-ink-muted">
              <span className="text-xs">{t('supplierLog.text_9')}</span>
              <bdi className={before == null ? 'text-ink-faint' : undefined}>{renderValue(before, t, 'money', supplierCurrency)}</bdi>
            </span>
            <span className="inline-flex items-baseline gap-1 text-ink">
              <span className="text-xs">{t('supplierLog.text_10')}</span>
              <bdi className="font-semibold">{renderValue(after, t, 'money', supplierCurrency)}</bdi>
            </span>
          </span>
        );
      },
    },
    {
      key: 'actor', header: t('supplierLog.text_11'), priority: 2,
      render: (r) => r.actor ?? <span className="text-ink-muted">{t('supplierLog.text_12')}</span>,
    },
    {
      key: 'reason', header: t('supplierLog.text_13'), priority: 3,
      // An inherited reason says so. It was recorded on the command row of the same request, not
      // on this row, and presenting the two as identical would trade one wrong claim for another.
      render: (r) => (r.displayReason === null
        ? <span className="text-ink-muted">{t('supplierLog.text_14')}</span>
        : (
          <span className="text-ink-muted">
            {r.displayReason}
            {/* `text-ink-muted`, deliberately not `text-ink-faint`: the note states WHERE the
                reason was recorded, which is part of the claim, and DESIGN.md reserves the faint
                token for decoration. */}
            {r.reasonFromCommand && (
              <span className="block text-xs text-ink-muted">{t('supplierLog.reasonFromCommand')}</span>
            )}
          </span>
        )),
    },
  ];

  if (loading) return <SkeletonTable rows={12} cols={7} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title={<span className="flex items-center gap-2"><ScrollText size={ICON.xl} aria-hidden="true" /> {t('supplierLog.text_15')}</span>}
        meta={t('supplierLog.meta', { count: rows.length, total: data?.total ?? rows.length })} />

      {/* 0175: financial rows are legal-entity scoped; organization/identity/platform rows remain
          cross-scope. Ambiguous financial history is visible only to a root-scoped reader. */}
      <DataTable
        rows={rows}
        columns={columns}
        onRowClick={(r) => setSelected(r)}
        rowLabel={(r) => `${actionLabel(r.displayAction)} · ${r.subject}`}
        mobileTitle={(r) => <bdi>{r.subject}</bdi>}
        searchable
        searchLabel={t('supplierLog.searchLabel')}
        searchFn={(r, q) => r.subject.toLowerCase().includes(q)
          || (r.actor ?? '').toLowerCase().includes(q)
          || (r.displayReason ?? '').toLowerCase().includes(q)}
        activeFilters={[entityFilter, supplierFilter].filter(Boolean).length}
        onClearFilters={() => { setEntityFilter(''); setSupplierFilter(''); }}
        toolbar={
          <>
            <select className="input w-auto!" aria-label={t('supplierLog.aria_label')}
              value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}>
              <option value="">{t('supplierLog.text_16')}</option>
              {ENTITY_TYPES.map((type) => <option key={type} value={type}>{t(ENTITY_KEY[type])}</option>)}
            </select>
            <select className="input w-auto!" aria-label={t('supplierLog.aria_label_2')}
              value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
              <option value="">{t('supplierLog.text_17')}</option>
              {suppliers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </>
        }
        emptyTitle={t('supplierLog.emptyTitle')}
        emptySubtitle={t('supplierLog.emptySubtitle')} />

      {/* The floor of the ledger, stated rather than implied. The old screen stopped at 400 rows
          and said "400 האחרונים" under an empty state promising the history is kept; row 401 was
          not filtered out, it was unreachable (`OWN-11`). */}
      {data && data.total > 0 && (
        <div className="flex justify-center">
          {data.rows.length < data.total ? (
            <button type="button" className="btn-secondary" disabled={fetching}
              onClick={() => setLoaded((n) => n + PAGE_SIZE)}>
              {t('supplierLog.loadOlder')}
            </button>
          ) : (
            <p className="text-sm text-ink-muted">{t('supplierLog.allLoaded')}</p>
          )}
        </div>
      )}

      {selected && (
        <Modal open onClose={() => setSelected(null)} wide
          title={`${actionLabel(selected.displayAction)} · ${selected.subject}`}>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">{t('supplierLog.fmtDateTime')}</dt><dd>{fmtDateTime(selected.created_at)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">{t('supplierLog.text_19')}</dt><dd>{selected.actor ?? t('supplierLog.text_18')}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">{t('supplierLog.text_20')}</dt><dd>{t(ENTITY_KEY[selected.entity_type])}</dd>
            </div>
            {selected.displayReason && (
              <div className="bg-surface-sunken rounded-lg px-3 py-2 text-ink-soft">
                {selected.displayReason}
                {selected.reasonFromCommand && (
                  <span className="block text-xs text-ink-muted">{t('supplierLog.reasonFromCommand')}</span>
                )}
              </div>
            )}
          </dl>

          {/* No separate price block: `current_price` is one of the tracked fields below, and
              printing it twice made the modal look like it was reporting two different facts. */}

          {/* Only what actually changed, in words. The raw mutation row used to be printed here and
              the owner read it as noise on sight — UUIDs, org_id, internal column names. That is
              the exact reason the old audit screen was deleted, so it does not come back here. */}
          <div className="mt-4">
            <div className="text-sm font-medium text-ink-soft mb-1.5">{t('supplierLog.text_21')}</div>
            {(() => {
              const changes = fieldChanges(selected.old_values, selected.new_values, t);
              if (!changes.length) {
                return <p className="text-sm text-ink-muted">{t('supplierLog.text_22')}</p>;
              }
              return (
                <dl className="divide-y divide-line-soft border-y border-line-soft text-sm">
                  {changes.map((change) => (
                    // Column on a phone so a long value never squeezes the field label off its line.
                    <div key={change.field}
                      className="flex flex-col gap-1 py-2 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-2">
                      <dt className="text-ink-muted">{change.label}</dt>
                      <dd className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <span className="inline-flex items-baseline gap-1 text-ink-muted">
                          <span className="text-xs">{t('supplierLog.text_23')}</span>
                          <bdi>{change.before}</bdi>
                        </span>
                        <span className="inline-flex items-baseline gap-1 text-ink">
                          <span className="text-xs">{t('supplierLog.text_24')}</span>
                          <bdi className="font-medium">{change.after}</bdi>
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              );
            })()}
          </div>
        </Modal>
      )}
    </div>
  );
}
