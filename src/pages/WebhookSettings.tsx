import { useCallback, useEffect, useId, useState } from 'react';
import { Loader2, Plug, Plus, RefreshCw, ShieldCheck, ShieldAlert } from 'lucide-react';
import {
  ConfirmDialog, EmptyState, ErrorNote, Modal, Note, PageHeader, SkeletonList, useToast,
} from '../components/ui';
import { ReauthModal } from '../components/ReauthModal';
import { fmtDateTime } from '../lib/format';
import {
  MIN_WEBHOOK_SECRET_LENGTH,
  WEBHOOK_EVENT_CHOICES,
  readWebhookSubscriptions,
  registerWebhookSubscription,
  requestWebhookVerification,
  runWebhookVerification,
  setWebhookSubscriptionActive,
  webhookErrorMessage,
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

const VERIFICATION_LABEL: Record<WebhookSubscription['verification_state'], string> = {
  verified: 'נקודת הקצה אומתה',
  pending: 'אימות ממתין',
  unverified: 'טרם אומת',
};

export default function WebhookSettings() {
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
      setLoadError(webhookErrorMessage(error));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<string>): Promise<void> {
    setBusy(true);
    try {
      toast(await action(), 'success');
      await load();
    } catch (error) {
      toast(webhookErrorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  function submitDraft(): void {
    if (!draft) return;
    const rejection = webhookUrlRejection(draft.url) ?? webhookSecretRejection(draft.secret);
    if (rejection) {
      setDraftError(webhookErrorMessage(rejection));
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
        title="חיבורי webhook"
        description="שליחה אוטומטית של אירועים עסקיים לנקודת קצה שלך. כל חיבור נחתם, נשלח לפחות פעם אחת, וניתן לכבות אותו בכל רגע."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" disabled={busy}
              onClick={() => void load()}>
              <RefreshCw size={15} /> רענון
            </button>
            <button type="button" className="btn-primary" disabled={busy}
              onClick={() => { setDraftError(null); setDraft({ url: '', eventTypes: [], secret: '', description: '', reason: '' }); }}>
              <Plus size={15} /> חיבור חדש
            </button>
          </div>
        }
      />

      {loadError && <ErrorNote message={loadError} />}

      {rows && rows.length === 0 && !loadError && (
        <EmptyState
          icon={<Plug size={20} />}
          title="אין עדיין חיבורי webhook"
          subtitle="אפשר לרשום נקודת קצה HTTPS, לבחור אילו אירועים יישלחו אליה, ולאמת אותה לפני ההפעלה."
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
          המסך מציג מסירה מוצלחת אחרונה וספירות בלבד. תוכן שגיאה מצד נקודת הקצה אינו מוצג כאן
          במכוון, כדי שלא יגיע לדפדפן טקסט שרת גולמי. סוד החתימה נשמר במאגר סודות ואינו ניתן לקריאה
          חוזרת — אם אבד, יש לרשום חיבור חדש.
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
        title="אימות זהות לרישום חיבור"
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
              reason: input.reason.trim() || 'רישום חיבור webhook',
            });
            return 'החיבור נרשם. הוא כבוי עד לאימות נקודת הקצה.';
          });
        }}
        onCancel={() => setPendingRegister(null)}
      />

      <ConfirmDialog
        open={!!verifying}
        busy={busy}
        requireReason
        reasonLabel="סיבת הפעולה"
        title="אימות נקודת הקצה"
        message="המערכת תשלח לנקודת הקצה בקשה חתומה אחת. כדי לעבור את האימות, על נקודת הקצה להחזיר סטטוס 2xx ואת כותרת x-inplace-webhook-challenge עם הערך שהתקבל בגוף הבקשה."
        confirmLabel="שליחת אימות"
        onClose={() => setVerifying(null)}
        onConfirm={(reason) => {
          if (verifying) setPendingVerify({ id: verifying.id, reason: reason ?? '' });
          setVerifying(null);
        }}
      />

      <ReauthModal
        open={!!pendingVerify}
        title="אימות זהות לשליחת אימות"
        onConfirm={() => {
          const request = pendingVerify;
          setPendingVerify(null);
          if (!request) return;
          void run(async () => {
            const authorized = await requestWebhookVerification(
              request.id, request.reason.trim() || 'אימות נקודת קצה');
            const outcome = await runWebhookVerification(authorized.verification_id);
            if (!outcome.verified) throw new Error(outcome.code);
            return 'נקודת הקצה אומתה. אפשר להפעיל את החיבור.';
          });
        }}
        onCancel={() => setPendingVerify(null)}
      />

      <ConfirmDialog
        open={!!toggling}
        busy={busy}
        requireReason
        danger={toggling?.next === false}
        reasonLabel="סיבת הפעולה"
        title={toggling?.next ? 'הפעלת החיבור' : 'כיבוי החיבור'}
        message={toggling?.next
          ? 'מרגע ההפעלה יישלחו אירועים עסקיים של העסק לכתובת שנרשמה. הפעולה נרשמת ביומן האבטחה עם הסיבה.'
          : 'הכיבוי מפסיק מיד שליחת אירועים חדשים. אירועים שכבר בתור יסתיימו או יגיעו למכתב מת.'}
        confirmLabel={toggling?.next ? 'הפעלת החיבור' : 'כיבוי החיבור'}
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
        title="אימות זהות לשינוי מצב החיבור"
        onConfirm={() => {
          const request = pendingToggle;
          setPendingToggle(null);
          if (!request) return;
          void run(async () => {
            await setWebhookSubscriptionActive(
              request.id,
              request.next,
              request.reason.trim() || (request.next ? 'הפעלת חיבור webhook' : 'כיבוי חיבור webhook'),
            );
            return request.next ? 'החיבור הופעל.' : 'החיבור כובה.';
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
  const health = webhookHealth(row);
  const verified = row.verification_state === 'verified';
  const events = row.event_types.length === 0
    ? ['כל סוגי האירועים']
    : row.event_types.map(
        (type) => WEBHOOK_EVENT_CHOICES.find((choice) => choice.value === type)?.label ?? type);

  return (
    <article aria-label={row.url} className="card card-pad space-y-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink break-all" dir="ltr">{row.url}</p>
          {row.description && <p className="mt-0.5 text-xs text-ink-muted">{row.description}</p>}
        </div>
        <span className={row.active ? 'badge-done' : 'badge-idle'}>
          {row.active ? 'פעיל' : 'כבוי'}
        </span>
        <span className={VERIFICATION_TONE[row.verification_state]}>
          {VERIFICATION_LABEL[row.verification_state]}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {events.map((label) => (
          <span key={label} className="badge-info">{label}</span>
        ))}
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Metric label="מסירה מוצלחת אחרונה" value={health.lastSuccess} testId="webhook-last-success" />
        <Metric label="ממתינות למסירה" value={health.pending} testId="webhook-pending" />
        <Metric label="ניסיונות שנכשלו" value={health.failed} testId="webhook-failed" />
        <Metric label="הועברו למכתב מת" value={health.deadLettered} testId="webhook-dead-letter" />
      </dl>

      {!verified && (
        <Note tone="idle">
          <ShieldAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            לפני הפעלה יש להוכיח בעלות על נקודת הקצה. המערכת תשלח אליה בקשה חתומה אחת, ועליה
            להחזיר את קוד האימות שקיבלה.
            {row.verification_state === 'pending' && row.verification_expires_at
              ? ` בקשת אימות פתוחה בתוקף עד ${fmtDateTime(row.verification_expires_at)}.`
              : ''}
          </span>
        </Note>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-secondary" disabled={busy} onClick={onVerify}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <ShieldCheck size={15} />}
          אימות נקודת הקצה
        </button>
        {/* Absent, not disabled, while unverified: the missing thing is a different action, and a
            greyed-out button would send the owner looking for a permission problem instead. */}
        {verified && !row.active && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => onToggle(true)}>
            הפעלה
          </button>
        )}
        {row.active && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => onToggle(false)}>
            כיבוי
          </button>
        )}
      </div>
    </article>
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
  const urlId = useId();
  const secretId = useId();
  const descriptionId = useId();
  const reasonId = useId();

  function toggleEvent(value: string): void {
    const next = draft.eventTypes.includes(value)
      ? draft.eventTypes.filter((type) => type !== value)
      : [...draft.eventTypes, value];
    onChange({ ...draft, eventTypes: next });
  }

  return (
    <Modal open onClose={onClose} title="חיבור webhook חדש" wide busy={busy}
      description="החיבור נוצר כבוי. לאחר אימות נקודת הקצה אפשר יהיה להפעיל אותו.">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <div>
          <label className="label" htmlFor={urlId}>כתובת נקודת הקצה (HTTPS) *</label>
          <input id={urlId} className="input" dir="ltr" inputMode="url" autoComplete="off"
            value={draft.url} onChange={(event) => onChange({ ...draft, url: event.target.value })} />
          <p className="mt-1 text-xs text-ink-muted">
            רק HTTPS על פורט 443, שם דומיין ציבורי, בלי שם משתמש או סיסמה בכתובת.
          </p>
        </div>

        <fieldset>
          <legend className="label">סוגי אירועים</legend>
          <p className="mb-2 text-xs text-ink-muted">
            בלי בחירה יישלחו כל סוגי האירועים. בחירה מצמצמת את מה שיוצא מהעסק — עדיף לבחור.
          </p>
          <div className="flex flex-wrap gap-1">
            {WEBHOOK_EVENT_CHOICES.map((choice) => {
              const on = draft.eventTypes.includes(choice.value);
              return (
                <button key={choice.value} type="button" aria-pressed={on}
                  className={on ? 'chip-filter-active' : 'chip-filter'}
                  onClick={() => toggleEvent(choice.value)}>
                  {choice.label}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div>
          <label className="label" htmlFor={secretId}>סוד חתימה *</label>
          {/* type=password and autoComplete=new-password: the value is written straight into the
              secrets store and there is no read path back, so a browser that remembers it would
              be the only copy anyone could recover — and not one we control. */}
          <input id={secretId} className="input" type="password" dir="ltr" autoComplete="new-password"
            value={draft.secret} onChange={(event) => onChange({ ...draft, secret: event.target.value })} />
          <p className="mt-1 text-xs text-ink-muted">
            לפחות {MIN_WEBHOOK_SECRET_LENGTH} תווים. הסוד נשמר במאגר סודות ואינו ניתן לקריאה חוזרת —
            יש לשמור עותק אצלך, איתו מאמתים את חתימת ההודעות.
          </p>
        </div>

        <div>
          <label className="label" htmlFor={descriptionId}>תיאור</label>
          <input id={descriptionId} className="input" value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })} />
        </div>

        <div>
          <label className="label" htmlFor={reasonId}>סיבת הפעולה</label>
          <textarea id={reasonId} className="input" rows={2} maxLength={1000} value={draft.reason}
            onChange={(event) => onChange({ ...draft, reason: event.target.value })} />
        </div>

        {error && <ErrorNote message={error} />}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onClose}>ביטול</button>
          <button type="submit" className="btn-primary" disabled={busy}>שמירת החיבור</button>
        </div>
      </form>
    </Modal>
  );
}
