import { useT } from '../lib/i18n/LocaleProvider';
import { useCallback, useEffect, useId, useState } from 'react';
import { Loader2, Plug, Plus, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  Card, ConfirmDialog, EmptyState, ErrorNote, ICON, Modal, Note, PageHeader, SkeletonList, useToast,
} from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDateTime } from '../lib/format';
import type { TKey } from '../lib/i18n/t.ts';
import {
  MIN_WEBHOOK_SECRET_LENGTH,
  WEBHOOK_EVENT_CHOICES,
  readWebhookSubscriptions,
  registerWebhookSubscription,
  requestWebhookVerification,
  runWebhookVerification,
  setWebhookSubscriptionActive,
  webhookErrorRefusal,
  webhookHealth,
  webhookSecretRejection,
  webhookUrlRejection,
  type WebhookSubscription,
} from '../lib/webhooks';

/**
 * Owner-only webhook management (#98 / #253).
 *
 * Three things this screen deliberately does NOT do, each of which would be the easy version.
 *
 * 1. **It does not decide anything.** Every refusal it renders is a refusal the server already
 *    makes: role, step-up, reason, URL class, verification-before-activation. The client checks
 *    exist so an owner learns while typing instead of after a round trip, and the screen is
 *    written so that removing them would change latency, not permissions.
 *
 * 2. **It never shows a delivery error.** #98 is explicit. An upstream response body can carry a
 *    supplier name, an amount, or an internal hostname — the same scrubbing class as Sentry
 *    breadcrumbs (#99). The owner gets the last successful delivery, the pending count, the
 *    failed-attempt count and the dead-letter count. That is enough to act: retry is automatic,
 *    and what a human decides from this screen is whether to leave the connection on.
 *
 * 3. **It never shows the signing secret.** It is written into Vault by the command and there is
 *    no read path back — not for this screen, not for support. An owner who loses it registers a
 *    new connection.
 *
 * The activation control is absent, not disabled, until the handshake completes: a disabled
 * button invites the owner to hunt for the permission they are missing, when the actual next
 * step is a different action entirely.
 */

interface RegistrationDraft {
  url: string;
  eventTypes: string[];
  secret: string;
  description: string;
  reason: string;
}

const VERIFICATION_TONE: Record<WebhookSubscription['verification_state'], string> = {
  verified: 'badge-done',
  pending: 'badge-await',
  unverified: 'badge-idle',
};

/**
 * A refusal in the reader's own language.
 *
 * The translator is a PARAMETER rather than a hook call, because two of the three call sites sit
 * inside `useCallback`s whose dependency lists are load-bearing: a helper recreated on every render
 * would re-run the effect that owns the first read. `webhookErrorRefusal` has already decided
 * WHICH refusal this is and stripped the server's own words; this only chooses the sentence.
 */
const refusalText = (
  t: (key: TKey, vars?: Record<string, string | number>) => string,
  raw: unknown,
): string => {
  const refusal = webhookErrorRefusal(raw);
  return t(refusal.key, refusal.vars);
};

const VERIFICATION_LABEL_KEYS: Record<WebhookSubscription['verification_state'], TKey> = {
  verified: 'webhookSettings.verificationVerified',
  pending: 'webhookSettings.verificationPending',
  unverified: 'webhookSettings.verificationUnverified',
};

