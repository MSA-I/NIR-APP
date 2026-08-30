import type { TKey } from '../lib/i18n/t';
import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Building2, Tags, Truck, Package, CheckCircle2, Upload, Check, X, Plus,
  ChevronLeft, ChevronRight, Loader2, AlertTriangle, FileSpreadsheet,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { Card, DataTable, SkeletonList, useToast, ErrorNote, ConfirmDialog, EmptyState, Note, PageHeader, SubPanel, ICON, type Column } from '../components/ui';
import {
  readSheet, autoMapColumns, mapRows, cellText, cellNumber, skipRow, nameKey, groupSkipped,
  type FieldSpec, type MapResult, type SheetData, type SheetRow,
} from '../lib/importSheet';
import { fmtMoneyExact, formatUnit, normalizeUnitInput, todayISO } from '../lib/format';
import { QuickCreateSupplier, type QuickCreatedSupplier } from '../components/QuickCreateSupplier';
import type { Category } from '../lib/types';

/* ================= step model ================= */

const STEPS = [
  { key: 'business', labelKey: 'onboarding.stepBusiness', icon: Building2 },
  { key: 'categories', labelKey: 'onboarding.stepCategories', icon: Tags },
  { key: 'suppliers', labelKey: 'onboarding.stepSuppliers', icon: Truck },
  { key: 'products', labelKey: 'onboarding.stepProducts', icon: Package },
  { key: 'done', labelKey: 'onboarding.stepDone', icon: CheckCircle2 },
] as const satisfies readonly { key: string; labelKey: TKey; icon: typeof Building2 }[];

type StepKey = (typeof STEPS)[number]['key'];
const LAST_STEP = STEPS.length - 1;

/**
 * The wizard's CURSOR lives in localStorage. Its ENDING does not.
 *
 * What was actually imported is already durable — it is rows in `categories`, `suppliers`,
 * `products` and `supplier_products`, and the wizard reads those counts on every mount, so
 * re-opening it on any device shows true completion state rather than a remembered claim.
 * Only the cursor (which step is open, which steps were deliberately skipped) is local, and
 * only that is lost when switching devices. It is deliberately not written to
 * `organizations.settings`: `Settings.tsx` replaces that object wholesale on save, which
 * would silently reset a wizard mid-run.
 *
 * `completedAt` used to live here too, and that was the bug the owner reported: pressing finish
 * recorded the ending in a place no other screen reads and no second browser sees, so the sidebar
 * and the dashboard banner went on offering the wizard for ever. It now has the dedicated column
 * this comment used to ask for — `organizations.onboarding_completed_at` (0258) — and the ending
 * is read from `org`, not from here.
 *
 * Parsed-but-unconfirmed file contents are never persisted anywhere: an unconfirmed column
 * mapping must not survive a reload and get committed by accident.
 */
interface Progress {
  step: number;
  skipped: StepKey[];
}

const EMPTY_PROGRESS: Progress = { step: 0, skipped: [] };
const progressKey = (orgId: string) => `supplyflow.onboarding.${orgId}`;

