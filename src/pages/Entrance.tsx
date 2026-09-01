import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Eye, EyeOff, Loader2, Lock, MailCheck } from 'lucide-react';
import { Card, ErrorNote, ICON, Note } from '../components/ui';
import { useAuth, homeFor } from '../auth/AuthContext';
import { APP_NAME } from '../lib/branding';
import { startAurora } from '../lib/loginAurora';
import { supabase } from '../lib/supabase';
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

/**
 * The one door — sign in and open a business on a single card (owner decision 31.08.2026).
 *
 * WHAT THE OWNER ACTUALLY REPORTED, because it decides the shape: "two buttons that lead to two
 * separate windows". The complaint was never that the product asks who you are; it was that
 * answering meant a navigation, and that the marketing site's two calls to action landed in two
 * unrelated places. So `/login` and `/signup` both render THIS, and moving between "I have an
 * account" and "I am opening a business" expands a section instead of replacing the page. What was
 * typed survives the switch, because it is the same field.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, and it is the reason the screen looks the way it does: it
 * never asks the server whether an address is registered. A screen that could answer that is a
 * directory of our customers for anyone who can type — the same reason `Login` refuses to say
 * which of the two credentials was wrong, the confirmation card says the same sentence to a new
 * address and a taken one, and `public-signup` answers `email_taken` with NEUTRAL_ANSWER.
 *
 * The auto-detection the owner asked for is real, and it is the federated button that provides it:
 * a provider PROVES the address, and proof is what makes an answer safe to give. Returning owner
 * lands on their dashboard, a newcomer is asked only to name a business, and someone who first
 * signed up with a password reaches the same account because Supabase links identities that share
 * a verified address. `public-signup/index.ts:211` states the rule this rests on — "saying so is
 * safe: the caller proved this identity is theirs".
 */
type EntranceMode = 'signIn' | 'createBusiness';

const MIN_PASSWORD_LENGTH = 10;

/** The one shape check on the address, named once so the button state and the field's own
 *  validity cannot drift apart. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const LOCAL_DEMO_ROLES = [
  { role: 'owner', labelKey: 'login.demoRoleOwner' },
  { role: 'office', labelKey: 'login.demoRoleOffice' },
  { role: 'accountant', labelKey: 'login.demoRoleAccountant' },
] as const satisfies readonly { role: string; labelKey: TKey }[];

const BACKUP_EMAIL_HINT: Record<BackupEmailProblem, 'signup.backupEmailMalformed'
  | 'signup.backupEmailTooLong' | 'signup.backupEmailSameAsPrimary'
  | 'signup.backupEmailStillRelay' | null> = {
  missing: null,
  malformed: 'signup.backupEmailMalformed',
  too_long: 'signup.backupEmailTooLong',
  same_as_primary: 'signup.backupEmailSameAsPrimary',
  still_a_relay: 'signup.backupEmailStillRelay',
};

function isFederatedProvider(value: unknown): value is FederatedProvider {
  return typeof value === 'string' && (FEDERATED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Demo credentials are a local-development convenience, never a production surface.
 *
 * Two conditions are required rather than one: an explicit seed, and a loopback Supabase host. A
 * production build that accidentally receives the seed still shows nothing, and a developer
 * pointed at the live project cannot fill known demo passwords into it from this screen.
 */
function localDemoAccounts(supabaseUrl: string | undefined, seed: string | undefined) {
  const cleanSeed = seed?.trim();
  if (!cleanSeed || !supabaseUrl) return [];
  try {
    const host = new URL(supabaseUrl).hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return [];
  } catch {
    return [];
  }
  return LOCAL_DEMO_ROLES.map(({ role, labelKey }) => ({
    role,
    labelKey,
    email: `${role}@demo.supplyflow.local`,
    password: `P4!${cleanSeed}-${role}-Aa7`,
  }));
}