export default function WebhookSettings() {
  const { t } = useT();
  const toast = useToast();
  const [rows, setRows] = useState<WebhookSubscription[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [draft, setDraft] = useState<RegistrationDraft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [pendingRegister, setPendingRegister] = useState<RegistrationDraft | null>(null);

  const [verifying, setVerifying] = useState<WebhookSubscription | null>(null);
  const [pendingVerify, setPendingVerify] = useState<{ id: string; reason: string } | null>(null);

  const [toggling, setToggling] = useState<{ row: WebhookSubscription; next: boolean } | null>(null);
  const [pendingToggle, setPendingToggle] =
    useState<{ id: string; next: boolean; reason: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await readWebhookSubscriptions());
      setLoadError(null);
    } catch (error) {
      // webhookErrorMessage, not toHebrewError: a load failure here can be a Postgres string
      // naming an internal relation, and this screen is the one place that must never print one.
      setLoadError(refusalText(t, error));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<string>): Promise<void> {
    setBusy(true);
    try {
      toast(await action(), 'success');
      await load();
    } catch (error) {
      toast(refusalText(t, error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function submitDraft(): void {
    if (!draft) return;
    const rejection = webhookUrlRejection(draft.url) ?? webhookSecretRejection(draft.secret);
    if (rejection) {
      setDraftError(refusalText(t, rejection));
      return;
    }
    setDraftError(null);
    setPendingRegister(draft);
    setDraft(null);
  }

  if (rows === null && !loadError) return <SkeletonList rows={2} />;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('webhookSettings.title')}
        description={t('webhookSettings.description')}
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => void load()}>
              <RefreshCw size={ICON.sm} aria-hidden="true" /> {t('webhookSettings.refresh')}
            </button>
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => { setDraftError(null); setDraft({ url: '', eventTypes: [], secret: '', description: '', reason: '' }); }}>
              <Plus size={ICON.sm} aria-hidden="true" /> {t('webhookSettings.newConnection')}
            </button>
          </div>
        }
      />

      {loadError && <ErrorNote message={loadError} />}

      {rows && rows.length === 0 && !loadError && (
        <EmptyState
          icon={<Plug size={ICON.hero} />}
          title={t('webhookSettings.title_2')}
          subtitle={t('webhookSettings.subtitle')}
        />
      )}

      <div className="space-y-3">
        {(rows ?? []).map((row) => (
          <SubscriptionCard
            key={row.id}
            row={row}
            busy={busy}
            onVerify={() => setVerifying(row)}
            onToggle={(next) => setToggling({ row, next })}
          />
        ))}
      </div>

      {/* Naming what this screen cannot tell you belongs on the screen. An owner who reads the
          counts as a full picture would stop looking at the integration log. */}
      {rows && rows.length > 0 && (
        <p className="text-xs text-ink-muted leading-relaxed">
          {t('webhookSettings.deliveryDisclosure')}
        </p>
      )}

      {draft && (
        <RegistrationModal
          draft={draft}
          error={draftError}
          busy={busy}
          onChange={setDraft}
          onClose={() => { setDraft(null); setDraftError(null); }}
          onSubmit={submitDraft}
        />
      )}

      <ReauthModal
        open={!!pendingRegister}
        title={t('webhookSettings.title_3')}
        onConfirm={() => {
          const input = pendingRegister;
          setPendingRegister(null);
          if (!input) return;
          void run(async () => {
            await registerWebhookSubscription({
              url: input.url.trim(),
              eventTypes: input.eventTypes,
              secret: input.secret,
              description: input.description.trim() || null,
              reason: input.reason.trim() || t('webhookSettings.trim'),
            });
            return t('webhookSettings.text_4');
          });
        }}
        onCancel={() => setPendingRegister(null)}
      />

      <ConfirmDialog
        open={!!verifying}
        busy={busy}
        requireReason
        reasonLabel={t('webhookSettings.reasonLabel')}
        title={t('webhookSettings.title_4')}
        message={t('webhookSettings.message')}
        confirmLabel={t('webhookSettings.confirmLabel')}
        onClose={() => setVerifying(null)}
        onConfirm={(reason) => {
          if (verifying) setPendingVerify({ id: verifying.id, reason: reason ?? '' });
          setVerifying(null);
        }}
      />

      <ReauthModal
        open={!!pendingVerify}
        title={t('webhookSettings.title_5')}
        onConfirm={() => {
          const request = pendingVerify;
          setPendingVerify(null);
          if (!request) return;
          void run(async () => {
            const authorized = await requestWebhookVerification(
              request.id, request.reason.trim() || t('webhookSettings.trim_2'));
            const outcome = await runWebhookVerification(authorized.verification_id);
            if (!outcome.verified) throw new Error(outcome.code);
            return t('webhookSettings.text_5');
          });
        }}
        onCancel={() => setPendingVerify(null)}
      />

      <ConfirmDialog
        open={!!toggling}
        busy={busy}
        requireReason
        danger={toggling?.next === false}
        reasonLabel={t('webhookSettings.reasonLabel_2')}
        title={toggling?.next ? t('webhookSettings.text_6') : t('webhookSettings.text_7')}
        message={toggling?.next
          ? t('webhookSettings.text_8')
          : t('webhookSettings.text_9')}
        confirmLabel={toggling?.next ? t('webhookSettings.text_10') : t('webhookSettings.text_11')}
        onClose={() => setToggling(null)}
        onConfirm={(reason) => {
          if (toggling) {
            setPendingToggle({ id: toggling.row.id, next: toggling.next, reason: reason ?? '' });
          }
          setToggling(null);
        }}
      />

      <ReauthModal
        open={!!pendingToggle}
        title={t('webhookSettings.title_6')}
        onConfirm={() => {
          const request = pendingToggle;
          setPendingToggle(null);
          if (!request) return;
          void run(async () => {
            await setWebhookSubscriptionActive(
              request.id,
              request.next,
              request.reason.trim() || (request.next ? t('webhookSettings.trim_3') : t('webhookSettings.trim_4')),
            );
            return request.next ? t('webhookSettings.text_12') : t('webhookSettings.text_13');
          });
        }}
        onCancel={() => setPendingToggle(null)}
      />
    </div>
  );
}