function loadProgress(orgId: string): Progress {
  try {
    const raw = localStorage.getItem(progressKey(orgId));
    if (!raw) return EMPTY_PROGRESS;
    const p = JSON.parse(raw) as Partial<Progress>;
    return {
      step: typeof p.step === 'number' && p.step >= 0 && p.step <= LAST_STEP ? p.step : 0,
      skipped: Array.isArray(p.skipped) ? (p.skipped.filter((k) => typeof k === 'string') as StepKey[]) : [],
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

/* ================= page ================= */

interface Snapshot {
  categories: number;
  suppliers: number;
  products: number;
  prices: number;
}

export default function Onboarding() {
  const { errorText, t } = useT();
  const { profile, org, refreshOrg } = useAuth();
  const toast = useToast();
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

  /**
   * The ending, written where every other screen can see it (0258).
   *
   * Returns whether it landed. A finish that failed must not navigate away as though it had
   * worked: the owner would arrive at a dashboard still offering the wizard, with nothing on
   * screen to say why. Failing here keeps them on the step with the reason in a toast and the
   * button ready to try again.
   */
  async function finishSetup(): Promise<boolean> {
    if (!orgId) return false;
    const res = await supabase.from('organizations')
      .update({ onboarding_completed_at: new Date().toISOString() })
      .eq('id', orgId);
    if (res.error) { toast(errorText(res.error.message), 'error'); return false; }
    // The sidebar and the avatar menu are drawn from this column, and they are on screen right
    // now. Without the re-read they would go on offering the wizard until the next full reload.
    await refreshOrg();
    return true;
  }

  if (loading) return <SkeletonList rows={4} />;
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
    // The one step whose truth is a statement rather than a count, and the only one that survives
    // a change of browser now that it lives on the organisation.
    done: !!org?.onboarding_completed_at,
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <PageHeader
        title={t('onboarding.title')}
        description={t('onboarding.description')}
        actions={(
          <Link className="btn-ghost text-ink-muted whitespace-nowrap" to="/dashboard">
            {t('onboarding.enterSystem')} <ChevronLeft size={ICON.sm} aria-hidden="true" />
          </Link>
        )} />

      <Stepper current={progress.step} doneByData={doneByData} skipped={progress.skipped} onSelect={goTo} />

      <Card>
        {step.key === 'business' && <BusinessStep onSaved={() => { void afterCommit(); advance(); }} />}
        {step.key === 'categories' && <CategoriesStep onSaved={() => { void afterCommit(); advance(); }} />}
        {step.key === 'suppliers' && <SuppliersStep onDone={() => { void afterCommit(); advance(); }} />}
        {step.key === 'products' && <ProductsStep onDone={() => { void afterCommit(); advance(); }} />}
        {step.key === 'done' && (
          <DoneStep
            counts={counts}
            skipped={progress.skipped}
            onGoToStep={goTo}
            onFinish={finishSetup}
          />
        )}
      </Card>

      <div className="flex items-center justify-between">
        <button className="btn-secondary" disabled={progress.step === 0} onClick={() => goTo(progress.step - 1)}>
          <ChevronRight size={ICON.sm} aria-hidden="true" /> {t('onboarding.back')}
        </button>
        {step.key !== 'done' && (
          <button className="btn-ghost text-ink-muted" onClick={skipCurrent}>
            {t('onboarding.skipStep')} <ChevronLeft size={ICON.sm} aria-hidden="true" />
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
  const { t } = useT();
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
              aria-current={active ? 'step' : undefined}
              aria-pressed={active}
              className={`w-full flex items-center gap-2.5 px-4 py-3 text-start transition-colors cursor-pointer
                ${active ? 'bg-action-wash/60' : 'hover:bg-surface-hover'}`}>
              <span className={`flex size-8 shrink-0 items-center justify-center rounded-full
                ${done ? 'bg-done-soft text-done-fg' : active ? 'bg-action text-on-solid' : 'bg-idle-soft text-ink-faint'}`}>
                {done ? <Check size={ICON.sm} aria-hidden="true" /> : <Icon size={ICON.sm} aria-hidden="true" />}
              </span>
              <span className="min-w-0">
                <span className={`block text-sm truncate ${active ? 'font-semibold text-ink' : 'text-ink-mid'}`}>
                  {t(s.labelKey)}
                </span>
                <span className="block text-xs text-ink-muted">
                  {/* „סיכום" and not „שלב 5": the header promises four short steps that fill the
                      system with business data, and that is what the first four do. The last entry
                      reviews what was entered and closes the wizard — numbering it made the screen
                      contradict its own heading (audit 2026-08-25). */}
                  {done ? t('onboarding.badgeDone') : wasSkipped ? t('onboarding.badgeSkipped') : s.key === 'done' ? t('onboarding.badgeSummary') : t('onboarding.badgeStepN', { n: i + 1 })}
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
  const { errorText, t } = useT();
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
    if (!name) { toast(t('onboarding.toast'), 'error'); return; }
    const vat = Number(f.vat_rate);
    if (!Number.isFinite(vat) || vat < 0 || vat > 100) { toast(t('onboarding.isFinite'), 'error'); return; }

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
    if (res.error) { toast(errorText(res.error.message), 'error'); return; }
    toast(t('onboarding.toast_2'));
    onSaved();
  }

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<Building2 size={ICON.md} aria-hidden="true" />}
        title={t('onboarding.title_2')}
        subtitle={t('onboarding.subtitle')}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="onboarding-business-name">{t('onboarding.text')}</label>
          <input id="onboarding-business-name" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="onboarding-tax-id">{t('onboarding.text_2')}</label>
          <input id="onboarding-tax-id" className="input" dir="ltr" value={f.tax_id} onChange={(e) => set('tax_id', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="onboarding-vat-rate">{t('onboarding.text_3')}</label>
          <input id="onboarding-vat-rate" type="number" step="0.5" min="0" max="100" className="input num"
            value={f.vat_rate} onChange={(e) => set('vat_rate', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="onboarding-contact-email">{t('onboarding.text_4')}</label>
          <input id="onboarding-contact-email" className="input" dir="ltr" value={f.contact_email} onChange={(e) => set('contact_email', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="onboarding-contact-phone">{t('onboarding.text_5')}</label>
          <input id="onboarding-contact-phone" className="input" dir="ltr" value={f.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="onboarding-address">{t('onboarding.text_6')}</label>
          <input id="onboarding-address" className="input" value={f.address} onChange={(e) => set('address', e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy && <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />} {t('onboarding.saveAndContinue')}
        </button>
      </div>
    </div>
  );
}

/* ================= step 2 — categories ================= */

/**
 * Suggestions only — nothing is added until the user clicks.
 *
 * OWNER DECISION, 28.08.2026: a suggestion is STORED IN THE LANGUAGE IT WAS OFFERED IN. An English
 * session that clicks "Raw materials" gets a category called `Raw materials`, not `חומרי גלם`.
 * That is a deliberate exception to the rule that an organisation's own vocabulary is never
 * translated for it: nothing is being translated here, because nothing existed yet — the click
 * CREATES the category, and it should be created in the language the person is working in.
 *
 * What this costs, recorded rather than discovered later. These names used to be byte-identical
 * to `starter_categories` in `supabase/seed.sql`, so that an org which ran the seed and then the
 * wizard deduped through `on conflict (org_id, name) do nothing` instead of ending up with two
 * rows for one idea. In English that dedupe no longer happens — the seed's row is Hebrew and the
 * wizard's is English. It is accepted because `seed.sql` is a manual, operator-run baseline
 * (its own header says so) and not part of tenant signup, so the two rarely meet.
 *
 * The Hebrew list stayed byte-identical for the same reason, and is NOT: `seed.sql:49` writes
 * "אריזה וחד־פעמי" with a MAQAF (U+05BE) and this list writes a HYPHEN-MINUS (U+002D). `nameKey`
 * strips quotes and collapses whitespace but does not touch dashes, so those two are different
 * keys and a Hebrew org that met both already gets the duplicate this comment warned about. That
 * is a pre-existing defect in the seed, reported separately; it is not this feature's to fix.
 */
const CATEGORY_SUGGESTIONS = [
  { labelKey: 'onboarding.categoryRawMaterials' },
  { labelKey: 'onboarding.categoryEquipment' },
  { labelKey: 'onboarding.categoryCleaning' },
  { labelKey: 'onboarding.categoryPackaging' },
  { labelKey: 'onboarding.categoryOffice' },
  { labelKey: 'onboarding.categoryMaintenance' },
  { labelKey: 'onboarding.categoryServices' },
] as const satisfies readonly { labelKey: TKey }[];

interface CategoryDraft { id: string | null; name: string }

function CategoriesStep({ onSaved }: { onSaved: () => void }) {
  const { errorText, t } = useT();
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
    if (taken.has(nameKey(clean))) { toast(t('onboarding.has'), 'error'); return; }
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
        if (res.error) throw new Error(t('onboarding.categoryDeleteBlocked', { name: c.name }));
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

      toast(t('onboarding.toast_3'));
      onSaved();
    } catch (e) {
      setSaveError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <SkeletonList rows={4} />;
  if (error) return <ErrorNote message={error} />;

  const suggestions = CATEGORY_SUGGESTIONS.filter((s) => !taken.has(nameKey(t(s.labelKey))));

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<Tags size={ICON.md} aria-hidden="true" />}
        title={t('onboarding.title_3')}
        subtitle={t('onboarding.subtitle_2')}
      />

      {saveError && <ErrorNote message={saveError} />}

      <div className="flex gap-2">
        <input className="input" aria-label={t('onboarding.aria_label')} placeholder={t('onboarding.placeholder')} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }} />
        <button className="btn-secondary whitespace-nowrap" onClick={() => add(draft)}><Plus size={ICON.sm} aria-hidden="true" /> {t('onboarding.add')}</button>
      </div>

      {suggestions.length > 0 && (
        <div>
          <div className="text-xs font-medium text-ink-muted mb-2">{t('onboarding.text_7')}</div>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((s) => (
              <button key={s.labelKey} type="button" aria-label={t('onboarding.addCategoryLabel', { name: t(s.labelKey) })} onClick={() => add(t(s.labelKey))}
                className="btn-secondary btn-sm">
                <Plus size={ICON.xs} aria-hidden="true" />{t(s.labelKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <EmptyState title={t('onboarding.title_4')} subtitle={t('onboarding.subtitle_3')} />
      ) : (
        <ul className="border border-line rounded-lg divide-y divide-line-soft">
          {list.map((c, i) => (
            <li key={c.id ?? `new-${i}`} className="flex items-center gap-2 px-3 py-2">
              <input className="input border-transparent! bg-transparent! focus:bg-surface! focus:border-line-strong!"
                aria-label={t('onboarding.categoryNameLabel', { name: c.name || i + 1 })}
                value={c.name}
                onChange={(e) => setItems(list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              {!c.id && <span className="badge-info shrink-0">{t('onboarding.text_8')}</span>}
              <button type="button" className="btn-ghost btn-icon" aria-label={t('onboarding.removeCategoryLabel', { name: c.name })}
                onClick={() => setItems(list.filter((_, j) => j !== i))}>
                <X size={ICON.sm} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>
          {busy && <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />} {t('onboarding.saveAndContinue')}
        </button>
      </div>
    </div>
  );
}

/* ================= generic sheet import ================= */

interface ImportRow { id: string; row: number }

type Parser<T> = (rows: SheetRow[], cols: Record<string, string>) => MapResult<T>;

function SheetImport<T extends ImportRow>({ fields, parse, columns, commit, confirmMessage, requireReason = false, onDone, children }: {
  fields: readonly FieldSpec[];
  parse: Parser<T>;
  columns: Column<T>[];
  commit: (rows: T[], reason?: string) => Promise<string[]>;
  confirmMessage: (count: number) => string;
  requireReason?: boolean;
  onDone: () => void;
  children?: ReactNode;
}) {
  const { errorText, t } = useT();
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
      const data = await readSheet(file, t);
      setSheet(data);
      setCols(autoMapColumns(data.headers, fields));
      setParsed(null);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  function buildPreview() {
    if (!sheet) return;
    if (missingRequired.length) {
      toast(t('onboarding.mapColumnsMissing', { fields: missingRequired.map((f) => f.label).join(', ') }), 'error');
      return;
    }
    setParsed(parse(sheet.rows, cols));
  }

  async function run(reason?: string) {
    if (!parsed) return;
    setBusy(true);
    setFailure(null);
    try {
      const nextReport = await commit(parsed.valid, reason);
      setReport(nextReport);
      setConfirming(false);
    } catch (e) {
      setFailure(errorText(e));
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
            <div className="font-medium mb-1">{t('onboarding.text_9')}</div>
            <ul className="space-y-0.5">{report.map((line, i) => <li key={i}>{line}</li>)}</ul>
          </div>
        </Note>
        {parsed && parsed.skipped.length > 0 && <SkippedPanel skipped={parsed.skipped} />}
        <div className="flex justify-between">
          <button className="btn-secondary" onClick={reset}>{t('onboarding.text_10')}</button>
          <button type="button" className="btn-primary" onClick={onDone}>{t('onboarding.text_11')} <ChevronLeft size={ICON.sm} aria-hidden="true" /></button>
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
          <b>{sheet.fileName}</b> — {t('onboarding.rowsReady', { count: parsed.valid.length })}
          {parsed.skipped.length > 0 && <>{t('onboarding.rowsWillSkip', { count: parsed.skipped.length })}</>}{t('onboarding.nothingSavedYet')}
        </div>

        {parsed.valid.length > 0 ? (
          <DataTable rows={parsed.valid} columns={columns} pageSize={10} mobile="scroll" rowLabel={(row) => t('onboarding.importRowLabel', { row: row.row })} />
        ) : (
          <EmptyState title={t('onboarding.title_5')} subtitle={t('onboarding.subtitle_4')} />
        )}

        {parsed.skipped.length > 0 && <SkippedPanel skipped={parsed.skipped} />}

        <div className="flex justify-between gap-2">
          <button className="btn-secondary" disabled={busy} onClick={() => setParsed(null)}>
            <ChevronRight size={ICON.sm} aria-hidden="true" /> {t('onboarding.backToMapping')}
          </button>
          <button className="btn-primary" disabled={busy || parsed.valid.length === 0} onClick={() => setConfirming(true)}>
            {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <Upload size={ICON.sm} aria-hidden="true" />} {t('onboarding.confirmAndImport')}
          </button>
        </div>

        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={(reason) => void run(reason)}
          busy={busy}
          title={t('onboarding.title_6')}
          message={confirmMessage(parsed.valid.length)}
          confirmLabel={t('onboarding.confirmLabel')}
          requireReason={requireReason}
        />
      </div>
    );
  }

  /* ----- column mapping ----- */
  if (sheet) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-ink-soft">
          <b>{sheet.fileName}</b> — {t('onboarding.mapEachField', { count: sheet.rows.length })}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {fields.map((f) => (
            <div key={f.key}>
              <label className="label" htmlFor={`import-column-${f.key}`}>{f.label}{f.required && ' *'}</label>
              <select id={`import-column-${f.key}`} className="input" value={cols[f.key] ?? ''}
                onChange={(e) => setCols((m) => ({ ...m, [f.key]: e.target.value }))}>
                <option value="">{t('onboarding.text_12')}</option>
                {sheet.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          ))}
        </div>

        {/* Not a DataTable: the columns come from whatever sheet the user picked, and the rows
            have no id — DataTable needs `T extends { id: string }`. So it stays raw and carries
            the raw-table contract instead: a keyboard-reachable scroller with a name. */}
        <div className="table-scroll overflow-x-auto border border-line rounded-lg" tabIndex={0} role="region" aria-label={t('onboarding.aria_label_2')}>
          <table className="w-full">
            <thead className="table-head"><tr>{sheet.headers.map((h) => <th key={h} scope="col" className="th">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-line-soft">
              {sheet.rows.slice(0, 5).map((r, i) => (
                <tr key={i}>{sheet.headers.map((h) => <td key={h} className="td text-ink-muted">{cellText(r, h, 60) || '—'}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex justify-between gap-2">
          <button className="btn-secondary" onClick={reset}>{t('onboarding.text_13')}</button>
          <button className="btn-primary" disabled={missingRequired.length > 0} onClick={buildPreview}>
            {t('onboarding.preview')} <ChevronLeft size={ICON.sm} aria-hidden="true" />
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
        <FileSpreadsheet size={ICON.hero} className="text-ink-ghost mx-auto mb-3" aria-hidden="true" />
        <p className="text-sm text-ink-soft mb-4">{t('onboarding.text_14')}</p>
        <button className="btn-primary" onClick={() => fileRef.current?.click()}><Upload size={ICON.sm} aria-hidden="true" /> {t('onboarding.click')}</button>
        <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv"
          onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
      </div>
    </div>
  );
}

function SkippedPanel({ skipped }: { skipped: { row: number; reason: string }[] }) {
  const { t } = useT();
  const groups = groupSkipped(skipped);
  return (
    <Note tone="await">
      <div className="w-full">
        <div className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle size={ICON.sm} aria-hidden="true" /> {skipped.length === 1 ? t('onboarding.oneRowSkipped') : t('onboarding.rowsSkipped', { count: skipped.length })}
        </div>
        <ul className="mt-2 space-y-1 text-xs">
          {groups.map((g) => (
            <li key={g.reason}>
              <b>{g.reason}</b> — {g.rows.length === 1
                ? t('onboarding.rowN', { row: g.rows[0] })
                : t('onboarding.rowList', { count: g.rows.length, rows: g.rows.slice(0, 8).join(', ') + (g.rows.length > 8 ? t('onboarding.andMore', { more: g.rows.length - 8 }) : '') })}
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

const supplierFields = (t: (key: TKey) => string): readonly FieldSpec[] => [
  { key: 'name', label: t('onboarding.fieldSupplierName'), aliases: ['שם הספק', 'ספק', 'supplier', 'name'], required: true },
  { key: 'tax_id', label: t('onboarding.fieldTaxId'), aliases: ['ח.פ / עוסק', 'חפ', 'עוסק', 'tax id', 'vat'] },
  { key: 'contact_name', label: t('onboarding.fieldContact'), aliases: ['איש קשר', 'contact', 'נציג'] },
  { key: 'phone', label: t('onboarding.fieldPhone'), aliases: ['טלפון', 'phone', 'נייד'] },
  { key: 'email', label: t('onboarding.fieldEmail'), aliases: ['אימייל', 'email', 'מייל', 'דואל'] },
  { key: 'address', label: t('onboarding.fieldAddress'), aliases: ['כתובת', 'address', 'עיר'] },
  { key: 'payment_terms', label: t('onboarding.fieldPaymentTerms'), aliases: ['תנאי תשלום', 'payment terms', 'תנאים'] },
  { key: 'min_order_amount', label: t('onboarding.fieldMinOrder'), aliases: ['מינימום הזמנה', 'מינימום', 'min order'] },
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

/**
 * Typing the suppliers in, for the business that has no supplier file to upload.
 *
 * Owner report 28.08.2026: "שתהיה אופציה לבחור שם ספק ולמלא ידנית, ואז המחירים והמוצרים יתעדכנו
 * בהעלאת חשבונית של הספק. כי לא תמיד יש מחירון של ספק. כמו פיופ, עוצמה, גינדי, וכדו'."
 *
 * The step used to accept a spreadsheet and nothing else, so a kitchen whose suppliers are four
 * names and no file had to leave the wizard, build the rows in /suppliers and come back — the same
 * dead end `QuickCreateSupplier` was written for, in a different room. It is reused rather than
 * re-implemented, which also keeps `bank_details` off this surface (DEBT §11 / #106: a supplier
 * created with an attacker's bank details takes no step-up and raises no security event, so the
 * field stays in exactly one form).
 *
 * The sentence under the button is the other half of the owner's ask, and it is a real promise
 * rather than reassurance: a supplier with no price list is not a half-configured supplier, because
 * the document review screen now creates products and seeds prices from the first invoice that
 * arrives from them (`DocumentLineMapping`).
 */
function ManualSuppliers({ onAdded }: { onAdded: (supplier: QuickCreatedSupplier) => void }) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<QuickCreatedSupplier[]>([]);

  return (
    <SubPanel className="p-4">
      <h3 className="text-sm font-medium text-ink">אין קובץ ספקים? אפשר להקליד אותם</h3>
      <p className="mt-1 text-sm text-ink-soft">
        מקלידים שם ספק, וזהו. <b>אין צורך במחירון:</b> בפעם הראשונה שתעלו חשבונית מהספק הזה,
        המוצרים שבה ייווצרו והמחירים שלהם ייקבעו מעצמם.
      </p>
      {added.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {added.map((supplier) => (
            <li key={supplier.id} className="badge-done"><bdi>{supplier.name}</bdi></li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-secondary mt-3" onClick={() => setOpen(true)}>
        <Plus size={ICON.sm} aria-hidden="true" /> הוספת ספק
      </button>
      {open && (
        <QuickCreateSupplier
          onClose={() => setOpen(false)}
          onCreated={(supplier) => {
            setAdded((rows) => (rows.some((row) => row.id === supplier.id) ? rows : [...rows, supplier]));
            setOpen(false);
            onAdded(supplier);
          }}
        />
      )}
    </SubPanel>
  );
}

function SuppliersStep({ onDone }: { onDone: () => void }) {
  const { t } = useT();
  const { profile } = useAuth();
  const existingSupplierKeys = useRef<Set<string>>(new Set());
  /** Bumped by a manual add so the sheet import's duplicate check sees the new name too. */
  const [manualAdds, setManualAdds] = useState(0);

  const { loading, error } = useQuery(async () => {
    const rows = unwrap(await supabase.from('suppliers').select('name').is('deleted_at', null)) as { name: string }[];
    existingSupplierKeys.current = new Set(rows.map((s) => nameKey(s.name)));
    return rows.length;
  }, [manualAdds]);

  const parse: Parser<SupplierDraft> = (rows, cols) => {
    // resolved once per parse so a re-run after fixing the mapping sees the same baseline
    const existing = existingSupplierKeys.current;
    const seen = new Set<string>();
    return mapRows<SupplierDraft>(rows, (r, rowNumber) => {
      const name = cellText(r, cols.name);
      if (!name) return skipRow(t('onboarding.skipRow'));
      const key = nameKey(name);
      if (existing.has(key)) return skipRow(t('onboarding.has_2'));
      if (seen.has(key)) return skipRow(t('onboarding.has_3'));
      seen.add(key);

      const min = cellNumber(r, cols.min_order_amount);
      if (min != null && (min < 0 || min > 10_000_000)) return skipRow(t('onboarding.skipRow_2'));

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
    }, t('importSheet.invalidRow'));
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
        throw new Error(t('onboarding.suppliersImportStopped', { count: inserted, message: res.error.message }));
      }
      inserted += part.length;
    }
    return [t('onboarding.suppliersCreated', { count: inserted })];
  }

  const columns: Column<SupplierDraft>[] = [
    { key: 'name', header: t('onboarding.text_15'), render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'contact', header: t('onboarding.text_16'), render: (r) => r.contact_name ?? '—' },
    { key: 'phone', header: t('onboarding.text_17'), render: (r) => <span dir="ltr">{r.phone ?? '—'}</span> },
    { key: 'email', header: t('onboarding.text_18'), render: (r) => <span dir="ltr">{r.email ?? '—'}</span> },
    { key: 'terms', header: t('onboarding.text_19'), render: (r) => r.payment_terms ?? '—' },
    { key: 'min', header: t('onboarding.toFixed'), className: 'num', render: (r) => (r.min_order_amount != null ? r.min_order_amount.toFixed(2) : '—') },
  ];

  if (loading) return <SkeletonList rows={4} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<Truck size={ICON.md} aria-hidden="true" />}
        title={t('onboarding.title_7')}
        subtitle={t('onboarding.subtitle_5')}
      />
      <ManualSuppliers onAdded={(supplier) => {
        existingSupplierKeys.current.add(nameKey(supplier.name));
        setManualAdds((count) => count + 1);
      }} />
      <SheetImport
        fields={supplierFields(t)}
        parse={parse}
        columns={columns}
        commit={commit}
        confirmMessage={(n) => t('onboarding.suppliersConfirm', { count: n })}
        onDone={onDone}>
        <p className="text-sm text-ink-soft">
          {t('onboarding.onlyRequiredColumn')} <b>{t('onboarding.text_20')}</b>{t('onboarding.allTheRest')}
          {t('onboarding.text_21')}
        </p>
      </SheetImport>
    </div>
  );
}

/* ================= step 4 — products + price list ================= */

const productFields = (t: (key: TKey) => string): readonly FieldSpec[] => [
  { key: 'name', label: t('onboarding.fieldProductName'), aliases: ['שם המוצר', 'מוצר', 'product', 'פריט'], required: true },
  { key: 'category', label: t('onboarding.fieldCategory'), aliases: ['קטגוריה', 'category', 'קבוצה'] },
  { key: 'unit', label: t('onboarding.fieldUnit'), aliases: ['יחידת מידה', 'יחידה', 'unit'] },
  { key: 'sku', label: t('onboarding.fieldSku'), aliases: ['מק״ט', 'sku', 'קטלוגי', 'code'] },
  { key: 'supplier', label: t('onboarding.fieldSupplier'), aliases: ['ספק', 'supplier'] },
  { key: 'price', label: t('onboarding.fieldPrice'), aliases: ['מחיר', 'price', 'עלות'] },
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
  const { errorText, locale, t } = useT();
  const { org } = useAuth();
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
      if (!name) return skipRow(t('onboarding.skipRow_3'));

      const supplier = cellText(r, cols.supplier);
      const pairKey = `${nameKey(name)}|${nameKey(supplier)}`;
      if (seen.has(pairKey)) return skipRow(t('onboarding.has_4'));
      seen.add(pairKey);

      const rawPrice = cellNumber(r, cols.price);
      let price: number | null = rawPrice;
      let priceNote: string | null = null;

      if (rawPrice != null && (rawPrice <= 0 || rawPrice > 1_000_000)) {
        price = null;
        priceNote = t('onboarding.text_22');
      } else if (rawPrice != null && !supplier) {
        price = null;
        priceNote = t('onboarding.text_23');
      } else if (rawPrice != null && !suppliers.has(nameKey(supplier))) {
        price = null;
        priceNote = t('onboarding.text_24');
      }

      const existingProductId = products.get(nameKey(name)) ?? null;
      if (existingProductId && price == null) {
        return skipRow(t('onboarding.skipRow_4'));
      }

      return {
        id: `r${rowNumber}`,
        row: rowNumber,
        name,
        category: cellText(r, cols.category, 80),
        unit: normalizeUnitInput(cellText(r, cols.unit, 40) || t('onboarding.normalizeUnitInput')),
        sku: cellText(r, cols.sku, 60) || null,
        supplier,
        price,
        existingProductId,
        priceNote,
      };
    }, t('importSheet.invalidRow'));
  };

  async function commit(rows: ProductDraft[], reason?: string): Promise<string[]> {
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
      if (res.error) throw new Error(t('onboarding.categoriesCreateFailed', { message: res.error.message }));
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
        unit: normalizeUnitInput(r.unit),
        sku: r.sku,
        active: true,
      }))).select('id, name');
      if (res.error) throw new Error(t('onboarding.productsImportStopped', { count: createdProducts, message: res.error.message }));
      for (const p of (res.data ?? []) as { id: string; name: string }[]) products.set(nameKey(p.name), p.id);
      createdProducts += part.length;
    }

    // 3. price rows — only where a supplier resolved and the price survived validation
    let pricesSet = 0;
    let pricesUnchanged = 0;
    let priceBatchError: string | null = null;
    const priceFailures: number[] = [];
    const priceRows: { supplier_id: string; product_id: string; price: number; available: boolean; sourceRow: number }[] = [];
    for (const r of rows) {
      if (r.price == null) continue;
      const supplierId = suppliers.get(nameKey(r.supplier));
      const productId = r.existingProductId ?? products.get(nameKey(r.name));
      if (!supplierId || !productId) { priceFailures.push(r.row); continue; }
      priceRows.push({ supplier_id: supplierId, product_id: productId, price: r.price, available: true, sourceRow: r.row });
    }

    if (priceRows.length) {
      const imported = await supabase.rpc('import_supplier_prices', {
        p_rows: priceRows.map(({ sourceRow: _sourceRow, ...row }) => row),
        p_effective_date: todayISO(),
        p_reason: reason?.trim() || null,
      });
      if (imported.error) {
        priceFailures.push(...priceRows.map((row) => row.sourceRow));
        priceBatchError = errorText(imported.error);
      } else {
        const result = imported.data as { created: number; updated: number; unchanged: number };
        pricesSet = result.created + result.updated;
        pricesUnchanged = result.unchanged;
      }
    }

    const lines = [t('onboarding.productsCreated', { count: createdProducts })];
    if (newCategoryNames.length) lines.push(t('onboarding.categoriesCreated', { count: newCategoryNames.length }));
    lines.push(pricesSet ? t('onboarding.pricesSet', { count: pricesSet }) : t('onboarding.noPricesSet'));
    if (pricesUnchanged) lines.push(t('onboarding.pricesUnchanged', { count: pricesUnchanged }));
    if (priceFailures.length) {
      lines.push(t('onboarding.pricesFailed', {
        count: priceFailures.length,
        rows: priceFailures.slice(0, 10).join(', ') + (priceFailures.length > 10 ? t('onboarding.andMoreShort') : ''),
      }) + (priceBatchError ? t('onboarding.failureReason', { message: priceBatchError }) : ''));
    }
    return lines;
  }

  const columns: Column<ProductDraft>[] = [
    { key: 'name', header: t('onboarding.text_25'), render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'cat', header: t('onboarding.text_26'), render: (r) => r.category || '—' },
    { key: 'unit', header: t('onboarding.formatUnit'), render: (r) => formatUnit(r.unit, locale) },
    { key: 'sku', header: t('onboarding.text_27'), render: (r) => <span dir="ltr">{r.sku ?? '—'}</span> },
    { key: 'supplier', header: t('onboarding.text_28'), render: (r) => r.supplier || '—' },
    // The imported sheet belongs to one supplier, and its prices are that supplier's own
    // currency. During onboarding no supplier has been created with any other, so this is the
    // organisation's — stated, not assumed away.
    { key: 'price', header: t('onboarding.fmtMoneyExact'), className: 'num', render: (r) => fmtMoneyExact(r.price, org?.base_currency) },
    {
      key: 'note', header: t('onboarding.text_29'),
      render: (r) => {
        if (r.priceNote) return <span className="text-await-fg text-xs">{r.priceNote}</span>;
        if (r.existingProductId) return <span className="text-ink-muted text-xs">{t('onboarding.text_30')}</span>;
        return <span className="text-ink-ghost">—</span>;
      },
    },
  ];

  if (loading) return <SkeletonList rows={4} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<Package size={ICON.md} aria-hidden="true" />}
        title="מוצרים ומחירון"
        subtitle="אותו קובץ יכול להכיל גם את המוצרים וגם מחיר לכל ספק. קטגוריה שאינה קיימת עדיין תיווצר אוטומטית."
      />
      {/* The step is genuinely optional, and until 28.08.2026 nothing here said so — a business
          with no price list read an empty catalogue as a setup it had failed to finish. It is not:
          the document review screen builds products and prices from the first invoice that
          arrives. Placed above the uploader, because it changes whether a person needs it at all. */}
      <Note tone="idle">
        <span className="min-w-0 flex-1">
          אפשר לדלג על השלב הזה. אין חובה במחירון: כשמעלים חשבונית מספק, המוצרים שבה נוצרים
          והמחירים שלהם נקבעים משם. השלב הזה נועד למי שכבר יש לו קובץ מוכן ורוצה להתחיל מלא.
        </span>
      </Note>
      {counts?.suppliers === 0 && (
        <Note tone="await">
          <span className="min-w-0 flex-1">
            {t('onboarding.text_31')}
            {t('onboarding.backToSuppliersOrLater')} <b>{t('onboarding.text_32')}</b>.
          </span>
        </Note>
      )}
      <SheetImport
        fields={productFields(t)}
        parse={parse}
        columns={columns}
        commit={commit}
        requireReason
        confirmMessage={(n) => t('onboarding.productsConfirm', { count: n })}
        onDone={onDone}>
        <p className="text-sm text-ink-soft">
          {t('onboarding.mustMap')} <b>{t('onboarding.text_33')}</b> {t('onboarding.text_34')} <b>{t('onboarding.text_35')}</b> {t('onboarding.text_36')} <b>{t('onboarding.text_37')}</b>{t('onboarding.priceListBuilt')}
          {t('onboarding.text_38')}
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
  /** Records the ending. Resolves `false` when it could not be saved — see `finishSetup`. */
  onFinish: () => Promise<boolean>;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const [finishing, setFinishing] = useState(false);
  const pending = STEPS.filter((s) => s.key !== 'done' && skipped.includes(s.key));

  async function finishAndLeave() {
    setFinishing(true);
    const saved = await onFinish();
    setFinishing(false);
    if (saved) navigate('/dashboard');
  }

  const tiles: { label: string; value: number; to: string }[] = [
    { label: t('onboarding.text_39'), value: counts.categories, to: '/products' },
    { label: t('onboarding.text_40'), value: counts.suppliers, to: '/suppliers' },
    { label: t('onboarding.text_41'), value: counts.products, to: '/products' },
    { label: t('onboarding.text_42'), value: counts.prices, to: '/prices' },
  ];

  return (
    <div className="space-y-5">
      <StepHeading
        icon={<CheckCircle2 size={ICON.md} aria-hidden="true" />}
        title={t('onboarding.title_9')}
        subtitle={t('onboarding.subtitle_7')}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {tiles.map((tile) => (
          <Card as={Link} key={tile.label} to={tile.to} className="card-link-hover">
            <div className="text-xs font-medium text-ink-muted">{tile.label}</div>
            <div className="kpi-value num text-start text-ink mt-1">{tile.value}</div>
          </Card>
        ))}
      </div>

      {pending.length > 0 && (
        <SubPanel>
          <div className="text-sm font-medium text-ink-mid">{t('onboarding.text_43')}</div>
          <div className="flex flex-wrap gap-2 mt-2">
            {pending.map((s) => (
              <button key={s.key} type="button" className="btn-secondary btn-sm"
                onClick={() => onGoToStep(STEPS.findIndex((x) => x.key === s.key))}>
                {t(s.labelKey)}
              </button>
            ))}
          </div>
        </SubPanel>
      )}

      <div className="rounded-lg border border-line px-4 py-3 text-sm text-ink-soft">
        <div className="font-medium text-ink-mid mb-1">{t('onboarding.text_44')}</div>
        <ul className="space-y-1">
          <li>{t('onboarding.text_45')} <Link className="link" to="/settings">{t('onboarding.text_46')}</Link>.</li>
          <li>{t('onboarding.text_47')} <Link className="link" to="/prices">{t('onboarding.text_48')}</Link>.</li>
          <li>{t('onboarding.text_49')} <Link className="link" to="/orders/new">{t('onboarding.text_50')}</Link>.</li>
        </ul>
      </div>

      <div className="flex justify-end">
        <button className="btn-primary" disabled={finishing} onClick={() => { void finishAndLeave(); }}>
          {t('onboarding.enterSystem')}{' '}
          {finishing
            ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" />
            : <ChevronLeft size={ICON.sm} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}
