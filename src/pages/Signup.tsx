import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Building2, MailCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { ErrorNote, Note } from '../components/ui';

const MIN_PASSWORD_LENGTH = 10;

/**
 * Self-service signup (0159) — the screen that reversed OPEN-DECISIONS #12.
 *
 * It asks for four things and nothing else. There is no plan picker, no VAT field and no
 * category list, because none of those are the visitor's to choose: the database sets the
 * starting plan, and a form that could ask for Business would be a free upgrade. Sending them
 * would change nothing either — the Edge Function reads exactly these four keys.
 */
/**
 * Signing up with Google is offered here and nowhere else (OPEN-DECISIONS #265, 24.08.2026):
 * this screen creates an ORGANIZATION, and the person who creates one is its owner. An employee
 * arrives through an invitation and a password, and `0205` makes the invitation command refuse a
 * federated caller by name — so the rule holds even if someone calls the API directly.
 *
 * The button is hidden unless the provider is configured. A door that leads only to
 * "provider is not enabled" is worse than no door.
 */
const GOOGLE_SIGNUP_ENABLED = import.meta.env.VITE_GOOGLE_SIGNUP_ENABLED === 'true';

export default function Signup() {
  const [form, setForm] = useState({ organization: '', name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  /** Set when Google sent the browser back here with a session but no organization yet. */
  const [googleEmail, setGoogleEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      const user = data.session?.user;
      // `app_metadata` is written by the auth server. `user_metadata` is self-asserted and is
      // never what decides which branch runs — the Edge function re-reads this server-side too.
      if (cancelled || !user || user.app_metadata?.provider !== 'google') return;
      setGoogleEmail(user.email ?? null);
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

  async function continueWithGoogle() {
    setError(null);
    const { error: failure } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/signup` },
    });
    if (failure) setError('ההתחברות עם Google אינה זמינה כרגע.');
  }

  /** The federated branch: Google proved the address, so only the organization name is missing. */
  async function finishGoogleSignup() {
    setBusy(true);
    setError(null);
    const { data, error: failure } = await supabase.functions.invoke<{ message?: string }>(
      'public-signup',
      {
        body: {
          identity: 'google',
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

  const ready = form.organization.trim().length > 0
    && form.name.trim().length > 0
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())
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

  if (sent) {
    return (
      <main className="mx-auto max-w-md px-4 py-12">
        <div className="card card-pad space-y-3 text-center">
          <MailCheck size={28} aria-hidden="true" className="mx-auto text-done-fg" />
          <h1 className="page-title">בדקו את תיבת הדואר</h1>
          {/* Deliberately the same sentence whether the address was new or already registered:
              a different answer per case would turn this page into a way to discover who has an
              account. */}
          <p className="text-sm text-ink-soft">{sent}</p>
          <Link className="btn-secondary" to="/login">מעבר להתחברות</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <div className="card card-pad space-y-4">
        <h1 className="page-title flex items-center gap-2"><Building2 size={22} /> פתיחת חשבון</h1>
        <p className="text-sm text-ink-soft">
          החשבון נפתח מיד, וההתחברות אפשרית לאחר אישור כתובת האימייל.
        </p>

        {error && <ErrorNote message={error} />}

        {googleEmail && (
          <Note tone="idle">
            <span className="min-w-0 flex-1">
              מחובר כ־<span dir="ltr">{googleEmail}</span>. נשאר רק לתת שם לעסק.
            </span>
          </Note>
        )}

        <div>
          <label className="label" htmlFor="signup-organization">שם העסק</label>
          <input id="signup-organization" className="input" value={form.organization}
            autoComplete="organization"
            onChange={(event) => setForm({ ...form, organization: event.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="signup-name">שם מלא</label>
          <input id="signup-name" className="input" value={form.name} autoComplete="name"
            onChange={(event) => setForm({ ...form, name: event.target.value })} />
        </div>
        {!googleEmail && (
          <>
            <div>
              <label className="label" htmlFor="signup-email">אימייל</label>
              <input id="signup-email" type="email" dir="ltr" className="input" value={form.email}
                autoComplete="email"
                onChange={(event) => setForm({ ...form, email: event.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="signup-password">סיסמה</label>
              <input id="signup-password" type="password" dir="ltr" className="input"
                value={form.password} autoComplete="new-password"
                onChange={(event) => setForm({ ...form, password: event.target.value })} />
              <p className="mt-1 text-xs text-ink-muted">לפחות {MIN_PASSWORD_LENGTH} תווים.</p>
            </div>
          </>
        )}

        <Note tone="idle">
          <span className="min-w-0 flex-1">
            החשבון נפתח במסלול ההתחלתי. שינוי מסלול נעשה מול השירות ואינו נבחר בטופס הזה.
          </span>
        </Note>

        {googleEmail ? (
          <button type="button" className="btn-primary w-full"
            disabled={busy || form.organization.trim().length < 2}
            onClick={() => void finishGoogleSignup()}>
            {busy ? 'פותח חשבון…' : 'פתיחת חשבון'}
          </button>
        ) : (
          <button type="button" className="btn-primary w-full" disabled={busy || !ready}
            onClick={() => void submit()}>
            {busy ? 'פותח חשבון…' : 'פתיחת חשבון'}
          </button>
        )}

        {GOOGLE_SIGNUP_ENABLED && !googleEmail && (
          <>
            <p className="text-center text-xs text-ink-muted">או</p>
            <button type="button" className="btn-secondary w-full" disabled={busy}
              onClick={() => void continueWithGoogle()}>
              המשך עם Google
            </button>
            <p className="text-center text-xs text-ink-muted">
              פתיחת עסק חדש בלבד. הצטרפות לעסק קיים נעשית מהזמנה שנשלחה אליך.
            </p>
          </>
        )}

        <p className="text-center text-sm text-ink-muted">
          כבר יש חשבון? <Link className="link" to="/login">התחברות</Link>
        </p>
      </div>
    </main>
  );
}
