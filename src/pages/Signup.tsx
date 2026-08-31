import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { useAuth, homeFor } from '../auth/AuthContext';
import { Building2, MailCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Card, ErrorNote, ICON, Note } from '../components/ui';
import {
  backupEmailRequirementEnforced,
  enabledFederatedProviders,
  FEDERATED_PROVIDER_LABEL,
  FEDERATED_PROVIDERS,
  startFederatedSignup,
  type FederatedProvider,
} from '../lib/authProviders';
import {
  backupEmailProblem,
  backupEmailRequired,
  type BackupEmailProblem,
} from '../lib/backupEmail';

const MIN_PASSWORD_LENGTH = 10;

/** The one shape check on the address, named once so `ready` and the field's own validity state
 *  cannot drift apart — the screen already made this judgement, it simply never told the field. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isFederatedProvider(value: unknown): value is FederatedProvider {
  return typeof value === 'string' && (FEDERATED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The hint under the backup-address field, per refusal. `missing` maps to nothing on purpose: an
 * untouched field is not a mistake yet, exactly as the primary address and password already work
 * on this screen — the greyed-out button is what says the form is not finished.
 */
const BACKUP_EMAIL_HINT: Record<BackupEmailProblem, 'signup.backupEmailMalformed'
  | 'signup.backupEmailTooLong' | 'signup.backupEmailSameAsPrimary'
  | 'signup.backupEmailStillRelay' | null> = {
  missing: null,
  malformed: 'signup.backupEmailMalformed',
  too_long: 'signup.backupEmailTooLong',
  same_as_primary: 'signup.backupEmailSameAsPrimary',
  still_a_relay: 'signup.backupEmailStillRelay',
};

/**
 * Self-service signup (0159) — the screen that reversed OPEN-DECISIONS #12.
 *
 * It asks for four things and nothing else. There is no plan picker, no VAT field and no
 * category list, because none of those are the visitor's to choose: the database sets the
 * starting plan, and a form that could ask for Business would be a free upgrade. Sending them
 * would change nothing either — the Edge Function reads exactly these four keys.
 */
/**
 * Signing up with a federated identity FINISHES here (OPEN-DECISIONS #265, amended 25.08.2026):
 * this screen creates an ORGANIZATION, and the person who creates one is its owner. An employee
 * arrives through an invitation and a password, and `0205` makes the invitation command refuse a
 * federated caller by name — so the rule holds even if someone calls the API directly.
 *
 * The login screen may now START the hand-off, because a business owner opening an account often
 * looks for the door there first. It changes nothing about who ends up with standing: the provider
 * returns the browser to THIS screen, and a business still has to be named before anything exists.
 *
 * Which providers are drawn, and where the browser comes back to, live in `lib/authProviders.ts`
 * so that this screen and the login screen cannot disagree.
 */

