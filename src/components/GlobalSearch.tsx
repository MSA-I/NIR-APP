import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Loader2, X, Truck, Package, FileText, ClipboardList, CreditCard, RotateCcw, type LucideIcon } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { StatusBadge, useDialogLayer } from './ui';
import { SUPPLIER_STATUS, PO_STATUS, INVOICE_PAYMENT_STATUS, CREDIT_STATUS, type StatusMeta } from '../lib/status';
import { fmtMoneyExact } from '../lib/format';
import type { Role, SearchHit, SearchEntity as EntityType } from '../lib/types';
import { useAuth } from '../auth/AuthContext';

// SearchHit / SearchEntity now live in lib/types (imported above as EntityType).

// Two-row map to fold into status.ts alongside SUPPLIER_STATUS. Products carry no status
// column of their own — active/inactive is the boolean `active`, so this needs a home. The
// LABEL is product-specific (not shared with supplier "active"), but the semantic TONE is
// borrowed from the matching supplier status so it tracks whatever section 6's Tone vocabulary
// lands on rather than hardcoding a literal that its in-flight rewrite may rename again.
const PRODUCT_STATUS: Record<string, StatusMeta> = {
  active: { label: 'פעיל', tone: SUPPLIER_STATUS.active.tone },
  inactive: { label: 'לא פעיל', tone: SUPPLIER_STATUS.inactive.tone },
};

// --- Per-role result gating ------------------------------------------------------------
// RLS decides which ROWS exist; this table decides which result TYPES are reachable, because
// the App.tsx route guards are stricter than RLS (e.g. RLS lets an accountant read products,
// but /products is STAFF-only, so a product hit would just bounce them). Order matches spec 5.
// payer/supplier have no reachable target at all → no search box (see canGlobalSearch).
const ALLOWED: Record<Role, EntityType[]> = {
  owner:      ['supplier', 'product', 'invoice', 'order', 'payment', 'credit'],
  office:     ['supplier', 'product', 'invoice', 'order', 'payment', 'credit'],
  kitchen:    ['supplier', 'product', 'invoice', 'order', 'credit'],            // no /payments
  accountant: ['supplier', 'invoice', 'order', 'payment', 'credit'],            // no /products
  payer:      [],
  supplier:   [],
};

/** Whether to render a search box for this role at all. Layout uses it too. */
export function canGlobalSearch(role: Role | undefined): boolean {
  return !!role && ALLOWED[role].length > 0;
}

interface GroupMeta { label: string; icon: LucideIcon }
const GROUPS: Record<EntityType, GroupMeta> = {
  supplier: { label: 'ספקים', icon: Truck },
  product:  { label: 'מוצרים', icon: Package },
  invoice:  { label: 'חשבוניות', icon: FileText },
  order:    { label: 'הזמנות', icon: ClipboardList },
  payment:  { label: 'תשלומים', icon: CreditCard },
  credit:   { label: 'זיכויים', icon: RotateCcw },
};
const GROUP_ORDER: EntityType[] = ['supplier', 'product', 'invoice', 'order', 'payment', 'credit'];

function targetFor(hit: SearchHit): string {
  switch (hit.entity) {
    case 'supplier': return `/suppliers/${hit.id}`;
    case 'invoice':  return `/invoices/${hit.id}`;
    case 'order':    return `/orders/${hit.id}`;
    case 'product':  return `/products?id=${hit.id}`;
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
    case 'credit':   return CREDIT_STATUS[hit.status];
    default:         return undefined;
  }
}

// Numbers (invoice numbers, #order/#payment/#credit) read wrong under RTL — pin them LTR,
// matching Invoices.tsx:64 / Credits.tsx:34.
const LTR_TITLE: Record<EntityType, boolean> = {
  supplier: false, product: false, invoice: true, order: true, payment: true, credit: true,
};