function SubscriptionCard({ row, busy, onVerify, onToggle }: {
  row: WebhookSubscription;
  busy: boolean;
  onVerify: () => void;
  onToggle: (next: boolean) => void;
}) {
  const { t } = useT();
  const health = webhookHealth(row);
  const verified = row.verification_state === 'verified';
  const events = row.event_types.length === 0
    ? [t('webhookSettings.text_14')]
    : row.event_types.map(
        (type) => {
          const choice = WEBHOOK_EVENT_CHOICES.find((option) => option.value === type);
          return choice ? t(choice.labelKey) : type;
        });

  return (
    <Card className="space-y-3" as="article" aria-label={row.url}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink break-all" dir="ltr">{row.url}</p>
          {row.description && <p className="mt-0.5 text-xs text-ink-muted">{row.description}</p>}
        </div>
        <span className={row.active ? 'badge-done' : 'badge-idle'}>
          {row.active ? t('webhookSettings.text_15') : t('webhookSettings.text_16')}
        </span>
        <span className={VERIFICATION_TONE[row.verification_state]}>
          {t(VERIFICATION_LABEL_KEYS[row.verification_state])}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {events.map((label) => (
          <span key={label} className="badge-info">{label}</span>
        ))}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Metric label={t('webhookSettings.label')} value={health.lastSuccess} testId="webhook-last-success" />
        <Metric label={t('webhookSettings.label_2')} value={health.pending} testId="webhook-pending" />
        <Metric label={t('webhookSettings.label_3')} value={health.failed} testId="webhook-failed" />
        <Metric label={t('webhookSettings.label_4')} value={health.deadLettered} testId="webhook-dead-letter" />
      </dl>

      {!verified && (
        <Note tone="idle">
          <ShieldAlert size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {t('webhookSettings.provePossession')}
            {row.verification_state === 'pending' && row.verification_expires_at
              ? ` ${t('webhookSettings.verificationOpenUntil', { date: fmtDateTime(row.verification_expires_at) })}`
              : ''}
          </span>
        </Note>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onVerify}>
          {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <ShieldCheck size={ICON.sm} aria-hidden="true" />}
          {t('webhookSettings.text_19')}
        </button>
        {/* Absent, not disabled, while unverified: the missing thing is a different action, and a
            greyed-out button would send the owner looking for a permission problem instead. */}
        {verified && !row.active && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => onToggle(true)}>
            {t('webhookSettings.text_20')}
          </button>
        )}
        {row.active && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => onToggle(false)}>
            {t('webhookSettings.text_21')}
          </button>
        )}
      </div>
    </Card>
  );
}

function Metric({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd data-testid={testId} className={value === '—' ? 'text-sm text-ink-muted' : 'text-sm text-ink num'}>
        {value}
      </dd>
    </div>
  );
}

