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
 */

import { useMemo, useState } from 'react';
import { ScrollText, Tags, Truck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useParamState } from '../lib/useParamState';
import { DataTable, ErrorNote, Modal, PageHeader, SkeletonTable, ICON, type Column } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { fieldChanges, renderValue } from '../lib/supplierLogChanges';
import type { AuditLog } from '../lib/types';

/** The two entity types this log covers. Everything else stays out of the customer-facing app. */
const ENTITY_TYPES = ['suppliers', 'supplier_products'] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

const ENTITY_LABEL: Record<EntityType, string> = {
  suppliers: 'פרטי ספק',
  supplier_products: 'מחירון',
};

/**
 * Both dialects in one map: the generic row-trigger verbs (`insert`/`update`/`delete`) and the
 * named reasoned commands. An action with no entry renders as itself rather than as a blank —
 * a new command should look unfamiliar, not invisible.
 */
const ACTION_LABEL: Record<string, string> = {
  insert: 'יצירה',
  update: 'עדכון',
  delete: 'מחיקה',
  supplier_deleted: 'מחיקת ספק',
  supplier_bank_details_updated: 'עדכון פרטי בנק',
  supplier_product_price_set: 'עדכון מחיר',
  supplier_prices_imported: 'קליטת מחירון',
  price_list_auto_action_reverted: 'ביטול קליטת מחירון אוטומטית',
};

