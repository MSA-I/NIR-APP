import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router';
import { useAuth, homeFor } from '../auth/AuthContext';
import { Building2, MailCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Card, ErrorNote, ICON, Note } from '../components/ui';
import {
  enabledFederatedProviders,
  FEDERATED_PROVIDER_LABEL,
  FEDERATED_PROVIDERS,
  startFederatedSignup,
  type FederatedProvider,
} from '../lib/authProviders';

const MIN_PASSWORD_LENGTH = 10;

/** The one shape check on the address, named once so `ready` and the field's own validity state
 *  cannot drift apart — the screen already made this judgement, it simply never told the field. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isFederatedProvider(value: unknown): value is FederatedProvider {
  return typeof value === 'string' && (FEDERATED_PROVIDERS as readonly string[]).includes(value);
}

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
  const [form, setForm] = useState({ organization: '', name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      setError(`ההתחברות עם ${FEDERATED_PROVIDER_LABEL[provider]} אינה זמינה כרגע.`);
    }
  }

  /** The federated branch: the provider proved the address, so only the business name is missing. */
  async function finishFederatedSignup(provider: FederatedProvider) {
    setBusy(true);
    setError(null);
    const { data, error: failure } = await supabase.functions.invoke<{ message?: string }>(
      'public-signup',
      {
        body: {
          identity: provider,
          organization_name: form.organization.trim(),
          full_name: form.name.trim(),
        },
      },
    );
    setBusy(false);
    if (failure) {
      const context = (failure as { context?: Response }).context;
      if (context && typeof context.json === 'function') {
        try {
          const payload = await context.json() as { error?: { message?: string } };
          if (payload?.error?.message) { setError(payload.error.message); return; }
        } catch {
          // no JSON body — fall through to the transport message
        }
      }
      setError('ההרשמה נכשלה. יש לנסות שוב, ואם הבעיה חוזרת לפנות לתמיכה.');
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
  const ready = form.organization.trim().length > 0
    && form.name.trim().length > 0
    && EMAIL_SHAPE.test(form.email.trim())
    && form.password.length >= MIN_PASSWORD_LENGTH;

  async function submit() {
    setBusy(true);
    setError(null);
    const { data, error: failure } = await supabase.functions.invoke<{ message?: string }>(
      'public-signup',
      {
        body: {
          organization_name: form.organization.trim(),
          full_name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
        },
      },
    );
    setBusy(false);

    if (failure) {
      const context = (failure as { context?: Response }).context;
      if (context && typeof context.json === 'function') {
        try {
          const payload = await context.json() as { error?: { message?: string } };
          if (payload?.error?.message) { setError(payload.error.message); return; }
        } catch {
          // no JSON body — fall through to the transport message
        }
      }
      setError('ההרשמה נכשלה. יש לנסות שוב, ואם הבעיה חוזרת לפנות לתמיכה.');
      return;
    }
    setSent(data?.message ?? null);
  }

  async function resendConfirmation() {
    setResending(true);
    setResendResult(null);
    const failureMessage = 'לא הצלחנו לשלוח מייל אישור חדש. יש להמתין דקה ולנסות שוב.';
    try {
      const { error: failure } = await supabase.auth.resend({
        type: 'signup',
        email: form.email.trim().toLowerCase(),
      });
      setResendResult(failure
        ? { ok: false, message: failureMessage }
        : { ok: true, message: 'מייל אישור חדש נשלח.' });
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
          <h1 className="page-title">בדקו את תיבת הדואר</h1>
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
            {resending ? 'שולח שוב…' : 'שלחו שוב'}
          </button>
          <Link className="btn-secondary" to="/login">מעבר להתחברות</Link>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-8 sm:py-12">
      <Card className="space-y-4">
        <h1 className="page-title flex items-center gap-2"><Building2 size={ICON.xl} aria-hidden="true" /> פתיחת חשבון</h1>
        <p className="text-sm text-ink-soft">
          החשבון נפתח מיד, וההתחברות אפשרית לאחר אישור כתובת האימייל.
        </p>

        {error && <div id="signup-problem"><ErrorNote message={error} /></div>}

        {federated && (
          <Note tone="idle">
            <span className="min-w-0 flex-1">
              {federated.email
                ? <>מחובר כ־<span dir="ltr">{federated.email}</span> עם {FEDERATED_PROVIDER_LABEL[federated.provider]}.</>
                : <>מחובר עם {FEDERATED_PROVIDER_LABEL[federated.provider]}.</>}
              {' '}נשאר רק לתת שם לעסק.
            </span>
          </Note>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="signup-organization">שם העסק</label>
            <input id="signup-organization" className="input" value={form.organization}
              autoComplete="organization"
              aria-describedby={error ? 'signup-problem' : undefined}
              onChange={(event) => setForm({ ...form, organization: event.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="signup-name">שם מלא</label>
            <input id="signup-name" className="input" value={form.name} autoComplete="name"
              aria-describedby={error ? 'signup-problem' : undefined}
              onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
        </div>
        {!federated && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="signup-email">אימייל</label>
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
              <label className="label" htmlFor="signup-password">סיסמה</label>
              <input id="signup-password" type="password" dir="ltr" className="input"
                value={form.password} autoComplete="new-password"
                aria-invalid={passwordProblem || undefined}
                aria-describedby={`signup-password-rule${error ? ' signup-problem' : ''}`}
                onChange={(event) => setForm({ ...form, password: event.target.value })} />
              <p id="signup-password-rule" className={`mt-1 text-xs ${passwordProblem ? 'text-alert-fg' : 'text-ink-muted'}`}>
                לפחות {MIN_PASSWORD_LENGTH} תווים.
              </p>
            </div>
          </div>
        )}

        <Note tone="idle">
          <span className="min-w-0 flex-1">
            החשבון נפתח במסלול ההתחלתי. שינוי מסלול נעשה מול השירות ואינו נבחר בטופס הזה.
          </span>
        </Note>

        {federated ? (
          <button type="button" className="btn-primary w-full"
            disabled={busy || form.organization.trim().length < 2}
            onClick={() => void finishFederatedSignup(federated.provider)}>
            {busy ? 'פותח חשבון…' : 'פתיחת חשבון'}
          </button>
        ) : (
          <button type="button" className="btn-primary w-full" disabled={busy || !ready}
            onClick={() => void submit()}>
            {busy ? 'פותח חשבון…' : 'פתיחת חשבון'}
          </button>
        )}

        {!federated && providers.length > 0 && (
          <>
            <p className="text-center text-xs text-ink-muted">או</p>
            {providers.map((provider) => (
              <button key={provider} type="button" className="btn-secondary w-full" disabled={busy}
                onClick={() => void continueWith(provider)}>
                המשך עם {FEDERATED_PROVIDER_LABEL[provider]}
              </button>
            ))}
            <p className="text-center text-xs text-ink-muted">
              פתיחת עסק חדש בלבד. הצטרפות לעסק קיים נעשית מהזמנה שנשלחה אליך.
            </p>
          </>
        )}

        <p className="text-center text-sm text-ink-muted">
          כבר יש חשבון? <Link className="link" to="/login">התחברות</Link>
        </p>
      </Card>
    </main>
  );
}
