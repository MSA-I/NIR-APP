import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Search, Loader2, X, Truck, Package, FileText, ClipboardList, CreditCard, RotateCcw, FilePen, type LucideIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ICON, StatusBadge, useDialogLayer } from './ui';
import { SUPPLIER_STATUS, PO_STATUS, INVOICE_PAYMENT_STATUS, CREDIT_STATUS, type StatusMeta } from '../lib/status';
import { fmtMoneyExact } from '../lib/format';
import { isActiveRole, type ActiveRole, type Role, type SearchHit, type SearchEntity as EntityType } from '../lib/types';
import { useAuth } from '../auth/AuthContext';
import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';

// SearchHit / SearchEntity now live in lib/types (imported above as EntityType).

// Two-row map to fold into status.ts alongside SUPPLIER_STATUS. Products carry no status
// column of their own — active/inactive is the boolean `active`, so this needs a home. The
// LABEL is product-specific (not shared with supplier "active"), but the semantic TONE is
// borrowed from the matching supplier status so it tracks whatever section 6's Tone vocabulary
// lands on rather than hardcoding a literal that its in-flight rewrite may rename again.
const PRODUCT_STATUS: Record<string, StatusMeta> = {
  active: { key: 'supplier_active', tone: SUPPLIER_STATUS.active.tone },
  inactive: { key: 'supplier_inactive', tone: SUPPLIER_STATUS.inactive.tone },
};

// --- Per-role display order (NO LONGER THE GATE) ---------------------------------------
//
// Since migration 0069 the reachable result TYPES are decided on the server, from `auth_role()`,
// mirroring the App.tsx route guards. Retired roles are blocked before this component can mount.
//
// So what this map still is: the **display order and the group set** for the role in front of us —
// `GROUP_ORDER` and the group headings need it, and the placeholder hint below is built from it.
// The client-side `.filter()` in the search effect is kept as defence in depth because it costs
// one pass over at most 30 rows; it is no longer the thing that makes the gate true, and it must
// not be described as one. Nobody who could already see everything sees anything different.
//
// RLS still decides which ROWS exist. That never moved.
const ALLOWED: Record<ActiveRole, EntityType[]> = {
  owner:      ['supplier', 'product', 'invoice', 'order', 'draft', 'payment', 'credit'],
  office:     ['supplier', 'product', 'invoice', 'order', 'draft', 'credit'],
  accountant: ['invoice', 'payment', 'credit'],                                // approved invoices are enforced by RLS
};

/** Whether to render a search box for an active role. Layout uses it too. */
export function canGlobalSearch(role: Role | undefined): boolean {
  return isActiveRole(role) && ALLOWED[role].length > 0;
}

interface GroupMeta { labelKey: TKey; icon: LucideIcon }
const GROUPS: Record<EntityType, GroupMeta> = {
  supplier: { labelKey: 'globalSearch.groupSuppliers', icon: Truck },
  product:  { labelKey: 'globalSearch.groupProducts', icon: Package },
  invoice:  { labelKey: 'globalSearch.groupInvoices', icon: FileText },
  order:    { labelKey: 'globalSearch.groupOrders', icon: ClipboardList },
  draft:    { labelKey: 'globalSearch.groupDrafts', icon: FilePen },
  payment:  { labelKey: 'globalSearch.groupPayments', icon: CreditCard },
  credit:   { labelKey: 'globalSearch.groupCredits', icon: RotateCcw },
};
const GROUP_ORDER: EntityType[] = ['supplier', 'product', 'invoice', 'order', 'draft', 'payment', 'credit'];

function targetFor(hit: SearchHit): string {
  switch (hit.entity) {
    case 'supplier': return `/suppliers/${hit.id}`;
    case 'invoice':  return `/invoices/${hit.id}`;
    case 'order':    return `/orders/${hit.id}`;
    // A draft resumes only for its creator; the server fences the hit to created_by (0145).
    case 'draft':    return `/orders/new?draft=${hit.id}`;
    // The price comparison, not the edit modal (18.08.2026): someone searching a product is
    // asking "who sells it and for how much" far more often than "let me rename it". The edit
    // path stays one click away — the comparison header links back to /products?id=.
    case 'product':  return `/prices?product=${hit.id}`;
    case 'payment':  return `/payments?id=${hit.id}`;
    case 'credit':   return `/credits?id=${hit.id}`;
  }
}

function metaFor(hit: SearchHit): StatusMeta | undefined {
  if (hit.status == null) return undefined; // payment → no status column → no badge
  switch (hit.entity) {
    case 'supplier': return SUPPLIER_STATUS[hit.status];
    case 'product':  return PRODUCT_STATUS[hit.status];
    case 'invoice':  return INVOICE_PAYMENT_STATUS[hit.status];
    case 'order':    return PO_STATUS[hit.status];
    case 'draft':    return PO_STATUS[hit.status]; // server emits 'draft' — the PO vocabulary's own word
    case 'credit':   return CREDIT_STATUS[hit.status];
    default:         return undefined;
  }
}

