import { useId, useState } from 'react';
import { Check, X, Loader2, RotateCcw } from 'lucide-react';
import { useT } from '../lib/i18n/LocaleProvider';
import { reasonOr, OPTIONAL_REASON_LABEL_KEY } from '../lib/reason';
import type { MoneyAmount } from '../lib/types';
import { Modal, Note, Disclosure, ReasonField, ICON } from './ui';
import { MoneyByCurrency } from './Money';

/** One thing the action does or explicitly does NOT do. */
export interface ImpactEffect { kind: string; happens: boolean; description: string }
/** Something standing in the way, or something worth knowing before proceeding. */
export interface ImpactBlocker { kind: string; description: string }
/** A field the action rewrites, old beside new. */
export interface ImpactChange { label: string; before: string; after: string }

/**
 * What an action is about to do, as the server describes it.
 *
 * Never assembled in the client. Every field is either read from an impact RPC or is a label the
 * calling screen already had; nothing here is computed from a guess about what the command will do.
 */
export interface ActionImpact {
  actionLabel: string;
  /** What the action applies TO — "all documents from this supplier", not "the selection". */
  scopeLabel: string;
  /** How many records change. `null` is "not measured", and it locks the confirm. */
  affectedCount: number | null;
  entityKinds: readonly { label: string; count: number }[];
  changes: readonly ImpactChange[];
  /** Money the action moves. One line per currency; never summed. */
  amounts?: readonly MoneyAmount[] | null;
  reversible: boolean;
  reversalHint?: string;
  effects: readonly ImpactEffect[];
  /** The server may still refuse, and will say why. Does NOT disable the confirm. */
  warnings: readonly ImpactBlocker[];
  /** Cannot proceed. Disables the confirm and says who can lift it. */
  hardBlockers: readonly ImpactBlocker[];
  requiresStepUp: boolean;
  evidence?: readonly { label: string; to: string }[];
  /** The state the impact was computed against; the command refuses a stale one. */
  assessmentHash?: string;
}

/**
 * The dialog that says what a consequential action will do, before it does it.
 *
 * THE PROBLEM IT REPLACES. `ConfirmDialog` takes a `title` and a `message` — two strings. There is
 * nowhere in it to put the scope, the record count, an old value beside a new one, an amount, or a
 * side effect, so every screen that needed those built its own `Modal` around them and
 * `DocumentRemovalDialog` is the only one that did it completely. This is that shape, generalised.
 *
 * THREE STATES, NOT ONE "BLOCKED". `DESIGN.md:1233-1235` says a client must not refuse what the
 * server would allow — but it was written about approving a DOCUMENT, where the server is the
 * authority and re-checking it is the protection. Generalising it to every action would mean
 * confirming an irreversible one with no idea of its extent, so the type separates:
 *
 *   warnings       the server may still refuse and will explain. Confirm stays LIVE, and a
 *                  sentence says the server checks again. This is the case the quote covers.
 *   hardBlockers   confirm is LOCKED, and the text names who can lift it. Putting a second
 *                  decision-maker in the path is a real cost; a blind confirm on an irreversible
 *                  action is a bigger one.
 *   impactUnknown  `affectedCount === null`. Confirm is LOCKED until a refresh returns a measured
 *                  extent, because consent to an unknown extent is not informed consent. The count
 *                  renders `—`, never `0` — the constitution's rule applies to a dialog too.
 *
 * ONE REASON BOX IN THE WHOLE PATH. The reason is collected HERE and handed onward. `ReauthModal`
 * was built to REPLACE a reason-only dialog, not to stack after one (`ReauthModal.tsx:122-124`),
 * so a caller that needs step-up passes this reason into it rather than asking twice. And there is
 * no second `ConfirmDialog` behind this one: confirming here performs the action.
 *
 * NO `Enter` TO CONFIRM. No dialog in the product has a confirm shortcut today, and adding one
 * here would put a fast path on the most consequential button in the app. `Escape` cancels, which
 * `useDialogLayer` already provides.
 *
 * ZERO CONSUMERS ON PURPOSE. This PR adds the component and nothing calls it, so reverting it is a
 * clean revert. The first adoption (`InvoiceDetail`'s three-way override) is a separate change
 * because it touches a live money screen, and merging the two would have made every rollback both.
 */