export default function GlobalSearch({ variant = 'desktop', onClose }: {
  variant?: 'desktop' | 'mobile';
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const { profile } = useAuth();
  const allowed = useMemo(() => (profile ? ALLOWED[profile.role] : []), [profile]);

  const [term, setTerm] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');
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
    if (q.length < 2) { setHits(null); setLoading(false); setSearchError(''); return; }
    setSearchError('');
    setLoading(true);
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('global_search', { q, per_type: 5 });
      if (seq !== seqRef.current) return; // superseded — drop this response
      if (error) { setHits(null); setSearchError('החיפוש נכשל — נסה שוב'); setLoading(false); return; }
      const rows = ((data ?? []) as SearchHit[]).filter((h) => allowed.includes(h.entity));
      setHits(rows);
      setLoading(false);
      setActiveIndex(-1);
    }, 200);
    return () => clearTimeout(t);
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
  const liveMsg = hasTerm && hits ? `נמצאו ${hits.length} תוצאות` : '';
  const hintLabels = allowed.map((e) => GROUPS[e].label).join(' · ');

  const field = (
    <div className="relative w-full">
      <Search size={16} className="absolute top-1/2 -translate-y-1/2 start-3 text-ink-faint pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        spellCheck={false}
        className="input ps-9! pe-9!"
        placeholder="חיפוש ספקים, חשבוניות, הזמנות..."
        role="combobox"
        aria-expanded={panelOpen}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
        aria-label="חיפוש כללי"
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {loading && (
        <span role="status" className="absolute top-1/2 -translate-y-1/2 end-3 text-ink-faint">
          <Loader2 size={15} className="animate-spin" aria-hidden="true" />
          <span className="sr-only">מחפש</span>
        </span>
      )}
    </div>
  );

  const panelBody = searchError ? (
    <div role="alert" className="px-3 py-6 text-center text-sm text-alert-fg">{searchError}</div>
  ) : !hasTerm ? (
    <div className="px-3 py-3 text-xs text-ink-faint">חיפוש {hintLabels}</div>
  ) : loading && !hits ? null : hits && hits.length === 0 ? (
    <div className="px-3 py-6 text-center text-sm text-ink-muted">לא נמצאו תוצאות עבור «{q}»</div>
  ) : (
    <ul id={listboxId} role="listbox" aria-label="תוצאות חיפוש" className="py-1">
      {renderGroups.map((g) => {
        const Icon = g.meta.icon;
        return (
          <li key={g.entity} role="group" aria-label={g.meta.label}>
            <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] font-semibold text-ink-muted">
              <Icon size={13} /> {g.meta.label}
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
                  className={`flex items-center gap-3 px-3 py-2 cursor-pointer ${index === activeIndex ? 'bg-action-wash' : 'hover:bg-surface-sunken'}`}
                >
                  <Icon size={15} className="shrink-0 text-ink-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink-body truncate" dir={LTR_TITLE[hit.entity] ? 'ltr' : undefined}>{hit.title}</div>
                    {hit.subtitle && <div className="text-xs text-ink-muted truncate">{hit.subtitle}</div>}
                  </div>
                  <StatusBadge meta={metaFor(hit)} />
                  {hit.amount != null && <span className="num text-sm text-ink-mid shrink-0">{fmtMoneyExact(hit.amount)}</span>}
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
      <div id="mobile-global-search" ref={panelRef} role="dialog" aria-modal="true" aria-label="חיפוש כללי" tabIndex={-1}
        className="phone-safe-dialog lg:hidden fixed inset-0 z-50 bg-surface flex flex-col focus:outline-none">
        <div className="flex items-center gap-2 border-b border-line p-3">
          {field}
          <button className="btn-ghost p-2!" onClick={() => closeMobileSearch()} aria-label="סגירה"><X size={20} /></button>
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
        <div className="absolute top-full inset-x-0 mt-1 card shadow-menu max-h-[70vh] overflow-y-auto">
          {panelBody}
        </div>
      )}
      <div aria-live="polite" className="sr-only">{liveMsg}</div>
    </div>
  );
}