function RegistrationModal({ draft, error, busy, onChange, onClose, onSubmit }: {
  draft: RegistrationDraft;
  error: string | null;
  busy: boolean;
  onChange: (next: RegistrationDraft) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const { t } = useT();
  const urlId = useId();
  const secretId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const problemId = useId();
  // The same two checks `submitDraft` runs, evaluated live so the FIELD carries its own validity
  // instead of one shared banner standing over four boxes with nothing tying it to any of them.
  // Only a typed value is judged: an untouched field is not a mistake yet.
  const urlProblem = draft.url.trim().length > 0 && webhookUrlRejection(draft.url) !== null;
  const secretProblem = draft.secret.length > 0 && webhookSecretRejection(draft.secret) !== null;

  function toggleEvent(value: string): void {
    const next = draft.eventTypes.includes(value)
      ? draft.eventTypes.filter((type) => type !== value)
      : [...draft.eventTypes, value];
    onChange({ ...draft, eventTypes: next });
  }

  return (
    <Modal open onClose={onClose} title={t('webhookSettings.title_7')} wide busy={busy}
      description={t('webhookSettings.description_2')}>
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <div>
          <label className="label" htmlFor={urlId}>{t('webhookSettings.text_22')}</label>
          <input id={urlId} className="input" dir="ltr" inputMode="url" autoComplete="off"
            aria-invalid={urlProblem || undefined}
            aria-describedby={`${urlId}-rule${error ? ` ${problemId}` : ''}`}
            value={draft.url} onChange={(event) => onChange({ ...draft, url: event.target.value })} />
          <p id={`${urlId}-rule`} className={`mt-1 text-xs ${urlProblem ? 'text-alert-fg' : 'text-ink-muted'}`}>
            {t('webhookSettings.text_23')}
          </p>
        </div>

        <fieldset>
          <legend className="label">{t('webhookSettings.text_24')}</legend>
          <p className="mb-2 text-xs text-ink-muted">
            {t('webhookSettings.text_25')}
          </p>
          {/* NOT ToggleGroup: this is multi-select — every event type toggles on its own, and
              ToggleGroup models „pick one of N". What it did share with the fifteen hand-rolled
              copies was the real bug, and that is fixed here: `chip-filter-active` is a MODIFIER.
              The base rule is where min-h-11, the radius, the padding and the focus ring live, so
              swapping it out left the SELECTED chip with no height floor and no focus ring. */}
          <div className="flex flex-wrap gap-2">
            {WEBHOOK_EVENT_CHOICES.map((choice) => {
              const on = draft.eventTypes.includes(choice.value);
              return (
                <button key={choice.value} type="button" aria-pressed={on}
                  className={`chip-filter ${on ? 'chip-filter-active' : ''}`}
                  onClick={() => toggleEvent(choice.value)}>
                  {t(choice.labelKey)}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor={secretId}>{t('webhookSettings.text_26')}</label>
          {/* type=password and autoComplete=new-password: the value is written straight into the
              secrets store and there is no read path back, so a browser that remembers it would
              be the only copy anyone could recover — and not one we control. */}
          <input id={secretId} className="input" type="password" dir="ltr" autoComplete="new-password"
            aria-invalid={secretProblem || undefined}
            aria-describedby={`${secretId}-rule${error ? ` ${problemId}` : ''}`}
            value={draft.secret} onChange={(event) => onChange({ ...draft, secret: event.target.value })} />
          <p id={`${secretId}-rule`} className={`mt-1 text-xs ${secretProblem ? 'text-alert-fg' : 'text-ink-muted'}`}>
            {t('webhookSettings.secretRule', { min: MIN_WEBHOOK_SECRET_LENGTH })}
          </p>
        </div>

        <div>
          <label className="label" htmlFor={descriptionId}>{t('webhookSettings.text_28')}</label>
          <input id={descriptionId} className="input" value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })} />
        </div>

        <div>
          <label className="label" htmlFor={reasonId}>{t('webhookSettings.text_29')}</label>
          <textarea id={reasonId} className="input" rows={2} maxLength={1000} value={draft.reason}
            onChange={(event) => onChange({ ...draft, reason: event.target.value })} />
        </div>

        {error && <div id={problemId}><ErrorNote message={error} /></div>}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>{t('webhookSettings.text_30')}</button>
          <button type="submit" className="btn-primary" disabled={busy}>{t('webhookSettings.text_31')}</button>
        </div>
      </form>
    </Modal>
  );
}