export function ImpactDialog({
  open, onClose, onConfirm, impact, busy = false, error, baseCurrency, danger = false, reasonLabel,
}: {
  open: boolean;
  onClose: () => void;
  /** Called once per confirmation with the reason already resolved through `reasonOr`. */
  onConfirm: (reason: string) => void;
  impact: ActionImpact | null;
  busy?: boolean;
  /** A refusal the server already gave, shown in place rather than as a toast that closes this. */
  error?: string | null;
  baseCurrency?: string | null;
  danger?: boolean;
  reasonLabel?: string;
}) {
  const { t } = useT();
  const [reason, setReason] = useState('');
  const listId = useId();

  const impactUnknown = impact != null && impact.affectedCount === null;
  const blocked = impact == null || impact.hardBlockers.length > 0 || impactUnknown;

  /* No `description` on the Modal below: the scope is stated in the list WITH ITS LABEL, and
     passing it here printed the same sentence twice — once unlabelled under the title and once in
     the list. A test caught that; reading the JSX would not have. */
  return (
    <Modal open={open} onClose={onClose} title={impact?.actionLabel ?? t('impact.loading')} wide busy={busy}>
      {impact == null ? (
        /* A skeleton, not a spinner: the dialog's own height is information, and a spinner that
           resolves into a wall of consequences is a jump the reader has to re-read. */
        <div className="space-y-3" aria-busy="true">
          <div className="h-4 w-1/2 animate-pulse rounded bg-surface-sunken" />
          <div className="h-20 animate-pulse rounded bg-surface-sunken" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-surface-sunken" />
        </div>
      ) : (
        <div className="space-y-4">
          {impact.hardBlockers.length > 0 && (
            <Note tone="alert" role="alert">
              <ul className="space-y-1">
                {impact.hardBlockers.map((blocker) => <li key={blocker.kind}>{blocker.description}</li>)}
              </ul>
            </Note>
          )}

          {/* A warning does not take the button away — it says the server will look again. */}
          {impact.hardBlockers.length === 0 && impact.warnings.length > 0 && (
            <Note tone="await">
              <ul className="space-y-1">
                {impact.warnings.map((warning) => <li key={warning.kind}>{warning.description}</li>)}
              </ul>
              <p className="mt-1 text-xs">{t('impact.serverChecksAgain')}</p>
            </Note>
          )}

          <dl className="space-y-1.5 text-sm">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-ink-muted">{t('impact.scope')}</dt>
              <dd className="font-medium text-ink-body">{impact.scopeLabel}</dd>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2">
              <dt className="text-ink-muted">{t('impact.affected')}</dt>
              <dd className="font-medium text-ink-body">
                {/* `—`, never `0`. An unmeasured extent is not an extent of zero. */}
                {impact.affectedCount == null
                  ? <span className="text-ink-ghost">{t('impact.notMeasured')}</span>
                  : <span className="num">{impact.affectedCount}</span>}
                {impact.entityKinds.length > 0 && (
                  <span className="ms-2 text-ink-muted">
                    {impact.entityKinds.map((kind) => `${kind.label} (${kind.count})`).join(' · ')}
                  </span>
                )}
              </dd>
            </div>
            {impact.amounts != null && (
              <div className="flex flex-wrap items-baseline gap-x-2">
                <dt className="text-ink-muted">{t('impact.amount')}</dt>
                {/* Two currencies are two lines. There is no rate in this product and no total. */}
                <dd><MoneyByCurrency amounts={impact.amounts} baseCurrency={baseCurrency} /></dd>
              </div>
            )}
          </dl>

          {impact.changes.length > 0 && (
            <div className="rounded-lg border border-line-soft p-3">
              <h4 className="mb-2 text-xs font-medium text-ink-muted">{t('impact.whatChanges')}</h4>
              <ul className="space-y-1.5 text-sm">
                {impact.changes.map((change) => (
                  <li key={change.label} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-ink-muted">{change.label}</span>
                    <span className="text-ink-ghost line-through">{change.before}</span>
                    <span aria-hidden="true" className="text-ink-ghost">←</span>
                    <span className="font-medium text-ink-body">{change.after}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* What will NOT happen is the most useful line to read before approving, and it is the
              half a summary always drops (`DESIGN.md:1226-1228`). Both kinds render, and they are
              told apart by an icon and by text — not by colour alone. */}
          {impact.effects.length > 0 && (
            <ul id={listId} className="space-y-1.5 text-sm">
              {impact.effects.map((effect) => (
                <li key={effect.kind} className="flex items-start gap-2">
                  {effect.happens
                    ? <Check size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0 text-done-fg" />
                    : <X size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-ghost" />}
                  <span className={effect.happens ? 'text-ink-body' : 'text-ink-muted'}>
                    <span className="sr-only">
                      {effect.happens ? t('impact.willHappen') : t('impact.willNotHappen')}{' '}
                    </span>
                    {effect.description}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <p className="flex items-start gap-2 text-sm text-ink-muted">
            <RotateCcw size={ICON.sm} aria-hidden="true" className="mt-0.5 shrink-0" />
            <span>{impact.reversible ? (impact.reversalHint ?? t('impact.reversible')) : t('impact.irreversible')}</span>
          </p>

          {impact.evidence && impact.evidence.length > 0 && (
            <Disclosure title={t('impact.evidence')}>
              <ul className="space-y-1 text-sm">
                {impact.evidence.map((item) => (
                  <li key={item.to}><a className="link" href={item.to}>{item.label}</a></li>
                ))}
              </ul>
            </Disclosure>
          )}

          {/* Collected once, for the whole path — including the step-up that may follow. */}
          <ReasonField label={reasonLabel ?? t(OPTIONAL_REASON_LABEL_KEY)} value={reason} onChange={setReason} />

          {impactUnknown && (
            <Note tone="await">{t('impact.unknownExtent')}</Note>
          )}
          {error && <Note tone="alert" role="alert">{error}</Note>}
        </div>
      )}

      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className="btn-secondary min-h-11" disabled={busy} onClick={onClose}>
          {t('impact.cancel')}
        </button>
        <button type="button" className={`min-h-11 ${danger ? 'btn-danger' : 'btn-primary'}`}
          disabled={busy || blocked}
          onClick={() => onConfirm(reasonOr(reason, impact?.actionLabel ?? ''))}>
          {busy
            ? <><Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /><span>{t('impact.working')}</span></>
            : (impact?.actionLabel ?? t('impact.confirm'))}
        </button>
      </div>
    </Modal>
  );
}