// Numbers (invoice numbers, #order/#payment/#credit) read wrong under RTL — pin them LTR,
// matching Invoices.tsx:64 / Credits.tsx:34.
const LTR_TITLE: Record<EntityType, boolean> = {
  supplier: false, product: false, invoice: true, order: true, draft: true, payment: true, credit: true,
};

export default function GlobalSearch({ variant = 'desktop', onClose }: {
  variant?: 'desktop' | 'mobile';
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useT();
  const { profile } = useAuth();
  const allowed = useMemo(() => (profile && isActiveRole(profile.role) ? ALLOWED[profile.role] : []), [profile]);

  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);
  const listboxId = useId();
  const { panelRef, requestClose: closeMobileSearch } = useDialogLayer<HTMLDivElement>({
    open: variant === 'mobile',
    onClose: () => onClose?.(),
    initialFocus: () => inputRef.current,
  });

  const q = term.trim();
  const hasTerm = q.length >= 2;

  // Debounce 200ms + race guard. Bumping seq on every term change (before the timeout even
  // fires) means any in-flight response from an older term is discarded when it resolves —
  // debounce alone cannot stop a slow old answer from overwriting a fast new one.
  useEffect(() => {
    const seq = ++seqRef.current;
    if (q.length < 2) { setHits(null); setLoading(false); setSearchFailed(false); return; }
    setSearchFailed(false);
    setLoading(true);
    const timer = setTimeout(async () => {
      const { data, error } = await supabase.rpc('global_search', { q, per_type: 5 });
      if (seq !== seqRef.current) return; // superseded — drop this response
      if (error) { setHits(null); setSearchFailed(true); setLoading(false); return; }
      // Defence in depth over at most 30 rows, not the gate: 0069 decides the reachable types
      // server-side. See the ALLOWED comment above.
      const rows = ((data ?? []) as SearchHit[]).filter((h) => allowed.includes(h.entity));
      setHits(rows);
      setLoading(false);
      setActiveIndex(-1);
    }, 200);
    return () => clearTimeout(timer);
  }, [q, allowed]);

  // Visual grouping (spec order), linear keyboard navigation over the flattened list.
  const renderGroups = useMemo(() => {
    if (!hits) return [];
    let i = 0;
    return GROUP_ORDER
      .map((entity) => ({ entity, meta: GROUPS[entity], items: hits.filter((h) => h.entity === entity) }))
      .filter((g) => g.items.length > 0)
      .map((g) => ({ ...g, items: g.items.map((hit) => ({ hit, index: i++ })) }));
  }, [hits]);
  const flat = useMemo(() => renderGroups.flatMap((g) => g.items.map((x) => x.hit)), [renderGroups]);

  // Ctrl/Cmd+K — e.code, never e.key: the physical K key emits 'ל' under a Hebrew layout, so
  // e.key === 'k' would never fire for this all-Hebrew system's users. preventDefault stops
  // Firefox binding Ctrl+K to its own search bar.
  useEffect(() => {
    if (variant !== 'desktop') return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') { e.preventDefault(); inputRef.current?.focus(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [variant]);

  // Mobile overlay opens focused.
  useEffect(() => { if (variant === 'mobile') inputRef.current?.focus(); }, [variant]);

  // Keep the active option in view.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${listboxId}-opt-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, listboxId]);

  function open(hit: SearchHit) {
    navigate(targetFor(hit));
    setTerm(''); setHits(null); setActiveIndex(-1);
    if (variant === 'mobile') onClose?.();
    else inputRef.current?.blur();
  }

  // Vertical-only nav (no Left/Right — they flip under RTL and buy nothing here), wrapping at
  // both ends. Enter opens the active row, or the first if none is active.
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length) setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setActiveIndex((i) => (i <= 0 ? flat.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      const hit = flat[activeIndex] ?? flat[0];
      if (hit) { e.preventDefault(); open(hit); }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (variant === 'mobile') { e.stopPropagation(); closeMobileSearch(); }
      else if (term) setTerm('');
      else inputRef.current?.blur();
    }
  }

  const panelOpen = variant === 'mobile' || focused;
  const liveMsg = hasTerm && hits
    ? t(hits.length === 1 ? 'globalSearch.resultsFoundOne' : 'globalSearch.resultsFoundMany', { count: hits.length })
    : '';
  const hintLabels = allowed.map((entity) => t(GROUPS[entity].labelKey)).join(' · ');

  const field = (
    <div className="relative w-full">
      <Search size={ICON.sm} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint pointer-events-none" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        spellCheck={false}
        className="input ps-9! pe-9!"
        placeholder={t('globalSearch.placeholder')}
        role="combobox"
        aria-expanded={panelOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
        aria-label={t('globalSearch.aria_label')}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {loading && (
        <span role="status" className="absolute top-1/2 -translate-y-1/2 end-3 text-ink-faint">
          <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />
          <span className="sr-only">{t('globalSearch.text')}</span>
        </span>
      )}
    </div>
  );

  const panelBody = searchFailed ? (
    <div role="alert" className="px-3 py-6 text-center text-sm text-alert-fg">{t('globalSearch.setHits')}</div>
  ) : !hasTerm ? (
    <div className="px-3 py-3 text-xs text-ink-faint">{t('globalSearch.searchHint', { groups: hintLabels })}</div>
  ) : loading && !hits ? null : hits && hits.length === 0 ? (
    <div className="px-3 py-6 text-center text-sm text-ink-muted">{t('globalSearch.noResultsFor', { query: q })}</div>
  ) : (
    <ul id={listboxId} role="listbox" aria-label={t('globalSearch.aria_label_2')} className="py-1">
      {renderGroups.map((g) => {
        const Icon = g.meta.icon;
        return (
          <li key={g.entity} role="group" aria-label={t(g.meta.labelKey)}>
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs font-semibold text-ink-muted">
              <Icon size={ICON.xs} aria-hidden="true" /> {t(g.meta.labelKey)}
            </div>
            <ul role="presentation">
              {g.items.map(({ hit, index }) => (
                <li
                  key={hit.id}
                  id={`${listboxId}-opt-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseDown={(e) => { e.preventDefault(); open(hit); }}
                  onMouseEnter={() => setActiveIndex(index)}
                  // aria-selected and the eye must agree. The active option used to wear the very
                  // class the other rows show on hover, so "what Enter will open" and "what the
                  // pointer is over" were the same pixel — with a keyboard, indistinguishable.
                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${index === activeIndex ? 'bg-surface-selected' : 'hover:bg-surface-hover'}`}
                >
                  <Icon size={ICON.sm} className="shrink-0 text-ink-faint" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-body truncate" dir={LTR_TITLE[hit.entity] ? 'ltr' : undefined}>{hit.title}</div>
                    {hit.subtitle && <div className="text-xs text-ink-muted truncate">{hit.subtitle}</div>}
                  </div>
                  {/* The trailing block is ONE unit, not two loose siblings. A result row is
                      media · (title + subtitle) · trailing, and the status badge had no `shrink-0`
                      of its own — so in the narrow panel it was the flex item that gave way, and
                      "ממתין לאישור" arrived as a squeezed chip beside a money figure that had
                      protected itself. Grouping them also stops the badge and the amount drifting
                      apart as the row widens: they end together, against the row's END edge. */}
                  <span className="flex shrink-0 items-center justify-end gap-2">
                    <StatusBadge meta={metaFor(hit)} />
                    {hit.amount != null && <span className="num text-sm text-ink-mid">{fmtMoneyExact(hit.amount)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );

  if (variant === 'mobile') {
    return (
      <div id="mobile-global-search" ref={panelRef} role="dialog" aria-modal="true" aria-label={t('globalSearch.aria_label_3')} tabIndex={-1}
        className="phone-safe-dialog lg:hidden fixed inset-0 z-50 bg-surface flex flex-col focus:outline-none">
        <div className="flex items-center gap-2 border-b border-line p-3">
          {field}
          <button type="button" className="btn-ghost btn-icon rounded-full" onClick={() => closeMobileSearch()} aria-label={t('globalSearch.aria_label_4')}><X size={ICON.lg} aria-hidden="true" /></button>
        </div>
        <div className="flex-1 overflow-y-auto">{panelBody}</div>
        <div aria-live="polite" className="sr-only">{liveMsg}</div>
      </div>
    );
  }

  return (
    <div className="relative w-full max-w-xl">
      {field}
      {panelOpen && (
        /* THE PANEL IS NOT THE TRIGGER'S WIDTH. `inset-x-0` tied it to whatever box the shell put
           the field in — 176px in the desktop header — while every row inside packs an icon, a
           title, a subtitle, a status badge and a money figure. So the results of a search were
           rendered into a column narrower than one result. The trigger stays compact (it is
           competing for space in a navigation row); the panel anchors its inline-END to the
           field's and grows toward the page, never narrower than the field itself. */
        <div className="absolute end-0 top-full mt-1 w-[26rem] min-w-full card shadow-menu max-h-[70vh] overflow-y-auto">
          {panelBody}
        </div>
      )}
      <div aria-live="polite" className="sr-only">{liveMsg}</div>
    </div>
  );
}
