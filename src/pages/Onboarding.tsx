import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toHebrewError } from "../lib/errors";
import { Link, useNavigate } from 'react-router-dom';
import {
  Building2, Tags, Truck, Package, CheckCircle2, Upload, Check, X, Plus,
  ChevronLeft, ChevronRight, Loader2, AlertTriangle, FileSpreadsheet,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { DataTable, PageLoader, useToast, ErrorNote, ConfirmDialog, EmptyState, Note, type Column } from '../components/ui';
import {
  readSheet, autoMapColumns, mapRows, cellText, cellNumber, skipRow, nameKey, groupSkipped,
  type FieldSpec, type MapResult, type SheetData, type SheetRow,
} from '../lib/importSheet';
import { todayISO } from '../lib/format';
import type { Category } from '../lib/types';

/* ================= step model ================= */

const STEPS = [
  { key: 'business', label: 'פרטי העסק', icon: Building2 },
  { key: 'categories', label: 'קטגוריות', icon: Tags },
  { key: 'suppliers', label: 'ספקים', icon: Truck },
  { key: 'products', label: 'מוצרים ומחירון', icon: Package },
  { key: 'done', label: 'סיום', icon: CheckCircle2 },
] as const;

type StepKey = (typeof STEPS)[number]['key'];
const LAST_STEP = STEPS.length - 1;

/**
 * Wizard progress lives in localStorage, not in the database.
 *
 * What was actually imported is already durable — it is rows in `categories`, `suppliers`,
 * `products` and `supplier_products`, and the wizard reads those counts on every mount, so
 * re-opening it on any device shows true completion state rather than a remembered claim.
 * Only the cursor (which step is open, which steps were deliberately skipped) is local, and
 * only that is lost when switching devices. It is deliberately not written to
 * `organizations.settings`: `Settings.tsx` replaces that object wholesale on save, which
 * would silently reset a wizard mid-run. A dedicated column would fix this — see the report.
 *
 * Parsed-but-unconfirmed file contents are never persisted anywhere: an unconfirmed column
 * mapping must not survive a reload and get committed by accident.
 */
interface Progress {
  step: number;
  skipped: StepKey[];
  completedAt: string | null;
}

const EMPTY_PROGRESS: Progress = { step: 0, skipped: [], completedAt: null };
const progressKey = (orgId: string) => `supplyflow.onboarding.${orgId}`;

function loadProgress(orgId: string): Progress {
  try {
    const raw = localStorage.getItem(progressKey(orgId));
    if (!raw) return EMPTY_PROGRESS;
    const p = JSON.parse(raw) as Partial<Progress>;
    return {
      step: typeof p.step === 'number' && p.step >= 0 && p.step <= LAST_STEP ? p.step : 0,
      skipped: Array.isArray(p.skipped) ? (p.skipped.filter((k) => typeof k === 'string') as StepKey[]) : [],
      completedAt: typeof p.completedAt === 'string' ? p.completedAt : null,
    };
  } catch {
    return EMPTY_PROGRESS;
  }
}

function saveProgress(orgId: string, p: Progress) {
  try {
    localStorage.setItem(progressKey(orgId), JSON.stringify(p));
  } catch {
    // private-browsing / quota: the wizard still works, it just will not resume
  }
}

/* ================= shared helpers ================= */

interface OrgBusiness {
  tax_id?: string;
  contact_email?: string;
  contact_phone?: string;
  address?: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'אירעה שגיאה בלתי צפויה');

/* ================= page ================= */

interface Snapshot {
  categories: number;
  suppliers: number;
  products: number;
  prices: number;
}

export default function Onboarding() {
  const { profile, org } = useAuth();
  const orgId = profile?.org_id ?? '';
  const [progress, setProgress] = useState<Progress>(() => (orgId ? loadProgress(orgId) : EMPTY_PROGRESS));

  const { data: snapshot, loading, error, refetch } = useQuery<Snapshot>(async () => {
    const [cats, sups, prods, prices] = await Promise.all([
      supabase.from('categories').select('id', { count: 'exact', head: true }),
      supabase.from('suppliers').select('id', { count: 'exact', head: true }).is('deleted_at', null),
      supabase.from('products').select('id', { count: 'exact', head: true }),
      supabase.from('supplier_products').select('id', { count: 'exact', head: true }),
    ]);
    for (const r of [cats, sups, prods, prices]) if (r.error) throw new Error(r.error.message);
    return {
      categories: cats.count ?? 0,
      suppliers: sups.count ?? 0,
      products: prods.count ?? 0,
      prices: prices.count ?? 0,
    };
  });

  function update(next: Partial<Progress>) {
    setProgress((p) => {
      const merged = { ...p, ...next };
      if (orgId) saveProgress(orgId, merged);
      return merged;
    });
  }

  const goTo = (step: number) => update({ step: Math.max(0, Math.min(LAST_STEP, step)) });

  function skipCurrent() {
    const key = STEPS[progress.step].key;
    update({
      step: Math.min(LAST_STEP, progress.step + 1),
      skipped: progress.skipped.includes(key) ? progress.skipped : [...progress.skipped, key],
    });
  }

  function advance() {
    const key = STEPS[progress.step].key;
    update({
      step: Math.min(LAST_STEP, progress.step + 1),
      skipped: progress.skipped.filter((k) => k !== key),
    });
  }

  async function afterCommit() {
    await refetch();
  }

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  const step = STEPS[progress.step];
  const counts = snapshot ?? { categories: 0, suppliers: 0, products: 0, prices: 0 };

  // a step counts as done when the data it produces exists — not when a flag says so.
  // the org name alone does not prove step 1 ran: provisioning already sets one.
  const doneByData: Record<StepKey, boolean> = {
    business: !!(org?.settings as unknown as { business?: OrgBusiness } | undefined)?.business,
    categories: counts.categories > 0,
    suppliers: counts.suppliers > 0,
    products: counts.products > 0,
    done: !!progress.completedAt,
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">הקמת המערכת</h1>
          <p className="text-sm text-ink-muted mt-1">
            ארבעה שלבים קצרים שממלאים את המערכת בנתוני העסק. אפשר לדלג על כל שלב ולהשלים אותו מאוחר יותר.
          </p>
        </div>
        <Link className="btn-ghost text-ink-muted whitespace-nowrap" to="/dashboard">
          כניסה למערכת <ChevronLeft size={15} />
        </Link>
      </div>

      <Stepper current={progress.step} doneByData={doneByData} skipped={progress.skipped} onSelect={goTo} />

      <div className="card card-pad">
        {step.key === 'business' && <BusinessStep onSaved={() => { void afterCommit(); advance(); }} />}
        {step.key === 'categories' && <CategoriesStep onSaved={() => { void afterCommit(); advance(); }} />}
        {step.key === 'suppliers' && <SuppliersStep onDone={() => { void afterCommit(); advance(); }} />}
        {step.key === 'products' && <ProductsStep onDone={() => { void afterCommit(); advance(); }} />}
        {step.key === 'done' && (
          <DoneStep
            counts={counts}
            skipped={progress.skipped}
            onGoToStep={goTo}
            onFinish={() => update({ completedAt: new Date().toISOString() })}
          />
        )}
      </div>

      <div className="flex items-center justify-between">
        <button className="btn-secondary" disabled={progress.step === 0} onClick={() => goTo(progress.step - 1)}>
          <ChevronRight size={15} /> חזרה
        </button>
        {step.key !== 'done' && (
          <button className="btn-ghost text-ink-muted" onClick={skipCurrent}>
            דילוג על השלב <ChevronLeft size={15} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ================= stepper ================= */

function Stepper({ current, doneByData, skipped, onSelect }: {
  current: number;
  doneByData: Record<StepKey, boolean>;
  skipped: StepKey[];
  onSelect: (i: number) => void;
}) {
  return (
    <ol className="card flex flex-wrap overflow-hidden">
      {STEPS.map((s, i) => {
        const Icon = s.icon;
        const active = i === current;
        const done = doneByData[s.key];
        const wasSkipped = skipped.includes(s.key) && !done;
        return (
          <li key={s.key} className="flex-1 min-w-40 border-b sm:border-b-0 sm:border-s border-line-soft first:border-s-0">
            <button
              onClick={() => onSelect(i)}
              className={`w-full flex items-center gap-2.5 px-4 py-3 text-start transition-colors cursor-pointer
                ${active ? 'bg-action-wash/60' : 'hover:bg-surface-sunken'}`}>
              <span className={`flex size-8 shrink-0 items-center justify-center rounded-full
                ${done ? 'bg-done-soft text-done-fg' : active ? 'bg-action text-white' : 'bg-idle-soft text-ink-faint'}`}>
                {done ? <Check size={16} /> : <Icon size={16} />}
              </span>
              <span className="min-w-0">
                <span className={`block text-sm truncate ${active ? 'font-semibold text-ink' : 'text-ink-mid'}`}>
                  {s.label}
                </span>
                <span className="block text-xs text-ink-muted">
                  {done ? 'הושלם' : wasSkipped ? 'דולג' : `שלב ${i + 1}`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ================= step 1 — business details ================= */

function BusinessStep({ onSaved }: { onSaved: () => void }) {
  const { profile, org } = useAuth();
  const toast = useToast();
  const business = (org?.settings as unknown as { business?: OrgBusiness } | undefined)?.business ?? {};

  const [f, setF] = useState({
    name: org?.name ?? '',
    // 18% is the documented default (docs/OPEN-DECISIONS.md row 1) and the column default;
    // it is stored per invoice, so changing it later never rewrites history
    vat_rate: org?.vat_rate?.toString() ?? '18',
    tax_id: business.tax_id ?? '',
    contact_email: business.contact_email ?? '',
    contact_phone: business.contact_phone ?? '',
    address: business.address ?? '',
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  async function save() {
    const name = f.name.trim();
    if (!name) { toast('שם העסק הוא שדה חובה', 'error'); return; }
    const vat = Number(f.vat_rate);
    if (!Number.isFinite(vat) || vat < 0 || vat > 100) { toast('שיעור מע״מ חייב להיות בין 0 ל־100', 'error'); return; }

    setBusy(true);
    const res = await supabase.from('organizations').update({
      name,
      vat_rate: vat,
      // merge: never drop the bank-matching keys another screen owns
      settings: {
        ...(org?.settings ?? {}),
        business: {
          tax_id: f.tax_id.trim() || null,
          contact_email: f.contact_email.trim() || null,
          contact_phone: f.contact_phone.trim() || null,
          address: f.address.trim() || null,
        },
      },
    }).eq('id', profile!.org_id);
    setBusy(false);
    if (res.error) { toast(toHebrewError(res.error.message), 'error'); return; }
    toast('פרטי העסק נשמרו');
    onSaved();
  }

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<Building2 size={18} />}
        title="פרטי העסק"
        subtitle="השם מופיע בכל מסמך שהמערכת מפיקה. שיעור המע״מ נשמר בנפרד בכל חשבונית, כך ששינוי עתידי לא משנה חשבוניות קיימות."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="label">שם העסק *</label>
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label className="label">ח.פ / עוסק מורשה</label>
          <input className="input" dir="ltr" value={f.tax_id} onChange={(e) => set('tax_id', e.target.value)} />
        </div>
        <div>
          <label className="label">שיעור מע״מ (%)</label>
          <input type="number" step="0.5" min="0" max="100" className="input num"
            value={f.vat_rate} onChange={(e) => set('vat_rate', e.target.value)} />
        </div>
        <div>
          <label className="label">אימייל ליצירת קשר</label>
          <input className="input" dir="ltr" value={f.contact_email} onChange={(e) => set('contact_email', e.target.value)} />
        </div>
        <div>
          <label className="label">טלפון</label>
          <input className="input" dir="ltr" value={f.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label">כתובת</label>
          <input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy && <Loader2 size={15} className="animate-spin" />} שמירה והמשך
        </button>
      </div>
    </div>
  );
}

/* ================= step 2 — categories ================= */

/**
 * Suggestions only — nothing is added until the user clicks.
 *
 * These names are copied verbatim from `starter_categories` in `supabase/seed.sql` so the
 * seed and the wizard offer one list instead of two that drift. Keep them byte-identical:
 * the seed inserts `on conflict (org_id, name) do nothing`, so a stray character (a maqaf
 * instead of a hyphen in "אריזה וחד-פעמי", say) would silently create a duplicate category
 * rather than dedupe against the seeded one.
 */
const CATEGORY_SUGGESTIONS = ['חומרי גלם', 'ציוד', 'חומרי ניקיון', 'אריזה וחד-פעמי', 'ציוד משרדי', 'תחזוקה ותיקונים', 'שירותים'];

interface CategoryDraft { id: string | null; name: string }

function CategoriesStep({ onSaved }: { onSaved: () => void }) {
  const { profile } = useAuth();
  const toast = useToast();
  const { data, loading, error } = useQuery<Category[]>(async () =>
    unwrap(await supabase.from('categories').select('*').order('sort')));

  const [items, setItems] = useState<CategoryDraft[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (data && items === null) setItems(data.map((c) => ({ id: c.id, name: c.name })));
  }, [data, items]);

  const list = items ?? [];
  const taken = useMemo(() => new Set(list.map((c) => nameKey(c.name))), [list]);

  function add(name: string) {
    const clean = name.trim();
    if (!clean) return;
    if (taken.has(nameKey(clean))) { toast('קטגוריה בשם זה כבר ברשימה', 'error'); return; }
    setItems([...list, { id: null, name: clean }]);
    setDraft('');
  }

  async function save() {
    setBusy(true);
    setSaveError(null);
    try {
      const original = data ?? [];
      const kept = new Set(list.filter((c) => c.id).map((c) => c.id));

      const removed = original.filter((c) => !kept.has(c.id));
      for (const c of removed) {
        const res = await supabase.from('categories').delete().eq('id', c.id);
        // a category already attached to products or suppliers is protected by a foreign key
        if (res.error) throw new Error(`לא ניתן למחוק את הקטגוריה "${c.name}" — היא כבר משויכת למוצרים או לספקים.`);
      }

      for (const c of list) {
        if (!c.id) continue;
        const before = original.find((o) => o.id === c.id);
        if (before && before.name !== c.name) {
          const res = await supabase.from('categories').update({ name: c.name }).eq('id', c.id);
          if (res.error) throw new Error(res.error.message);
        }
      }

      const added = list.filter((c) => !c.id);
      if (added.length) {
        const res = await supabase.from('categories').insert(
          added.map((c, i) => ({ org_id: profile!.org_id, name: c.name, sort: list.length + i })),
        );
        if (res.error) throw new Error(res.error.message);
      }

      toast('הקטגוריות נשמרו');
      onSaved();
    } catch (e) {
      setSaveError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  const suggestions = CATEGORY_SUGGESTIONS.filter((s) => !taken.has(nameKey(s)));

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<Tags size={18} />}
        title="קטגוריות"
        subtitle="קטגוריות מקבצות מוצרים וספקים לצורכי סינון ודוחות. אפשר להתחיל בלי אף קטגוריה ולהוסיף בהמשך."
      />

      {saveError && <ErrorNote message={saveError} />}

      <div className="flex gap-2">
        <input className="input" placeholder="שם קטגוריה" value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }} />
        <button className="btn-secondary whitespace-nowrap" onClick={() => add(draft)}><Plus size={15} /> הוספה</button>
      </div>

      {suggestions.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ink-muted mb-2">הצעות — לחיצה מוסיפה לרשימה</div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button key={s} onClick={() => add(s)}
                className="rounded-lg border border-line-strong px-2.5 py-1.5 text-xs text-ink-soft hover:bg-surface-sunken cursor-pointer">
                <Plus size={12} className="inline -mt-px me-1" />{s}
              </button>
            ))}
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState title="אין עדיין קטגוריות" subtitle="הוסף קטגוריה, בחר מההצעות, או דלג על השלב" />
      ) : (
        <ul className="border border-line rounded-lg divide-y divide-line-soft">
          {list.map((c, i) => (
            <li key={c.id ?? `new-${i}`} className="flex items-center gap-2 px-3 py-2">
              <input className="input border-transparent! bg-transparent! focus:bg-surface! focus:border-line-strong!"
                value={c.name}
                onChange={(e) => setItems(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              {!c.id && <span className="badge-info shrink-0">חדשה</span>}
              <button className="btn-ghost p-1.5! shrink-0" aria-label={`הסרת ${c.name}`}
                onClick={() => setItems(list.filter((_, j) => j !== i))}>
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy && <Loader2 size={15} className="animate-spin" />} שמירה והמשך
        </button>
      </div>
    </div>
  );
}

/* ================= generic sheet import ================= */

interface ImportRow { id: string; row: number }

type Parser<T> = (rows: SheetRow[], cols: Record<string, string>) => MapResult<T>;

function SheetImport<T extends ImportRow>({ fields, parse, columns, commit, confirmMessage, onDone, children }: {
  fields: readonly FieldSpec[];
  parse: Parser<T>;
  columns: Column<T>[];
  commit: (rows: T[]) => Promise<string[]>;
  confirmMessage: (count: number) => string;
  onDone: () => void;
  children?: ReactNode;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [cols, setCols] = useState<Record<string, string>>({});
  const [parsed, setParsed] = useState<MapResult<T> | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const missingRequired = fields.filter((f) => f.required && !cols[f.key]);

  function reset() {
    setSheet(null);
    setCols({});
    setParsed(null);
    setReport(null);
    setFailure(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function onFile(file: File) {
    setFailure(null);
    try {
      const data = await readSheet(file);
      setSheet(data);
      setCols(autoMapColumns(data.headers, fields));
      setParsed(null);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  }

  function buildPreview() {
    if (!sheet) return;
    if (missingRequired.length) {
      toast(`יש למפות עמודה עבור: ${missingRequired.map((f) => f.label).join(', ')}`, 'error');
      return;
    }
    setParsed(parse(sheet.rows, cols));
  }

  async function run() {
    if (!parsed) return;
    setConfirming(false);
    setBusy(true);
    setFailure(null);
    try {
      setReport(await commit(parsed.valid));
    } catch (e) {
      setFailure(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  /* ----- done ----- */
  if (report) {
    return (
      <div className="space-y-4">
        <Note tone="done">
          <div className="w-full">
            <div className="font-medium mb-1">הייבוא הסתיים</div>
            <ul className="space-y-0.5">{report.map((line, i) => <li key={i}>{line}</li>)}</ul>
          </div>
        </Note>
        {parsed && parsed.skipped.length > 0 && <SkippedPanel skipped={parsed.skipped} />}
        <div className="flex justify-between">
          <button className="btn-secondary" onClick={reset}>ייבוא קובץ נוסף</button>
          <button className="btn-primary" onClick={onDone}>המשך <ChevronLeft size={15} /></button>
        </div>
      </div>
    );
  }

  /* ----- preview ----- */
  if (sheet && parsed) {
    return (
      <div className="space-y-4">
        {failure && <ErrorNote message={failure} />}
        <div className="text-sm text-ink-soft">
          <b>{sheet.fileName}</b> — {parsed.valid.length} שורות מוכנות לייבוא
          {parsed.skipped.length > 0 && <>, {parsed.skipped.length} ידולגו</>}. שום דבר לא נשמר עד לאישור.
        </div>

        {parsed.valid.length > 0 ? (
          <DataTable rows={parsed.valid} columns={columns} pageSize={10} />
        ) : (
          <EmptyState title="אין שורות תקינות לייבוא" subtitle="בדוק את מיפוי העמודות או את תוכן הקובץ" />
        )}

        {parsed.skipped.length > 0 && <SkippedPanel skipped={parsed.skipped} />}

        <div className="flex justify-between gap-2">
          <button className="btn-secondary" disabled={busy} onClick={() => setParsed(null)}>
            <ChevronRight size={15} /> חזרה למיפוי
          </button>
          <button className="btn-primary" disabled={busy || parsed.valid.length === 0} onClick={() => setConfirming(true)}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} אישור וייבוא
          </button>
        </div>

        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={() => void run()}
          busy={busy}
          title="אישור ייבוא"
          message={confirmMessage(parsed.valid.length)}
          confirmLabel="ייבוא"
        />
      </div>
    );
  }

  /* ----- column mapping ----- */
  if (sheet) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-ink-soft">
          <b>{sheet.fileName}</b> — {sheet.rows.length} שורות. התאם כל שדה לעמודה בקובץ:
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="label">{f.label}{f.required && ' *'}</label>
              <select className="input" value={cols[f.key] ?? ''}
                onChange={(e) => setCols((m) => ({ ...m, [f.key]: e.target.value }))}>
                <option value="">— ללא —</option>
                {sheet.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          ))}
        </div>

        <div className="overflow-x-auto border border-line rounded-lg">
          <table className="w-full">
            <thead className="bg-surface-sunken"><tr>{sheet.headers.map((h) => <th key={h} className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line-soft">
              {sheet.rows.slice(0, 5).map((r, i) => (
                <tr key={i}>{sheet.headers.map((h) => <td key={h} className="td text-ink-muted">{cellText(r, h, 60) || '—'}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-between gap-2">
          <button className="btn-secondary" onClick={reset}>קובץ אחר</button>
          <button className="btn-primary" disabled={missingRequired.length > 0} onClick={buildPreview}>
            תצוגה מקדימה <ChevronLeft size={15} />
          </button>
        </div>
      </div>
    );
  }

  /* ----- file pick ----- */
  return (
    <div className="space-y-4">
      {children}
      <div className="rounded-lg border border-dashed border-line-strong py-10 text-center">
        <FileSpreadsheet size={30} className="text-ink-ghost mx-auto mb-3" />
        <p className="text-sm text-ink-soft mb-4">בחר קובץ Excel (xlsx/xls) או CSV. תוכל להתאים עמודות ולראות תצוגה מקדימה לפני שמירה.</p>
        <button className="btn-primary" onClick={() => fileRef.current?.click()}><Upload size={16} /> בחירת קובץ</button>
        <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv"
          onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
      </div>
    </div>
  );
}

function SkippedPanel({ skipped }: { skipped: { row: number; reason: string }[] }) {
  const groups = groupSkipped(skipped);
  return (
    <Note tone="await">
      <div className="w-full">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle size={15} /> {skipped.length === 1 ? 'שורה אחת דולגה' : `${skipped.length} שורות דולגו`}
        </div>
        <ul className="mt-2 space-y-1 text-xs">
          {groups.map((g) => (
            <li key={g.reason}>
              <b>{g.reason}</b> — {g.rows.length === 1
                ? `שורה ${g.rows[0]}`
                : `${g.rows.length} שורות (${g.rows.slice(0, 8).join(', ')}${g.rows.length > 8 ? ` ועוד ${g.rows.length - 8}` : ''})`}
            </li>
          ))}
        </ul>
      </div>
    </Note>
  );
}

function StepHeading({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex items-start gap-3 pb-4 border-b border-line-soft">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-idle-soft text-ink-soft">{icon}</span>
      <div>
        <h2 className="section-title">{title}</h2>
        <p className="text-sm text-ink-muted mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

/* ================= step 3 — suppliers ================= */

const SUPPLIER_FIELDS: readonly FieldSpec[] = [
  { key: 'name', label: 'שם הספק', aliases: ['ספק', 'supplier', 'name'], required: true },
  { key: 'tax_id', label: 'ח.פ / עוסק', aliases: ['חפ', 'עוסק', 'tax id', 'vat'] },
  { key: 'contact_name', label: 'איש קשר', aliases: ['contact', 'נציג'] },
  { key: 'phone', label: 'טלפון', aliases: ['phone', 'נייד'] },
  { key: 'email', label: 'אימייל', aliases: ['email', 'מייל', 'דואל'] },
  { key: 'address', label: 'כתובת', aliases: ['address', 'עיר'] },
  { key: 'payment_terms', label: 'תנאי תשלום', aliases: ['payment terms', 'תנאים'] },
  { key: 'min_order_amount', label: 'מינימום הזמנה', aliases: ['מינימום', 'min order'] },
];

interface SupplierDraft extends ImportRow {
  name: string;
  tax_id: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  payment_terms: string | null;
  min_order_amount: number | null;
}

function SuppliersStep({ onDone }: { onDone: () => void }) {
  const { profile } = useAuth();
  const existingSupplierKeys = useRef<Set<string>>(new Set());

  const { loading, error } = useQuery(async () => {
    const rows = unwrap(await supabase.from('suppliers').select('name').is('deleted_at', null)) as { name: string }[];
    existingSupplierKeys.current = new Set(rows.map((s) => nameKey(s.name)));
    return rows.length;
  });

  const parse: Parser<SupplierDraft> = (rows, cols) => {
    // resolved once per parse so a re-run after fixing the mapping sees the same baseline
    const existing = existingSupplierKeys.current;
    const seen = new Set<string>();
    return mapRows<SupplierDraft>(rows, (r, rowNumber) => {
      const name = cellText(r, cols.name);
      if (!name) return skipRow('שורה ללא שם ספק');
      const key = nameKey(name);
      if (existing.has(key)) return skipRow('ספק בשם זה כבר קיים במערכת');
      if (seen.has(key)) return skipRow('שם ספק חוזר פעמיים בקובץ');
      seen.add(key);

      const min = cellNumber(r, cols.min_order_amount);
      if (min != null && (min < 0 || min > 10_000_000)) return skipRow('מינימום הזמנה מחוץ לטווח סביר');

      return {
        id: `r${rowNumber}`,
        row: rowNumber,
        name,
        tax_id: cellText(r, cols.tax_id, 40) || null,
        contact_name: cellText(r, cols.contact_name) || null,
        phone: cellText(r, cols.phone, 40) || null,
        email: cellText(r, cols.email, 120) || null,
        address: cellText(r, cols.address) || null,
        payment_terms: cellText(r, cols.payment_terms, 80) || null,
        min_order_amount: min,
      };
    });
  };

  async function commit(rows: SupplierDraft[]): Promise<string[]> {
    let inserted = 0;
    for (const part of chunk(rows, 200)) {
      const res = await supabase.from('suppliers').insert(part.map((r) => ({
        org_id: profile!.org_id,
        name: r.name,
        tax_id: r.tax_id,
        contact_name: r.contact_name,
        phone: r.phone,
        email: r.email,
        address: r.address,
        payment_terms: r.payment_terms,
        min_order_amount: r.min_order_amount,
        status: 'active',
      })));
      if (res.error) {
        throw new Error(`${inserted} ספקים נוצרו, ואז הייבוא נעצר: ${res.error.message}`);
      }
      inserted += part.length;
    }
    return [`נוצרו ${inserted} ספקים.`];
  }

  const columns: Column<SupplierDraft>[] = [
    { key: 'name', header: 'שם הספק', render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'contact', header: 'איש קשר', render: (r) => r.contact_name ?? '—' },
    { key: 'phone', header: 'טלפון', render: (r) => <span dir="ltr">{r.phone ?? '—'}</span> },
    { key: 'email', header: 'אימייל', render: (r) => <span dir="ltr">{r.email ?? '—'}</span> },
    { key: 'terms', header: 'תנאי תשלום', render: (r) => r.payment_terms ?? '—' },
    { key: 'min', header: 'מינ׳ הזמנה', className: 'num', render: (r) => (r.min_order_amount != null ? r.min_order_amount.toFixed(2) : '—') },
  ];

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<Truck size={18} />}
        title="ייבוא ספקים"
        subtitle="העלה את רשימת הספקים מקובץ קיים. ספק שכבר קיים במערכת באותו שם לא ייווצר פעמיים."
      />
      <SheetImport
        fields={SUPPLIER_FIELDS}
        parse={parse}
        columns={columns}
        commit={commit}
        confirmMessage={(n) => `ייווצרו ${n} ספקים חדשים. אפשר לערוך או להשבית אותם אחר כך במסך הספקים.`}
        onDone={onDone}>
        <p className="text-sm text-ink-soft">
          העמודה היחידה שחייבת להיות מופיעה היא <b>שם הספק</b>. כל היתר — ח.פ, איש קשר, טלפון, אימייל, כתובת,
          תנאי תשלום ומינימום הזמנה — אופציונליים וניתן להשלים אותם ידנית בהמשך.
        </p>
      </SheetImport>
    </div>
  );
}

/* ================= step 4 — products + price list ================= */

const PRODUCT_FIELDS: readonly FieldSpec[] = [
  { key: 'name', label: 'שם המוצר', aliases: ['מוצר', 'product', 'פריט'], required: true },
  { key: 'category', label: 'קטגוריה', aliases: ['category', 'קבוצה'] },
  { key: 'unit', label: 'יחידת מידה', aliases: ['יחידה', 'unit'] },
  { key: 'sku', label: 'מק״ט', aliases: ['sku', 'קטלוגי', 'code'] },
  { key: 'supplier', label: 'ספק', aliases: ['supplier'] },
  { key: 'price', label: 'מחיר', aliases: ['price', 'עלות'] },
];

interface ProductDraft extends ImportRow {
  name: string;
  category: string;
  unit: string;
  sku: string | null;
  supplier: string;
  price: number | null;
  /** id of an already-existing product with this name; the row then only contributes a price */
  existingProductId: string | null;
  /** why the price half of this row will not be applied, if it will not */
  priceNote: string | null;
}

interface CatalogIndex {
  products: Map<string, string>;
  suppliers: Map<string, string>;
  categories: Map<string, string>;
}

function ProductsStep({ onDone }: { onDone: () => void }) {
  const { profile } = useAuth();
  const index = useRef<CatalogIndex>({ products: new Map(), suppliers: new Map(), categories: new Map() });

  const { data: counts, loading, error } = useQuery(async () => {
    const [prods, sups, cats] = await Promise.all([
      supabase.from('products').select('id, name'),
      supabase.from('suppliers').select('id, name').is('deleted_at', null),
      supabase.from('categories').select('id, name'),
    ]);
    for (const r of [prods, sups, cats]) if (r.error) throw new Error(r.error.message);
    const toMap = (rows: { id: string; name: string }[]) => new Map(rows.map((r) => [nameKey(r.name), r.id]));
    index.current = {
      products: toMap((prods.data ?? []) as { id: string; name: string }[]),
      suppliers: toMap((sups.data ?? []) as { id: string; name: string }[]),
      categories: toMap((cats.data ?? []) as { id: string; name: string }[]),
    };
    return { suppliers: index.current.suppliers.size };
  });

  const parse: Parser<ProductDraft> = (rows, cols) => {
    const { products, suppliers } = index.current;
    const seen = new Set<string>();
    return mapRows<ProductDraft>(rows, (r, rowNumber) => {
      const name = cellText(r, cols.name);
      if (!name) return skipRow('שורה ללא שם מוצר');

      const supplier = cellText(r, cols.supplier);
      const pairKey = `${nameKey(name)}|${nameKey(supplier)}`;
      if (seen.has(pairKey)) return skipRow('שילוב מוצר וספק חוזר פעמיים בקובץ');
      seen.add(pairKey);

      const rawPrice = cellNumber(r, cols.price);
      let price: number | null = rawPrice;
      let priceNote: string | null = null;

      if (rawPrice != null && (rawPrice <= 0 || rawPrice > 1_000_000)) {
        price = null;
        priceNote = 'מחיר מחוץ לטווח סביר — לא ייובא';
      } else if (rawPrice != null && !supplier) {
        price = null;
        priceNote = 'מחיר ללא ספק — לא ייובא';
      } else if (rawPrice != null && !suppliers.has(nameKey(supplier))) {
        price = null;
        priceNote = 'ספק לא נמצא בשם מדויק — המחיר לא ייובא';
      }

      const existingProductId = products.get(nameKey(name)) ?? null;
      if (existingProductId && price == null) {
        return skipRow('מוצר קיים כבר במערכת ואין בשורה מחיר חדש');
      }

      return {
        id: `r${rowNumber}`,
        row: rowNumber,
        name,
        category: cellText(r, cols.category, 80),
        unit: cellText(r, cols.unit, 40) || 'יח׳',
        sku: cellText(r, cols.sku, 60) || null,
        supplier,
        price,
        existingProductId,
        priceNote,
      };
    });
  };

  async function commit(rows: ProductDraft[]): Promise<string[]> {
    const { products, suppliers, categories } = index.current;
    const orgId = profile!.org_id;

    // 1. categories referenced by the file but not yet defined
    const newCategoryNames = [...new Set(
      rows.map((r) => r.category).filter((c) => c && !categories.has(nameKey(c))),
    )];
    if (newCategoryNames.length) {
      const res = await supabase.from('categories')
        .insert(newCategoryNames.map((name, i) => ({ org_id: orgId, name, sort: categories.size + i })))
        .select('id, name');
      if (res.error) throw new Error(`יצירת הקטגוריות נכשלה: ${res.error.message}`);
      for (const c of (res.data ?? []) as { id: string; name: string }[]) categories.set(nameKey(c.name), c.id);
    }

    // 2. products that do not exist yet
    const toCreate = rows.filter((r) => !r.existingProductId);
    let createdProducts = 0;
    for (const part of chunk(toCreate, 200)) {
      const res = await supabase.from('products').insert(part.map((r) => ({
        org_id: orgId,
        name: r.name,
        category_id: r.category ? categories.get(nameKey(r.category)) ?? null : null,
        unit: r.unit,
        sku: r.sku,
        active: true,
      }))).select('id, name');
      if (res.error) throw new Error(`${createdProducts} מוצרים נוצרו, ואז הייבוא נעצר: ${res.error.message}`);
      for (const p of (res.data ?? []) as { id: string; name: string }[]) products.set(nameKey(p.name), p.id);
      createdProducts += part.length;
    }

    // 3. price rows — only where a supplier resolved and the price survived validation
    let pricesSet = 0;
    const priceFailures: number[] = [];
    for (const r of rows) {
      if (r.price == null) continue;
      const supplierId = suppliers.get(nameKey(r.supplier));
      const productId = r.existingProductId ?? products.get(nameKey(r.name));
      if (!supplierId || !productId) { priceFailures.push(r.row); continue; }

      const ins = await supabase.from('supplier_products').insert({
        org_id: orgId,
        supplier_id: supplierId,
        product_id: productId,
        current_price: r.price,
        price_effective_date: todayISO(),
      }).select('id').single();

      if (ins.error || !ins.data) { priceFailures.push(r.row); continue; }
      await supabase.from('price_history').insert({
        org_id: orgId,
        supplier_product_id: (ins.data as { id: string }).id,
        price: r.price,
        effective_date: todayISO(),
        created_by: profile!.id,
      });
      pricesSet++;
    }

    const lines = [`נוצרו ${createdProducts} מוצרים.`];
    if (newCategoryNames.length) lines.push(`נוצרו ${newCategoryNames.length} קטגוריות חדשות מתוך הקובץ.`);
    lines.push(pricesSet ? `נקבעו ${pricesSet} מחירי ספק.` : 'לא נקבעו מחירי ספק בייבוא הזה.');
    if (priceFailures.length) {
      lines.push(`${priceFailures.length} מחירים לא נשמרו (שורות ${priceFailures.slice(0, 10).join(', ')}${priceFailures.length > 10 ? ' ועוד' : ''}) — ייתכן שכבר קיים מחיר לאותו ספק ומוצר.`);
    }
    return lines;
  }

  const columns: Column<ProductDraft>[] = [
    { key: 'name', header: 'מוצר', render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'cat', header: 'קטגוריה', render: (r) => r.category || '—' },
    { key: 'unit', header: 'יח׳', render: (r) => r.unit },
    { key: 'sku', header: 'מק״ט', render: (r) => <span dir="ltr">{r.sku ?? '—'}</span> },
    { key: 'supplier', header: 'ספק', render: (r) => r.supplier || '—' },
    { key: 'price', header: 'מחיר', className: 'num', render: (r) => (r.price != null ? `₪${r.price.toFixed(2)}` : '—') },
    {
      key: 'note', header: 'הערה',
      render: (r) => {
        if (r.priceNote) return <span className="text-await-fg text-xs">{r.priceNote}</span>;
        if (r.existingProductId) return <span className="text-ink-muted text-xs">מוצר קיים — יתווסף רק המחיר</span>;
        return <span className="text-ink-ghost">—</span>;
      },
    },
  ];

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<Package size={18} />}
        title="ייבוא מוצרים ומחירון"
        subtitle="אותו קובץ יכול להכיל גם את המוצרים וגם מחיר לכל ספק. קטגוריה שאינה קיימת עדיין תיווצר אוטומטית."
      />
      {counts?.suppliers === 0 && (
        <Note tone="await">
          עדיין אין ספקים במערכת, ולכן עמודת מחיר לא תיובא — המוצרים ייווצרו בלי מחירון.
          אפשר לחזור לשלב הספקים, או לייבא מחירון בהמשך ממסך <b>מחירונים</b>.
        </Note>
      )}
      <SheetImport
        fields={PRODUCT_FIELDS}
        parse={parse}
        columns={columns}
        commit={commit}
        confirmMessage={(n) => `${n} שורות ייכתבו למערכת: מוצרים חדשים, קטגוריות חסרות ומחירי ספק.`}
        onDone={onDone}>
        <p className="text-sm text-ink-soft">
          חובה למפות <b>שם המוצר</b> בלבד. אם הקובץ מכיל גם <b>ספק</b> וגם <b>מחיר</b>, ייבנה מהם מחירון —
          שם הספק חייב להיות זהה לשם שכבר קיים במערכת.
        </p>
      </SheetImport>
    </div>
  );
}

/* ================= step 5 — done ================= */

function DoneStep({ counts, skipped, onGoToStep, onFinish }: {
  counts: Snapshot;
  skipped: StepKey[];
  onGoToStep: (i: number) => void;
  onFinish: () => void;
}) {
  const navigate = useNavigate();
  const pending = STEPS.filter((s) => s.key !== 'done' && skipped.includes(s.key));

  const tiles: { label: string; value: number; to: string }[] = [
    { label: 'קטגוריות', value: counts.categories, to: '/products' },
    { label: 'ספקים', value: counts.suppliers, to: '/suppliers' },
    { label: 'מוצרים', value: counts.products, to: '/products' },
    { label: 'מחירי ספק', value: counts.prices, to: '/prices' },
  ];

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<CheckCircle2 size={18} />}
        title="הכול מוכן"
        subtitle="זה מה שיש כרגע במערכת. אפשר להתחיל לעבוד ולהשלים את השאר בכל רגע."
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="card card-pad card-link-hover">
            <div className="text-xs font-medium text-ink-muted">{t.label}</div>
            <div className="text-xl font-bold num text-start text-ink mt-1">{t.value}</div>
          </Link>
        ))}
      </div>

      {pending.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-sunken px-4 py-3">
          <div className="text-sm font-medium text-ink-mid">שלבים שדילגת עליהם</div>
          <div className="flex flex-wrap gap-2 mt-2">
            {pending.map((s) => (
              <button key={s.key} className="btn-secondary py-1.5! text-xs"
                onClick={() => onGoToStep(STEPS.findIndex((x) => x.key === s.key))}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-line px-4 py-3 text-sm text-ink-soft">
        <div className="font-medium text-ink-mid mb-1">מה הלאה</div>
        <ul className="space-y-1">
          <li>· הוספת משתמשי צוות והרשאות — מסך <Link className="link" to="/settings">הגדרות</Link>.</li>
          <li>· עדכון מחירון או ייבוא נוסף — מסך <Link className="link" to="/prices">מחירונים</Link>.</li>
          <li>· יצירת ההזמנה הראשונה — מסך <Link className="link" to="/orders/new">הזמנה חדשה</Link>.</li>
        </ul>
      </div>

      <div className="flex justify-end">
        <button className="btn-primary" onClick={() => { onFinish(); navigate('/dashboard'); }}>
          כניסה למערכת <ChevronLeft size={15} />
        </button>
      </div>
    </div>
  );
}