export default function Entrance({ initialMode }: { initialMode: EntranceMode }) {
  const { signIn, session, profile, loading } = useAuth();
  const { t, dir, errorText } = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const [mode, setMode] = useState<EntranceMode>(initialMode);
  /** One address and one password for BOTH modes. Switching modes must not lose what was typed —
   *  that is the difference between one screen and two screens sharing a stylesheet. */
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organization, setOrganization] = useState('');
  const [fullName, setFullName] = useState('');
  const [backupEmail, setBackupEmail] = useState('');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [serverAskedForBackup, setServerAskedForBackup] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [resendResult, setResendResult] = useState<{ ok: boolean; message: string } | null>(null);
  /** Set when a provider sent the browser back here with a session but no organization yet. */
  const [federated, setFederated] = useState<{ provider: FederatedProvider; email: string } | null>(
    null,
  );
  /**
   * Set when the server recognised the PROVEN address as one that was invited to an existing
   * business. See `public-signup`'s `invitation_pending`: the person is not a new owner and must
   * not be turned into one, and telling them so is safe because the provider proved the address.
   */
  const [invitation, setInvitation] = useState<{ organization: string } | null>(null);

  const auroraRef = useRef<HTMLCanvasElement>(null);
  const providers = enabledFederatedProviders();
  const demoAccounts = import.meta.env.DEV
    ? localDemoAccounts(
        import.meta.env.VITE_SUPABASE_URL as string | undefined,
        import.meta.env.VITE_DEMO_PASSWORD_SEED as string | undefined,
      )
    : [];

  // Above the redirect, because hooks cannot sit behind an early return. On the frame where the
  // redirect fires there is no canvas, the ref is null, and startAurora hands back a no-op.
  useEffect(() => startAurora(auroraRef.current), []);

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
      setFullName((previous) => previous || suggested);
      setEmail((previous) => user.email ?? previous);
    });
    return () => { cancelled = true; };
  }, []);

  /**
   * A returning identity lands HERE, not on a second screen: `redirectTo` is {origin}/signup for
   * every entrance, because on a first visit this is the only place that can finish the job. On a
   * second visit the form would be the wrong thing entirely — the person already has a business,
   * and would be asked to name it again.
   *
   * Below the hooks, because a redirect must not skip them. Gated on `!loading` so the frame where
   * the profile has not resolved yet does not read as "no tenant".
   */
  if (!loading && session && profile) return <Navigate to={homeFor(profile.role)} replace />;

  async function signInWithCredentials(loginEmail: string, loginPassword: string) {
    setBusy(true);
    setError(null);
    const err = await signIn(loginEmail, loginPassword);
    setBusy(false);
    if (err) {
      // A sign-in failure never names which of the two credentials was wrong — saying so would be
      // a member directory. `errorText` maps the provider's English strings to Hebrew and falls
      // back to Hebrew for anything it does not recognise.
      setError(errorText(err));
    } else {
      navigate('/', replaceOpts);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // The federated branch renders no credential fields, but it DOES render the business ones, and
    // Enter inside a text input submits the form it sits in. Without this, pressing Enter after
    // typing a business name would call the password sign-in with two empty strings.
    if (federated) {
      await finishFederatedSignup(federated.provider);
      return;
    }
    if (mode === 'signIn') {
      await signInWithCredentials(email.trim(), password);
      return;
    }
    await createBusiness();
  }

  async function continueWith(provider: FederatedProvider) {
    setError(null);
    const { error: failure } = await startFederatedSignup(provider);
    if (failure) {
      setError(t('login.federatedUnavailable', { provider: FEDERATED_PROVIDER_LABEL[provider] }));
    }
  }

  /**
   * The Edge function's own answer, when it sent one, plus the two codes this screen ACTS on.
   *
   * `backup_email_required` means the server wants a field the form did not draw — the two
   * build-time switches are out of step, and drawing it turns a dead end into one more step.
   * `invitation_pending` means the proven address belongs to somebody who was invited to an
   * existing business, and must not be handed a new one.
   */
  async function applyFailure(failure: unknown, fallback: string) {
    const context = (failure as { context?: Response }).context;
    if (context && typeof context.json === 'function') {
      try {
        const payload = await context.json() as {
          error?: { code?: string; message?: string; organization?: string };
        };
        if (payload?.error?.code === 'backup_email_required') setServerAskedForBackup(true);
        if (payload?.error?.code === 'invitation_pending') {
          setInvitation({ organization: payload.error.organization ?? '' });
          return;
        }
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
    const backup = backupEmail.trim();
    const { error: failure } = await supabase.functions.invoke<{ message?: string }>(
      'public-signup',
      {
        body: {
          identity: provider,
          organization_name: organization.trim(),
          full_name: fullName.trim(),
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
  }

  async function createBusiness() {
    setBusy(true);
    setError(null);
    const backup = backupEmail.trim();
    const { data, error: failure } = await supabase.functions.invoke<{ message?: string }>(
      'public-signup',
      {
        body: {
          organization_name: organization.trim(),
          full_name: fullName.trim(),
          email: email.trim(),
          password,
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
        email: email.trim().toLowerCase(),
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

  // Typed-but-wrong, not merely empty: an untouched field is not a mistake yet, and marking it
  // invalid before anyone has typed would announce a failure the visitor has not made.
  const emailProblem = email.trim().length > 0 && !EMAIL_SHAPE.test(email.trim());
  const passwordProblem = mode === 'createBusiness'
    && password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  /**
   * The address this signup will actually be keyed by — the provider's when one signed us in, and
   * only otherwise the one being typed. A federated session has no password field at all, so
   * reading the typed value here would ask an Apple owner about an address they never entered.
   */
  const primaryEmail = federated ? federated.email : email.trim();
  const askBackupEmail = serverAskedForBackup
    || backupEmailRequired(primaryEmail, { enforced: backupEmailRequirementEnforced() });
  const backupProblem = backupEmailProblem(backupEmail, primaryEmail);
  const backupHint = backupEmail.trim().length > 0 && backupProblem
    ? BACKUP_EMAIL_HINT[backupProblem]
    : null;
  const backupSatisfied = !askBackupEmail || backupProblem === null;

  const readyToCreate = organization.trim().length > 0
    && fullName.trim().length > 0
    && EMAIL_SHAPE.test(email.trim())
    && password.length >= MIN_PASSWORD_LENGTH
    && backupSatisfied;

  const creating = mode === 'createBusiness';
  const problemId = error ? 'entrance-problem' : undefined;

  /** Everything below shares one card and one heading. Only this changes. */
  function panelBody() {
    if (sent) {
      return (
        <div className="space-y-3 text-center">
          <MailCheck size={ICON.hero} aria-hidden="true" className="mx-auto text-done-fg" />
          <h1 id="entrance-heading" className="page-title text-3xl">{t('signup.text')}</h1>
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
        </div>
      );
    }

    if (invitation) {
      return (
        <div className="space-y-4">
          <h1 id="entrance-heading" className="page-title text-3xl">{t('login.inviteWaitingTitle')}</h1>
          <Note tone="idle">
            <span className="min-w-0 flex-1">
              {t('login.inviteWaitingBody', {
                email: primaryEmail,
                organization: invitation.organization,
              })}
            </span>
          </Note>
        </div>
      );
    }

    return (
      <>
        <div>
          {/* One h1 for the page, and it names the task rather than the brand — the lockup in the
              aurora panel is the mark. */}
          <h1 id="entrance-heading" className="page-title text-3xl">
            {creating ? t('signup.text_3') : t('login.text_6')}
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            {creating ? t('signup.text_4') : t('login.text_20')}
          </p>
        </div>

        {/* The provider sits ABOVE the credentials on purpose: it is the only path that tells a
            returning owner and a newcomer apart on its own, and it needs no field filled in. */}
        {!federated && providers.length > 0 && (
          <div className="mt-6 space-y-3">
            {providers.map((provider) => (
              <button key={provider} type="button" disabled={busy}
                onClick={() => void continueWith(provider)}
                className="btn min-h-12 w-full border border-line-strong bg-surface text-ink hover:bg-surface-hover">
                {provider === 'google' && (
                  <img src="/brand/google-g.svg" alt="" width="18" height="18" aria-hidden="true" />
                )}
                {t('login.text_19')} {FEDERATED_PROVIDER_LABEL[provider]}
              </button>
            ))}
            <div className="flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-line" />
              <span className="text-xs text-ink-muted">{t('login.text_18')}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
          </div>
        )}

        <form onSubmit={(e) => void onSubmit(e)} className="mt-5 space-y-5" aria-busy={busy || undefined}>
          {params.get('reset') === 'success' && (
            <p role="status" className="note-done">{t('login.text_8')}</p>
          )}

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

          {/* The business fields. They expand in place — switching between "I have an account" and
              "I am opening one" must never be a navigation, because being sent to another window
              is the complaint this screen exists to answer. */}
          {(creating || federated) && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="entrance-organization">{t('signup.text_6')}</label>
                <input id="entrance-organization" className="input" value={organization}
                  autoComplete="organization" aria-describedby={problemId}
                  onChange={(event) => setOrganization(event.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="entrance-name">{t('signup.text_7')}</label>
                <input id="entrance-name" className="input" value={fullName} autoComplete="name"
                  aria-describedby={problemId}
                  onChange={(event) => setFullName(event.target.value)} />
              </div>
            </div>
          )}

          {/* Both credential fields point at the one banner. A federated session has proved its
              address already, so it is shown in the note above and these disappear entirely. */}
          {!federated && (
            <>
              <div>
                <label className="label" htmlFor="email">{t('login.text_9')}</label>
                <input id="email" type="email" className="input" dir="ltr"
                  autoComplete={creating ? 'email' : 'username'}
                  aria-invalid={error || emailProblem ? true : undefined}
                  aria-describedby={problemId}
                  value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div>
                <label className="label" htmlFor="password">{t('login.text_10')}</label>
                {/* dir="ltr" on the wrapper, not just the input: the value is typed left to right,
                    so the reveal toggle belongs at the end of that text — the right-hand side —
                    and `end` has to resolve in the same direction as the input's own `pe-12`. */}
                <div className="relative" dir="ltr">
                  <input id="password" type={showPassword ? 'text' : 'password'} className="input pe-12"
                    autoComplete={creating ? 'new-password' : 'current-password'}
                    aria-invalid={error || passwordProblem ? true : undefined}
                    aria-describedby={creating
                      ? `entrance-password-rule${error ? ' entrance-problem' : ''}`
                      : problemId}
                    value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <button type="button" onClick={() => setShowPassword((current) => !current)}
                    className="absolute inset-y-0 end-0 flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    aria-label={showPassword ? t('login.text_11') : t('login.text_12')} aria-pressed={showPassword}>
                    {showPassword ? <EyeOff size={ICON.md} aria-hidden="true" /> : <Eye size={ICON.md} aria-hidden="true" />}
                  </button>
                </div>
                {creating ? (
                  <p id="entrance-password-rule"
                    className={`mt-1 text-xs ${passwordProblem ? 'text-alert-fg' : 'text-ink-muted'}`}>
                    {t('signup.passwordRule', { min: MIN_PASSWORD_LENGTH })}
                  </p>
                ) : (
                  <Link to="/forgot-password"
                    className="mt-2 inline-block text-sm text-action underline-offset-2 hover:underline">
                    {t('login.text_13')}
                  </Link>
                )}
              </div>
            </>
          )}

          {/* Owner decision #270, drawn only for an address a third party can switch off — or when
              the server said it wants one and this bundle did not know. */}
          {(creating || federated) && askBackupEmail && (
            <div>
              <label className="label" htmlFor="entrance-backup-email">
                {t('signup.backupEmailLabel')}
              </label>
              <input id="entrance-backup-email" type="email" dir="ltr" className="input"
                value={backupEmail} autoComplete="email"
                aria-invalid={backupHint !== null || undefined}
                aria-describedby={`entrance-backup-email-why${error ? ' entrance-problem' : ''}`}
                onChange={(event) => setBackupEmail(event.target.value)} />
              <p id="entrance-backup-email-why"
                className={`mt-1 text-xs ${backupHint ? 'text-alert-fg' : 'text-ink-muted'}`}>
                {backupHint ? t(backupHint) : t('signup.backupEmailWhy')}
              </p>
            </div>
          )}

          {error && <div id="entrance-problem"><ErrorNote message={error} /></div>}

          {(creating || federated) && (
            <Note tone="idle">
              <span className="min-w-0 flex-1">{t('signup.text_10')}</span>
            </Note>
          )}

          {import.meta.env.DEV && !creating && !federated && demoAccounts.length > 0 && (
            <details className="rounded-lg border border-shell-ink/15 bg-shell-ink/5 px-3 py-2 text-start">
              <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-ink">
                {t('login.text_14')}
              </summary>
              <p className="mb-2 text-xs text-ink-muted">{t('login.text_15')}</p>
              <div className="grid grid-cols-2 gap-2">
                {demoAccounts.map((account) => (
                  <button key={account.role} type="button"
                    className="btn-secondary btn-sm justify-center"
                    aria-label={t('login.signInAsAria', { role: t(account.labelKey) })}
                    disabled={busy}
                    onClick={() => {
                      setEmail(account.email);
                      setPassword(account.password);
                      void signInWithCredentials(account.email, account.password);
                    }}>
                    {t(account.labelKey)}
                  </button>
                ))}
              </div>
            </details>
          )}

          {federated ? (
            <button type="button" className="btn-primary w-full"
              disabled={busy || organization.trim().length < 2 || !backupSatisfied}
              onClick={() => void finishFederatedSignup(federated.provider)}>
              {busy ? t('signup.text_11') : t('signup.text_12')}
            </button>
          ) : (
            <button type="submit" className="btn-primary w-full"
              disabled={busy || (creating && !readyToCreate)}>
              {busy
                ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" />
                : <Lock size={ICON.sm} aria-hidden="true" />}
              {busy
                ? (creating ? t('signup.text_13') : t('login.text_16'))
                : (creating ? t('signup.text_14') : t('login.text_17'))}
            </button>
          )}
        </form>

        {/* The switch. A button and not a Link, because the whole point is that nothing navigates:
            the address and password already typed stay exactly where they are. */}
        {!federated && (
          <p className="mt-6 text-center text-sm text-ink-muted">
            {creating ? t('signup.alreadyHaveAccount') : t('login.noAccountYet')}{' '}
            <button type="button" className="link font-medium text-action underline-offset-2 hover:underline"
              onClick={() => { setMode(creating ? 'signIn' : 'createBusiness'); setError(null); }}>
              {creating ? t('signup.text_18') : t('login.text_7')}
            </button>
          </p>
        )}
      </>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-5 sm:px-6 lg:py-7">
      {/* `dir=ltr` fixes the physical split from the reference: aurora on the visual left, form on
          the visual right. That is a composition, not a reading order, so it stays pinned in both
          languages. Each panel then restores the SESSION's direction, so the content inside it
          reads the way the person does. */}
      <Card pad={false} clip className="w-full max-w-[75rem]">
        <div dir="ltr" className="lg:grid lg:min-h-[min(50rem,calc(100dvh-5rem))] lg:grid-cols-2">
          {/* Nothing is authenticated here, so there is no tenant to name. On a phone the visual
              collapses to a compact banner so the form still owns the first fold. */}
          <section aria-label={t('login.aria_label')} dir={dir} className="aurora-pane h-48 lg:h-auto">
            <canvas ref={auroraRef} aria-hidden="true" className="absolute inset-0 size-full" />
            <div className="relative z-10 flex h-full flex-col justify-between p-6 sm:p-8 lg:p-10 xl:p-12">
              <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="156" height="34"
                className="h-auto w-36 sm:w-40" />
              <div>
                {/* shell-ink, never -soft or -dim: on the ramp's brightest stop those measure
                    3.62:1 and worse, while shell-ink holds 4.83:1. */}
                <p className="text-shell-ink text-xs">{t('login.text')}</p>
                <p className="mt-2 text-2xl leading-tight font-semibold text-on-solid lg:text-3xl">
                  {t('login.text_2')}
                </p>
              </div>
              {/* Three statements the product can actually back, not marketing: the domain it
                  covers, the promise of section 12 of the constitution, and the audit rule. */}
              <ul className="hidden space-y-3 text-sm text-shell-ink lg:block">
                <li className="border-s border-shell-ink/30 ps-3">{t('login.text_3')}</li>
                <li className="border-s border-shell-ink/30 ps-3">{t('login.text_4')}</li>
                <li className="border-s border-shell-ink/30 ps-3">{t('login.text_5')}</li>
              </ul>
            </div>
          </section>
          <section aria-labelledby="entrance-heading" dir={dir}
            className="flex items-center bg-surface px-6 py-8 sm:px-10 sm:py-10 lg:px-12 xl:px-16">
            <div className="mx-auto w-full max-w-md">
              {panelBody()}
            </div>
          </section>
        </div>
      </Card>
      {/* Outside the card, on the page canvas — flex+gap rather than space-x-3, because the app is
          RTL and space-x uses the physical axis. */}
      <div className="mt-5 flex justify-center gap-3 text-xs text-ink-muted">
        <Link to="/terms" className="hover:underline">{t('login.text_21')}</Link>
        <span aria-hidden>·</span>
        <Link to="/privacy" className="hover:underline">{t('login.text_22')}</Link>
      </div>
    </main>
  );
}

const replaceOpts = { replace: true };
