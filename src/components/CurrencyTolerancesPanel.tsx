/**
 * The screen `#288` promised and nobody built.
 *
 * The decision said a used currency with no configured tolerance is "shown in settings as needing a
 * decision — and does not get an invented one". The database honoured both halves from the day it
 * shipped: `private.money_tolerance` returns null and every caller respects it. The settings screen
 * honoured neither, because it did not exist: four tolerance keys reached production with one field
 * between them, and that field edited a bare shekel number labelled `₪`.
 *
 * WHAT THIS SCREEN IS NOT. It is not a currency converter and it holds no exchange rate (`#290`).
 * Each number here is typed by the owner, for one currency, and means only what it says in that
 * currency. The owner may well pick it by thinking "what is a shekel worth in dollars" — that is a
 * thought, not a stored rate, and nothing in this product derives one number from another.
 *
 * WHY FOUR FIELDS AND NOT ONE (`#291`). The four tolerances are not the same size and must not be
 * collapsed into one. Three of them are "about one unit"; the invoice LINE tolerance is small
 * change — five agorot in shekels. One number for all four would loosen the line check twentyfold,
 * which is a change to how carefully the product reads an invoice, wearing the costume of a
 * simplification.
 *
 * WHY AN EMPTY FIELD IS NOT A ZERO. Empty means "never stated", and the server treats it as
 * "cannot compare". Zero means "nothing may differ at all" — a real and much stricter instruction.
 * The constitution's rule about `—` rather than `0` is the same rule: an absence is not a value.
 */