export default function Signup() {
  const { t } = useT();
  const [form, setForm] = useState({
    organization: '', name: '', email: '', password: '', backupEmail: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when the SERVER said a backup address is required and this screen had not asked for one.
   *
   * The requirement is read from a build-time switch on both sides, so the two can disagree for
   * exactly as long as one deploy is ahead of the other. Without this the disagreement is a dead
   * end: the visitor is refused for a field the form never showed them, with no way to comply.
   * With it, the cost of a skew is one extra step instead of a signup nobody can complete —
   * which is the same "an unmeasured answer is not a refusal" instinct `DEBT §79` applies to the
   * entitlement question, pointed at the other side of the same request.
   */
  const [serverAskedForBackup, setServerAskedForBackup] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendResult, setResendResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** Set when a provider sent the browser back here with a session but no organization yet. */
  const [federated, setFederated] = useState<{ provider: FederatedProvider; email: string } | null>(
    null,
  );
  const providers = enabledFederatedProviders();
  const { session, profile, loading } = useAuth();

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user;
      // `app_metadata` is written by the auth server. `user_metadata` is self-asserted and is
      // never what decides which branch runs — the Edge function re-reads this server-side too.
      if (cancelled || !user) return;
      const provider = user.app_metadata?.provider;
      if (!isFederatedProvider(provider)) return;
      // Apple hands over the address on the first authorization and, for a Private Relay account,
      // hands over a forwarding one. Either way it is the only address this session proves, so it
      // is what gets shown — never a value the person could have typed.
      setFederated({ provider, email: user.email ?? '' });
      const suggested = typeof user.user_metadata?.full_name === 'string'
        ? user.user_metadata.full_name
        : '';
      setForm((previous) => ({
        ...previous,
        name: previous.name || suggested,
        email: user.email ?? previous.email,
      }));
    });
    return () => { cancelled = true; };
  }, []);

  /**
   * A returning federated identity lands HERE, not on the login screen: `redirectTo` is
   * {origin}/signup for both entrances, because on the first visit this is the only screen that can
   * finish the job. On the second visit it is the wrong screen entirely — without this guard the
   * person is asked to name a business they already have, and `public-signup` refuses with
   * `identity_already_has_organization` after they fill the form. The server was right and the
   * screen was a dead end; this is the same redirect `Login.tsx` has always had.
   *
   * Below the hooks, because a redirect must not skip them. Gated on `!loading` so the frame where
   * the profile has not resolved yet does not read as "no tenant".
   */
  if (!loading && session && profile) return <Navigate to={homeFor(profile.role)} replace />;

  async function continueWith(provider: FederatedProvider) {
    setError(null);
    const { error: failure } = await startFederatedSignup(provider);
    if (failure) {
      setError(t('signup.federatedUnavailable', { provider: FEDERATED_PROVIDER_LABEL[provider] }));
    }
  }

  /**
   * The Edge function's own answer, when it sent one, plus the single code this screen ACTS on.
   *
   * `backup_email_required` means the server is asking for a field the form did not draw — the two
   * build-time switches are out of step. Drawing it here turns a dead end into one more step.
   */
  async function applyFailure(failure: unknown, fallback: string) {
    const context = (failure as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      try {
        const payload = await context.json() as { error?: { code?: string; message?: string } };
        if (payload?.error?.code === 'backup_email_required') setServerAskedForBackup(true);
        if (payload?.error?.message) { setError(payload.error.message); return; }
      } catch {
        // no JSON body — fall through to the transport message
      }
    }
    setError(fallback);
  }

  /** The federated branch: the provider proved the address, so only the business name is missing. */
  async function finishFederatedSignup(provider: FederatedProvider) {
    setBusy(true);
    setError(null);
    const backup = form.backupEmail.trim();
    const { data, error: failure } = await supabase.functions.invoke<{ message?: string }>(
      'public-signup',
      {
        body: {
          identity: provider,
          organization_name: form.organization.trim(),
          full_name: form.name.trim(),
          // Present only when there is one to send. A relay signup with enforcement off nominates
          // nothing, and the request stays the three keys it has always been.
          ...(backup ? { backup_email: backup } : {}),
        },
      },
    );
    setBusy(false);
    if (failure) {
      await applyFailure(failure, t('signup.setError'));
      return;
    }
    // The account is confirmed and signed in already, so there is nothing to wait for.
    window.location.replace('/');
    void data;
  }

  // Typed-but-wrong, not merely empty: an untouched field is not a mistake yet, and marking it
  // invalid before anyone has typed would announce a failure the visitor has not made.
  const emailProblem = form.email.trim().length > 0 && !EMAIL_SHAPE.test(form.email.trim());
  const passwordProblem = form.password.length > 0 && form.password.length < MIN_PASSWORD_LENGTH;

  /**
   * The address this signup will actually be keyed by — the provider's when one signed us in, and
   * only otherwise the one being typed. A federated session has no password fields at all, so
   * reading `form.email` here would ask an Apple owner about an address they never entered.
   */
  const primaryEmail = federated ? federated.email : form.email.trim();
  const askBackupEmail = serverAskedForBackup
    || backupEmailRequired(primaryEmail, { enforced: backupEmailRequirementEnforced() });
  const backupProblem = backupEmailProblem(form.backupEmail, primaryEmail);
  const backupHint = form.backupEmail.trim().length > 0 && backupProblem
    ? BACKUP_EMAIL_HINT[backupProblem]
    : null;
  const backupSatisfied = !askBackupEmail || backupProblem === null;

  const ready = form.organization.trim().length > 0
    && form.name.trim().length > 0
    && EMAIL_SHAPE.test(form.email.trim())
    && form.password.length >= MIN_PASSWORD_LENGTH
    && backupSatisfied;

  async function submit() {
    setBusy(true);
    setError(null);
    const backup = form.backupEmail.trim();
    const { data, error: failure } = await supabase.functions.invoke<{ message?: string }>(
      'public-signup',
      {
        body: {
          organization_name: form.organization.trim(),
          full_name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          // The fifth field, and only when the visitor was actually asked for one. A password
          // signup with a real address still sends exactly the four keys 0159 defined.
          ...(backup ? { backup_email: backup } : {}),
        },
      },
    );
    setBusy(false);

    if (failure) {
      await applyFailure(failure, t('signup.setError_2'));
      return;
    }
    setSent(data?.message ?? null);
  }

  async function resendConfirmation() {
    setResending(true);
    setResendResult(null);
    const failureMessage = t('signup.resendFailed');
    try {
      const { error: failure } = await supabase.auth.resend({
        type: 'signup',
        email: form.email.trim().toLowerCase(),
      });
      setResendResult(failure
        ? { ok: false, message: failureMessage }
        : { ok: true, message: t('signup.resendSent') });
    } catch {
      setResendResult({ ok: false, message: failureMessage });
    } finally {
      setResending(false);
    }
  }

  if (sent) {
    return (
      <main className="mx-auto max-w-md px-4 py-8 sm:py-12">
        <Card className="space-y-3 text-center">
          <MailCheck size={ICON.hero} aria-hidden="true" className="mx-auto text-done-fg" />
          <h1 className="page-title">{t('signup.text')}</h1>
          {/* Deliberately the same sentence whether the address was new or already registered:
              a different answer per case would turn this page into a way to discover who has an
              account. */}
          <p className="text-sm text-ink-soft">{sent}</p>
          {resendResult && (
            <Note tone={resendResult.ok ? 'done' : 'alert'} role={resendResult.ok ? 'status' : 'alert'}>
              {resendResult.message}
            </Note>
          )}
          <button type="button" className="btn-secondary w-full" disabled={resending}
            onClick={() => void resendConfirmation()}>
            {resending ? t('signup.resending') : t('signup.resendAction')}
          </button>
          <Link className="btn-secondary" to="/login">{t('signup.toLogin')}</Link>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8 sm:py-12">
      <Card className="space-y-4">
        <h1 className="page-title flex items-center gap-2"><Building2 size={ICON.xl} aria-hidden="true" /> {t('signup.text_3')}</h1>
        <p className="text-sm text-ink-soft">
          {t('signup.text_4')}
        </p>

        {error && <div id="signup-problem"><ErrorNote message={error} /></div>}

        {federated && (
          <Note tone="idle">
            <span className="min-w-0 flex-1">
              {federated.email
                ? <>{t('signup.text_5')}<span dir="ltr">{federated.email}</span>{' '}
                  {t('signup.signedInWith', { provider: FEDERATED_PROVIDER_LABEL[federated.provider] })}</>
                : <>{t('signup.signedInWithNoEmail', { provider: FEDERATED_PROVIDER_LABEL[federated.provider] })}</>}
              {' '}{t('signup.onlyNameTheBusiness')}
            </span>
          </Note>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="signup-organization">{t('signup.text_6')}</label>
            <input id="signup-organization" className="input" value={form.organization}
              autoComplete="organization"
              aria-describedby={error ? 'signup-problem' : undefined}
              onChange={(event) => setForm({ ...form, organization: event.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="signup-name">{t('signup.text_7')}</label>
            <input id="signup-name" className="input" value={form.name} autoComplete="name"
              aria-describedby={error ? 'signup-problem' : undefined}
              onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
        </div>
        {!federated && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="signup-email">{t('signup.text_8')}</label>
              {/* The screen has always judged this address — that is what greys out the button.
                  It simply never told the field, so a screen reader met a dead control and no
                  reason for it. */}
              <input id="signup-email" type="email" dir="ltr" className="input" value={form.email}
                autoComplete="email"
                aria-invalid={emailProblem || undefined}
                aria-describedby={error ? 'signup-problem' : undefined}
                onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="signup-password">{t('signup.text_9')}</label>
              <input id="signup-password" type="password" dir="ltr" className="input"
                value={form.password} autoComplete="new-password"
                aria-invalid={passwordProblem || undefined}
                aria-describedby={`signup-password-rule${error ? ' signup-problem' : ''}`}
                onChange={(event) => setForm({ ...form, password: event.target.value })} />
              <p id="signup-password-rule" className={`mt-1 text-xs ${passwordProblem ? 'text-alert-fg' : 'text-ink-muted'}`}>
                {t('signup.passwordRule', { min: MIN_PASSWORD_LENGTH })}
              </p>
            </div>
          </div>
        )}

        {/* The fifth field (owner decision #270), drawn only for an address a third party can
            switch off — or when the server said it wants one and this bundle did not know. It is
            its own row rather than a third cell in the grid above, because the federated branch
            hides that grid entirely and this field has to survive without it. */}
        {askBackupEmail && (
          <div>
            <label className="label" htmlFor="signup-backup-email">
              {t('signup.backupEmailLabel')}
            </label>
            <input id="signup-backup-email" type="email" dir="ltr" className="input"
              value={form.backupEmail} autoComplete="email"
              aria-invalid={backupHint !== null || undefined}
              aria-describedby={`signup-backup-email-why${error ? ' signup-problem' : ''}`}
              onChange={(event) => setForm({ ...form, backupEmail: event.target.value })} />
            <p id="signup-backup-email-why"
              className={`mt-1 text-xs ${backupHint ? 'text-alert-fg' : 'text-ink-muted'}`}>
              {backupHint ? t(backupHint) : t('signup.backupEmailWhy')}
            </p>
          </div>
        )}

        <Note tone="idle">
          <span className="min-w-0 flex-1">
            {t('signup.text_10')}
          </span>
        </Note>

        {federated ? (
          <button type="button" className="btn-primary w-full"
            disabled={busy || form.organization.trim().length < 2 || !backupSatisfied}
            onClick={() => void finishFederatedSignup(federated.provider)}>
            {busy ? t('signup.text_11') : t('signup.text_12')}
          </button>
        ) : (
          <button type="button" className="btn-primary w-full" disabled={busy || !ready}
            onClick={() => void submit()}>
            {busy ? t('signup.text_13') : t('signup.text_14')}
          </button>
        )}

        {!federated && providers.length > 0 && (
          <>
            <p className="text-center text-xs text-ink-muted">{t('signup.text_15')}</p>
            {providers.map((provider) => (
              <button key={provider} type="button" className="btn-secondary w-full" disabled={busy}
                onClick={() => void continueWith(provider)}>
                {t('signup.text_16')} {FEDERATED_PROVIDER_LABEL[provider]}
              </button>
            ))}
            <p className="text-center text-xs text-ink-muted">
              {t('signup.text_17')}
            </p>
          </>
        )}

        <p className="text-center text-sm text-ink-muted">
          {t('signup.alreadyHaveAccount')}{' '}<Link className="link" to="/login">{t('signup.text_18')}</Link>
        </p>
      </Card>
    </main>
  );
}
