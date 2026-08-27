import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { Card, ICON } from '../components/ui';
import { useAuth, homeFor } from '../auth/AuthContext';
import { toHebrewError } from '../lib/errors';
import { APP_NAME } from '../lib/branding';
import { startAurora } from '../lib/loginAurora';
import {
  enabledFederatedProviders,
  FEDERATED_PROVIDER_LABEL,
  startFederatedSignup,
  type FederatedProvider,
} from '../lib/authProviders';

const LOCAL_DEMO_ROLES = [
  { role: 'owner', label: 'מנהל/בעלים' },
  { role: 'office', label: 'מנהל רכש' },
  { role: 'accountant', label: 'רואה חשבון' },
] as const;

/**
 * Demo credentials are a local-development convenience, never a production surface.
 *
 * Two conditions are required rather than one: an explicit seed, and a loopback Supabase host.
 * A production build that accidentally receives the seed still shows nothing, and a developer
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
  return LOCAL_DEMO_ROLES.map(({ role, label }) => ({
    role,
    label,
    email: `${role}@demo.supplyflow.local`,
    password: `P4!${cleanSeed}-${role}-Aa7`,
  }));
}

export default function Login() {
  const { signIn, session, profile, loading } = useAuth();
  const { dir } = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
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

  if (!loading && session && profile) return <Navigate to={homeFor(profile.role)} replace />;

  async function signInWithCredentials(loginEmail: string, loginPassword: string) {
    setBusy(true);
    setError(null);
    const err = await signIn(loginEmail, loginPassword);
    setBusy(false);
    if (err) {
      // One string used to be translated by hand and everything else passed through raw, so the
      // FIRST screen a customer meets could answer in English: "Email not confirmed", "Email logins
      // are disabled", "Failed to fetch". toHebrewError already maps all of those (errors.ts:211-220)
      // and falls back to Hebrew for anything it does not recognise — it was simply never called.
      setError(toHebrewError(err));
    } else {
      navigate('/', replaceOpts);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    await signInWithCredentials(email.trim(), password);
  }

  /**
   * Owner decision 25.08.2026, amending #265: the login screen may start the federated hand-off,
   * because a business owner opening an account looks for the door here first. It does not finish
   * it — the provider returns the browser to /signup, which is still the only screen that turns a
   * proven address into an organization, and `public-signup` is still the only thing that agrees.
   */
  async function continueWith(provider: FederatedProvider) {
    setError(null);
    const { error: failure } = await startFederatedSignup(provider);
    if (failure) {
      setError(`ההתחברות עם ${FEDERATED_PROVIDER_LABEL[provider]} אינה זמינה כרגע.`);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-5 sm:px-6 lg:py-7">
      {/* `dir=ltr` fixes the physical split from the reference: aurora on the visual left, form on
          the visual right. That is a composition, not a reading order, so it stays pinned in both
          languages — brand-left/form-right is as ordinary in English as it is in Hebrew.
          Each panel then restores the SESSION's direction, so the content inside it reads the way
          the person does. These used to be a hardcoded `dir="rtl"`, which pinned the login form to
          RTL even for an English browser and made the one screen that renders before auth the one
          screen that could not follow the language. */}
      <Card pad={false} clip className="w-full max-w-[75rem]">
        <div dir="ltr" className="lg:grid lg:min-h-[min(50rem,calc(100dvh-5rem))] lg:grid-cols-2">
          {/* Nothing is authenticated here, so there is no tenant to name. On a phone the visual
              collapses to a compact banner so the form still owns the first fold. */}
          <section aria-label="זהות InPlace" dir={dir} className="aurora-pane h-48 lg:h-auto">
            <canvas ref={auroraRef} aria-hidden="true" className="absolute inset-0 size-full" />
            <div className="relative z-10 flex h-full flex-col justify-between p-6 sm:p-8 lg:p-10 xl:p-12">
              {/* The lockup is the mark, not this screen's title — the <h1> is „כניסה לחשבון"
                  in the form panel, so the page has exactly one h1 and it names the task. */}
              <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="156" height="34"
                className="h-auto w-36 sm:w-40" />
              <div>
                {/* shell-ink, never -soft or -dim: on the ramp's brightest stop those measure
                    3.62:1 and worse, while shell-ink holds 4.83:1. */}
                <p className="text-shell-ink text-xs">כניסה מאובטחת לסביבת העבודה</p>
                <p className="mt-2 text-2xl leading-tight font-semibold text-on-solid lg:text-3xl">
                  רכש, חשבוניות ותשלומים במקום אחד
                </p>
              </div>
              {/* Three statements the product can actually back, not marketing: the domain it
                  covers, the promise of section 12 of the constitution, and the audit rule.
                  Desktop only. Quiet logical rule instead of bullet glyphs. */}
              <ul className="hidden space-y-3 text-sm text-shell-ink lg:block">
                <li className="border-s border-shell-ink/30 ps-3">
                  כל מסע הרכש במקום אחד — מהזמנה לספק ועד התאמת התשלום בבנק.
                </li>
                <li className="border-s border-shell-ink/30 ps-3">
                  המסך הראשון אומר מה דורש טיפול, מה עלול לעלות כסף, ומה מצב העסק עכשיו.
                </li>
                <li className="border-s border-shell-ink/30 ps-3">
                  כל שינוי מחיר, כל אישור וכל תשלום נרשמים ביומן עם סיבה.
                </li>
              </ul>
            </div>
          </section>
          <section aria-labelledby="login-heading" dir={dir}
            className="flex items-center bg-surface px-6 py-8 sm:px-10 sm:py-10 lg:px-12 xl:px-16">
            <div className="mx-auto w-full max-w-md">
              <div>
                {/* `page-title` is the app's one title class; `text-3xl` is a utility, so it wins
                    over the component layer and the hero size is unchanged. */}
                <h1 id="login-heading" className="page-title text-3xl">כניסה לחשבון</h1>
                <p className="mt-2 text-sm text-ink-muted">
                  אין לכם חשבון?{' '}
                  <Link to="/signup" className="font-medium text-action underline-offset-2 hover:underline">
                    להרשמה
                  </Link>
                </p>
              </div>
              <form onSubmit={(e) => void onSubmit(e)} className="mt-8 space-y-5" aria-busy={busy || undefined}>
              {params.get('reset') === 'success' && (
                <p role="status" className="note-done">הסיסמה הוחלפה וכל החיבורים נותקו. אפשר להתחבר מחדש.</p>
              )}
              {/* Both credential fields are marked and both point at the one banner. A sign-in
                  failure never names which of the two was wrong — saying so would be a member
                  directory — so marking one field and not the other would be a claim the server
                  did not make. What was missing was any link at all: the banner announced itself
                  and left the fields unmarked. */}
              <div>
                <label className="label" htmlFor="email">אימייל</label>
                <input id="email" type="email" className="input" dir="ltr" autoComplete="username"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'login-problem' : undefined}
                  value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div>
                <label className="label" htmlFor="password">סיסמה</label>
                {/* dir="ltr" on the wrapper, not just the input: the value is typed left to right,
                    so the reveal toggle belongs at the end of that text — the right-hand side —
                    and `end` has to resolve in the same direction as the input's own `pe-12`,
                    or the padding is reserved on one side and the button sits on the other. */}
                <div className="relative" dir="ltr">
                  <input id="password" type={showPassword ? 'text' : 'password'} className="input pe-12" autoComplete="current-password"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? 'login-problem' : undefined}
                    value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <button type="button" onClick={() => setShowPassword((current) => !current)}
                    className="absolute inset-y-0 end-0 flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    aria-label={showPassword ? 'הסתרת סיסמה' : 'הצגת סיסמה'} aria-pressed={showPassword}>
                    {showPassword ? <EyeOff size={ICON.md} aria-hidden="true" /> : <Eye size={ICON.md} aria-hidden="true" />}
                  </button>
                </div>
                {/* Under the field at every width (owner, 19.08.2026). The reference parks it on
                    the label's line, but that row is tight in Hebrew and the recovery step reads
                    as an answer to the field it follows, not as a caption on the field's title. */}
                <Link to="/forgot-password"
                  className="mt-2 inline-block text-sm text-action underline-offset-2 hover:underline">
                  שכחתי סיסמה
                </Link>
              </div>
              {error && <div id="login-problem" role="alert" className="note-alert">{error}</div>}
              {import.meta.env.DEV && demoAccounts.length > 0 && (
                <details className="rounded-lg border border-shell-ink/15 bg-shell-ink/5 px-3 py-2 text-start">
                  <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-ink">
                    חשבונות דמו מקומיים
                  </summary>
                  <p className="mb-2 text-xs text-ink-muted">
                    לחיצה מתחברת מיד לחשבון שנבחר. האפשרות זמינה רק מול Supabase המקומי.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {demoAccounts.map((account) => (
                      <button key={account.role} type="button"
                        className="btn-secondary btn-sm justify-center"
                        aria-label={`כניסה כ${account.label}`}
                        disabled={busy}
                        onClick={() => {
                          setEmail(account.email);
                          setPassword(account.password);
                          void signInWithCredentials(account.email, account.password);
                        }}>
                        {account.label}
                      </button>
                    ))}
                  </div>
                </details>
              )}
              <button type="submit" className="btn-primary w-full" disabled={busy}>
                {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <Lock size={ICON.sm} aria-hidden="true" />}
                {busy ? 'מתחבר…' : 'התחברות'}
              </button>
              {providers.length > 0 && (
                <>
                  <div className="flex items-center gap-3" aria-hidden="true">
                    <span className="h-px flex-1 bg-line" />
                    <span className="text-xs text-ink-muted">או</span>
                    <span className="h-px flex-1 bg-line" />
                  </div>
                  {providers.map((provider) => (
                    <button key={provider} type="button" disabled={busy}
                      onClick={() => void continueWith(provider)}
                      className="btn min-h-12 w-full border border-line-strong bg-surface text-ink hover:bg-surface-hover">
                      {provider === 'google' && (
                        <img src="/brand/google-g.svg" alt="" width="18" height="18" aria-hidden="true" />
                      )}
                      המשך עם {FEDERATED_PROVIDER_LABEL[provider]}
                    </button>
                  ))}
                  {/* Neutral wording, because one door serves two people. A returning owner is
                      signed straight into their dashboard by the guard in `Signup.tsx` — naming
                      the button "פתיחת עסק" told them, wrongly, that pressing it opens a SECOND
                      business, so the person it works for was the one it scared off. A new owner
                      still names a business on /signup. The line below carries the warning that
                      the label used to: an employee who tries this arrives holding a session that
                      grants nothing (0205, #265). */}
                  <p className="text-center text-xs text-ink-muted">
                    בעלי עסק נכנסים כאן. הצטרפות לעסק קיים נעשית מהזמנה שנשלחה אליך.
                  </p>
                </>
              )}
              </form>
            </div>
          </section>
        </div>
      </Card>
      {/* Outside the card now, on the page canvas — flex+gap rather than space-x-3, because the
          app is RTL and space-x uses the physical axis. */}
      <div className="mt-5 flex justify-center gap-3 text-xs text-ink-muted">
        <Link to="/terms" className="hover:underline">תנאי שימוש</Link>
        <span aria-hidden>·</span>
        <Link to="/privacy" className="hover:underline">מדיניות פרטיות</Link>
      </div>
    </main>
  );
}

const replaceOpts = { replace: true };