type Row = AuditLog & {
  entity_type: EntityType;
  actor: string | null;
  supplierId: string | null;
  /**
   * The currency the supplier trades in (0217) — every money field on their row, and every price
   * on their price list, is a figure in it. `null` when the supplier row is gone: the log
   * outlives what it describes, and a deleted supplier's currency is genuinely unknown rather
   * than shekels by default.
   */
  currency: string | null;
  subject: string;
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

// The tracked-field catalogue, `renderValue` and `fieldChanges` live in
// `src/lib/supplierLogChanges.ts`: the diff of an audit row is pure logic over two plain objects,
// and testing it should not require supabase and react-router inside jsdom.

export default function SupplierLog() {
  const [selected, setSelected] = useState<Row | null>(null);
  const [entityFilter, setEntityFilter] = useParamState('entity');
  const [supplierFilter, setSupplierFilter] = useParamState('supplier');

  const { data, loading, error } = useQuery(async () => {
    const logs = unwrap(await supabase.from('audit_log_read_model')
      .select('*')
      .in('entity_type', ENTITY_TYPES)
      .order('created_at', { ascending: false })
      .limit(400)) as AuditLog[];

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

    return logs.map<Row>((log) => {
      const entityType = log.entity_type as EntityType;
      const identity = entityType === 'supplier_products' && log.entity_id
        ? priceById.get(log.entity_id)
        : undefined;
      const supplierRow = entityType === 'suppliers'
        ? (log.entity_id ? supplierById.get(log.entity_id) : undefined)
        : undefined;
      const supplierName = entityType === 'suppliers'
        ? supplierRow?.name
        : identity?.supplier?.name;
      // The deleted-row case is not a gap to hide: old_values still holds what the row was, and a
      // name read from there is more honest than an em dash that implies nothing was recorded.
      const fallbackName = typeof log.old_values?.name === 'string' ? log.old_values.name : null;
      return {
        ...log,
        entity_type: entityType,
        actor: log.user_id ? (actorById.get(log.user_id) ?? null) : null,
        supplierId: entityType === 'suppliers' ? log.entity_id : (identity?.supplier_id ?? null),
        currency: (entityType === 'suppliers' ? supplierRow?.default_currency : identity?.supplier?.default_currency) ?? null,
        subject: entityType === 'supplier_products'
          ? [identity?.product?.name, supplierName].filter(Boolean).join(' · ') || 'שורת מחירון שנמחקה'
          : supplierName ?? fallbackName ?? 'ספק שנמחק',
      };
    });
  });

  const suppliers = useMemo(() => {
    const map = new Map<string, string>();
    data?.forEach((row) => {
      if (!row.supplierId) return;
      const name = row.entity_type === 'suppliers' ? row.subject : row.subject.split(' · ').at(-1);
      if (name) map.set(row.supplierId, name);
    });
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], 'he'));
  }, [data]);

  const rows = useMemo(() => (data ?? []).filter((row) =>
    (!entityFilter || row.entity_type === entityFilter)
    && (!supplierFilter || row.supplierId === supplierFilter)), [data, entityFilter, supplierFilter]);

  const columns: Column<Row>[] = [
    {
      key: 'time', header: 'מועד', priority: 2, sortValue: (r) => r.created_at,
      render: (r) => <span className="text-ink-muted">{fmtDateTime(r.created_at)}</span>,
    },
    {
      key: 'subject', header: 'ספק · מוצר', priority: 1, sortValue: (r) => r.subject,
      render: (r) => <bdi className="font-medium text-ink">{r.subject}</bdi>,
    },
    {
      key: 'kind', header: 'סוג', priority: 3,
      render: (r) => (
        <span className="inline-flex items-center gap-1.5 text-ink-soft">
          {r.entity_type === 'supplier_products'
            ? <Tags size={ICON.xs} aria-hidden="true" />
            : <Truck size={ICON.xs} aria-hidden="true" />}
          {ENTITY_LABEL[r.entity_type]}
        </span>
      ),
    },
    {
      key: 'action', header: 'פעולה', priority: 2,
      render: (r) => ACTION_LABEL[r.action] ?? r.action,
    },
    {
      key: 'change', header: 'שינוי', className: 'num',
      // Every branch says what it means in words. The cell used to read `12.50 ← 14.00` and `—`,
      // which put the entire claim on an arrow and a dash: a reader had to know which side of the
      // arrow was the new price, and a dash never said whether the field was cleared or never set.
      // `—` remains the app-wide "no data" glyph everywhere else — this is scoped to the
      // before/after diff on this screen, so please do not "restore consistency" here.
      render: (r) => {
        const before = price(r.old_values);
        const after = price(r.new_values);
        const supplierCurrency = r.currency;
        if (before == null && after == null) return <span className="text-ink-faint">אין נתוני מחיר</span>;
        if (after == null || before === after) {
          return (
            <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-ink-muted">
              <span className="text-xs">ללא שינוי</span>
              <bdi>{renderValue(before, 'money', supplierCurrency)}</bdi>
            </span>
          );
        }
        // No dir override: fmtMoneyExact already emits ₪ on the correct side, and forcing LTR here
        // moved the sign to the end of the number. `bdi` keeps each amount atomic instead.
        return (
          <span className="inline-flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="inline-flex items-baseline gap-1 text-ink-muted">
              <span className="text-xs">לפני</span>
              <bdi className={before == null ? 'text-ink-faint' : undefined}>{renderValue(before, 'money', supplierCurrency)}</bdi>
            </span>
            <span className="inline-flex items-baseline gap-1 text-ink">
              <span className="text-xs">אחרי</span>
              <bdi className="font-semibold">{renderValue(after, 'money', supplierCurrency)}</bdi>
            </span>
          </span>
        );
      },
    },
    {
      key: 'actor', header: 'משתמש', priority: 2,
      render: (r) => r.actor ?? <span className="text-ink-muted">מערכת</span>,
    },
    {
      key: 'reason', header: 'סיבה', priority: 3,
      render: (r) => <span className="text-ink-muted">{r.reason ?? 'לא נרשמה סיבה'}</span>,
    },
  ];

  if (loading) return <SkeletonTable rows={12} cols={7} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title={<span className="flex items-center gap-2"><ScrollText size={ICON.xl} aria-hidden="true" /> יומן עדכון ספקים</span>}
        meta={`${rows.length} עדכונים בתצוגה · 400 האחרונים`} />

      {/* 0175: financial rows are legal-entity scoped; organization/identity/platform rows remain
          cross-scope. Ambiguous financial history is visible only to a root-scoped reader. */}
      <DataTable
        rows={rows}
        columns={columns}
        onRowClick={(r) => setSelected(r)}
        rowLabel={(r) => `${ACTION_LABEL[r.action] ?? r.action} · ${r.subject}`}
        mobileTitle={(r) => <bdi>{r.subject}</bdi>}
        searchable
        searchLabel="חיפוש ביומן"
        searchFn={(r, q) => r.subject.toLowerCase().includes(q)
          || (r.actor ?? '').toLowerCase().includes(q)
          || (r.reason ?? '').toLowerCase().includes(q)}
        activeFilters={[entityFilter, supplierFilter].filter(Boolean).length}
        onClearFilters={() => { setEntityFilter(''); setSupplierFilter(''); }}
        toolbar={
          <>
            <select className="input w-auto!" aria-label="סינון לפי סוג עדכון"
              value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}>
              <option value="">כל העדכונים</option>
              {ENTITY_TYPES.map((type) => <option key={type} value={type}>{ENTITY_LABEL[type]}</option>)}
            </select>
            <select className="input w-auto!" aria-label="סינון לפי ספק"
              value={supplierFilter} onChange={(e) => setSupplierFilter(e.target.value)}>
              <option value="">כל הספקים</option>
              {suppliers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </>
        }
        emptyTitle="אין עדכוני ספקים ביומן"
        emptySubtitle="כל שינוי בפרטי ספק ובמחירון נרשם כאן עם המשתמש שביצע אותו והסיבה שנשמרה" />

      {selected && (
        <Modal open onClose={() => setSelected(null)} wide
          title={`${ACTION_LABEL[selected.action] ?? selected.action} · ${selected.subject}`}>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">מועד</dt><dd>{fmtDateTime(selected.created_at)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">משתמש</dt><dd>{selected.actor ?? 'מערכת'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">סוג</dt><dd>{ENTITY_LABEL[selected.entity_type]}</dd>
            </div>
            {selected.reason && (
              <div className="bg-surface-sunken rounded-lg px-3 py-2 text-ink-soft">{selected.reason}</div>
            )}
          </dl>

          {/* No separate price block: `current_price` is one of the tracked fields below, and
              printing it twice made the modal look like it was reporting two different facts. */}

          {/* Only what actually changed, in words. The raw mutation row used to be printed here and
              the owner read it as noise on sight — UUIDs, org_id, internal column names. That is
              the exact reason the old audit screen was deleted, so it does not come back here. */}
          <div className="mt-4">
            <div className="text-sm font-medium text-ink-soft mb-1.5">מה השתנה</div>
            {(() => {
              const changes = fieldChanges(selected.old_values, selected.new_values);
              if (!changes.length) {
                return <p className="text-sm text-ink-muted">אין שינוי בשדות שהמסך הזה עוקב אחריהם.</p>;
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
                          <span className="text-xs">לפני</span>
                          <bdi>{change.before}</bdi>
                        </span>
                        <span className="inline-flex items-baseline gap-1 text-ink">
                          <span className="text-xs">אחרי</span>
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