import { useMemo, useState } from 'react';
import { Coins, Plus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { currencyMinorUnits, fmtMoneyExact } from '../lib/format';
import { derivedTolerance, storedTolerance, writeTolerance, type ToleranceSetting } from '../lib/tolerances';
import { sortByBaseCurrency } from './Money';
import { Card, SubPanel, Note, ErrorNote, Skeleton, ICON, useToast } from './ui';
import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import type { Organization } from '../lib/types';

/**
 * The four keys, their Hebrew names, and the sentence that says what each one actually compares.
 *
 * This list is the one `scripts/check-tolerance-surfaces.mjs` enforces: a fifth key that reaches
 * `private.money_tolerance` and is not here fails the guard, so the defect this file exists to fix
 * cannot happen a second time quietly.
 */
const TOLERANCE_KEYS = [
  {
    key: 'bank_match_amount_tolerance',
    labelKey: 'tolerances.keyBankMatch',
    hintKey: 'tolerances.keyBankMatchHint',
  },
  {
    key: 'payment_request_amount_tolerance',
    labelKey: 'tolerances.keyPaymentRequest',
    hintKey: 'tolerances.keyPaymentRequestHint',
  },
  {
    key: 'invoice_line_amount_tolerance',
    labelKey: 'tolerances.keyInvoiceLine',
    hintKey: 'tolerances.keyInvoiceLineHint',
  },
  {
    key: 'invoice_document_amount_tolerance',
    labelKey: 'tolerances.keyInvoiceTotal',
    hintKey: 'tolerances.keyInvoiceTotalHint',
  },
] as const;

type ToleranceKey = (typeof TOLERANCE_KEYS)[number]['key'];

/** What the currency list calls each place a currency was seen, in the manager's words. */
const SOURCE_LABEL: Record<string, TKey> = {
  base_currency: 'tolerances.sourceBaseCurrency',
  supplier_default: 'tolerances.sourceSupplierDefault',
  invoice: 'tolerances.sourceInvoice',
  payment: 'tolerances.sourcePayment',
  payment_request: 'tolerances.sourcePaymentRequest',
  credit_request: 'tolerances.sourceCreditRequest',
  purchase_order: 'tolerances.sourcePurchaseOrder',
  purchase_request: 'tolerances.sourcePurchaseRequest',
  bank_import: 'tolerances.sourceBankImport',
  supplier_product: 'tolerances.sourceSupplierProduct',
  price_history: 'tolerances.sourcePriceHistory',
  approval_threshold: 'tolerances.sourceApprovalThreshold',
};

interface CurrencyInUse { currency: string; sources: string[] }

/** `key:CURRENCY` — the identity of one editable field. */
const fieldId = (key: ToleranceKey, currency: string) => `${key}:${currency}`;

export function CurrencyTolerancesPanel({ org, canWrite }: {
  org: Organization | null | undefined;
  canWrite: boolean;
}) {
  const { t } = useT();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, loading, error } = useQuery(async () => {
    const inUse = unwrap(await supabase.rpc('currencies_in_use')) as CurrencyInUse[] | null;
    const catalogue = unwrap(await supabase.from('currencies').select('code').eq('active', true).order('code'));
    return { inUse: inUse ?? [], catalogue: (catalogue ?? []) as { code: string }[] };
  }, []);

  const settings = org?.settings;

  /* The currencies this business has handled (#292) plus any the owner added ahead of the first
     document. Base currency first, then ISO — the same order Money.tsx uses, so a balance and its
     tolerance are never listed in two different orders on two screens. */
  const currencies = useMemo(() => {
    const seen = new Map<string, string[]>();
    for (const row of data?.inUse ?? []) seen.set(row.currency, row.sources);
    for (const code of added) if (!seen.has(code)) seen.set(code, []);
    return sortByBaseCurrency([...seen].map(([currency, sources]) => ({ currency, sources })), org?.base_currency);
  }, [data?.inUse, added, org?.base_currency]);

  /* `draft` holds ONLY what the owner has typed. Everything else is read straight from the stored
     settings at render time.

     The first version mirrored the stored values into `draft` in an effect and merged the two. That
     is a copy of the server's answer that has to be kept in step with it, and it was not: the fields
     mount as soon as the currency list arrives, which is not the same moment the organisation row
     is in hand, so a field could paint empty and stay empty while a value sat on the server. A
     value that exists and is not shown is worse on this screen than on any other — the whole point
     of it is to say which values are missing. */
  const shown = (key: ToleranceKey, currency: string): string => {
    const typed = draft[fieldId(key, currency)];
    if (typed !== undefined) return typed;
    return storedTolerance(settings?.[key] as ToleranceSetting | undefined, currency)?.toString() ?? '';
  };

  async function save() {
    if (!org) return;
    setBusy(true);
    const next: Record<string, unknown> = { ...(org.settings ?? {}) };

    for (const { key } of TOLERANCE_KEYS) {
      let value = org.settings?.[key] as ToleranceSetting | undefined;
      for (const { currency } of currencies) {
        const raw = shown(key, currency).trim();
        // An empty field clears the value back to "never stated". It does not write a zero, and it
        // does not leave the previous number in place — both would be the screen deciding
        // something the owner did not.
        value = writeTolerance(value, currency, raw === '' ? null : Number(raw));
      }
      if (value === undefined) delete next[key];
      else next[key] = value;
    }

    const res = await supabase.from('organizations').update({ settings: next }).eq('id', org.id);
    setBusy(false);
    if (res.error) { toast(t('tolerances.saveFailed'), 'error'); return; }
    // The server honours the new value from the next request; the cached organisation in
    // AuthContext is what waits for the next sign-in, exactly as the card above this one says.
    toast(t('tolerances.saved'));
  }

  /* Currencies this platform cannot describe, which are the only ones with nothing to compare
     against. Before #294 this counted every empty FIELD, so a brand-new shekel business was told
     three values "needed a decision" while the server was answering all three perfectly well —
     a demand for manual work that did not exist. */
  const active = new Set((data?.catalogue ?? []).map((row) => row.code));
  const unanswerable = currencies
    .filter(({ currency }) => !active.has(currency)
      || derivedTolerance('bank_match_amount_tolerance', currency) == null)
    .map(({ currency }) => currency);

  const addable = (data?.catalogue ?? [])
    .map((row) => row.code)
    .filter((code) => !currencies.some((row) => row.currency === code));

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="section-title flex items-center gap-2">
          <Coins size={ICON.md} aria-hidden="true" /> {t('tolerances.title')}
        </h2>
        <p className="text-sm text-ink-muted mt-1">
          {t('tolerances.intro')}
        </p>
      </div>

      {/* Bones, not a second live region. /settings already announces its own loading through the
          users query, and two  regions on one page read as two separate
          announcements to a screen reader for what is one page still arriving. */}
      {loading && (
        <div className="space-y-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {error && <ErrorNote message={error} />}

      {!loading && !error && (
        <>
          {unanswerable.length > 0 && (
            <Note tone="await">
              <span>
                {t('tolerances.unanswerable', { currencies: unanswerable.join(', ') })}
              </span>
            </Note>
          )}

          {currencies.map(({ currency, sources }) => {
            const minor = currencyMinorUnits(currency);
            return (
              <SubPanel key={currency} className="space-y-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-semibold num">{currency}</span>
                  {currency === org?.base_currency && <span className="badge-idle">{t('tolerances.baseCurrencyBadge')}</span>}
                  <span className="text-xs text-ink-muted">
                    {sources.length === 0
                      ? t('tolerances.addedAhead')
                      : sources.map((s) => (SOURCE_LABEL[s] ? t(SOURCE_LABEL[s]) : s)).join(' · ')}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {TOLERANCE_KEYS.map(({ key, labelKey, hintKey }) => {
                    const id = `tolerance-${key}-${currency}`;
                    const empty = shown(key, currency).trim() === '';
                    /* The placeholder carries the value ACTUALLY IN FORCE, so an empty box reads as
                       "the automatic answer applies" rather than "nobody has decided". That
                       distinction is the whole of #294 on this screen. */
                    const automatic = derivedTolerance(key, currency);
                    return (
                      <div key={key}>
                        <label className="label" htmlFor={id}>{t('tolerances.fieldLabel', { label: t(labelKey), currency })}</label>
                        <input
                          id={id}
                          type="number"
                          min="0"
                          // The smallest amount this currency can express. A five-agorot tolerance
                          // has no meaning in a currency with no minor unit at all.
                          step={minor == null ? '0.01' : (10 ** -minor).toFixed(Math.max(minor, 0))}
                          className="input num"
                          placeholder={automatic == null ? t('tolerances.needsSetting') : fmtMoneyExact(automatic, currency)}
                          disabled={!canWrite}
                          value={shown(key, currency)}
                          onChange={(e) => setDraft((d) => ({ ...d, [fieldId(key, currency)]: e.target.value }))}
                        />
                        <p className="text-xs text-ink-muted mt-1">
                          {!empty ? t('tolerances.hintManual', { hint: t(hintKey) })
                            : automatic == null ? t('tolerances.hintNoAutomatic', { hint: t(hintKey) })
                            : t('tolerances.hintAutomatic', { hint: t(hintKey) })}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </SubPanel>
            );
          })}

          {canWrite && addable.length > 0 && (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="label" htmlFor="tolerance-add-currency">{t('tolerances.addCurrencyLabel')}</label>
                <select id="tolerance-add-currency" className="input w-auto!" value={adding}
                  onChange={(e) => setAdding(e.target.value)}>
                  <option value="">{t('tolerances.chooseCurrency')}</option>
                  {addable.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
              </div>
              <button className="btn-secondary" disabled={!adding}
                onClick={() => { if (adding) { setAdded((a) => [...a, adding]); setAdding(''); } }}>
                <Plus size={ICON.sm} aria-hidden="true" /> {t('tolerances.addAction')}
              </button>
              <p className="basis-full text-xs text-ink-muted">
                {t('tolerances.addHint')}
              </p>
            </div>
          )}

          {canWrite && (
            <div className="flex justify-end">
              <button className="btn-primary" disabled={busy} onClick={() => void save()}>{t('tolerances.saveAction')}</button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
