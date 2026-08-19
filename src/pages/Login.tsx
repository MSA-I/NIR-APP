import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { useAuth, homeFor } from '../auth/AuthContext';
import { toHebrewError } from '../lib/errors';
import { APP_NAME } from '../lib/branding';
import { startAurora } from '../lib/loginAurora';

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
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const auroraRef = useRef<HTMLCanvasElement>(null);
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await signIn(email.trim(), password);
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

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center bg-canvas p-4 sm:p-6">
      {/* One card holds both halves, instead of two objects floating in a full-viewport petrol
          field. The colour is now a bounded panel inside the card rather than the whole screen —
          which is also what stops it from reading as decorative expanse (PRODUCT.md). */}
      <div className="card w-full max-w-5xl overflow-hidden">
        <div className="lg:grid lg:grid-cols-[2fr_3fr]">
          {/* Nothing is authenticated here, so there is no tenant to name — the login screen
              wears the product's identity, and the tenant's appears after sign-in.
              On a phone this collapses to a banner: the fold belongs to the form. */}
          <div className="aurora-pane h-44 lg:h-auto">
            <canvas ref={auroraRef} aria-hidden="true" className="absolute inset-0 size-full" />
            <div className="relative z-10 flex h-full flex-col justify-between p-6 lg:p-10">
              <div className="flex items-center gap-2.5">
                <img src="/brand/inplace-symbol-paper.svg" alt="" width="28" height="28" className="size-7" />
                <h1 className="text-xl font-semibold text-white">{APP_NAME}</h1>
              </div>
              <div>
                {/* shell-ink, never -soft or -dim: on the ramp's brightest stop those measure
                    3.62:1 and worse, while shell-ink holds 4.83:1. */}
                <p className="text-shell-ink text-xs">כניסה מאובטחת לסביבת העבודה</p>
                <p className="mt-2 text-2xl leading-tight font-semibold text-white lg:text-3xl">
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
          </div>
          <div className="p-6 sm:p-8 lg:p-10">
            <h2 className="text-2xl font-semibold text-ink">כניסה לחשבון</h2>
            <p className="mt-1 text-sm text-ink-muted">הזינו את פרטי המשתמש כדי להמשיך.</p>
            <form onSubmit={(e) => void onSubmit(e)} className="mt-6 space-y-5" aria-busy={busy || undefined}>
              {params.get('reset') === 'success' && (
                <p role="status" className="note-done">הסיסמה הוחלפה וכל החיבורים נותקו. אפשר להתחבר מחדש.</p>
              )}
              <div>
                <label className="label" htmlFor="email">אימייל</label>
                <input id="email" type="email" className="input" dir="ltr" autoComplete="username"
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
                    value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <button type="button" onClick={() => setShowPassword((current) => !current)}
                    className="absolute inset-y-0 end-0 flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                    aria-label={showPassword ? 'הסתרת סיסמה' : 'הצגת סיסמה'} aria-pressed={showPassword}>
                    {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
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
              {error && <div role="alert" className="note-alert">{error}</div>}
              {import.meta.env.DEV && demoAccounts.length > 0 && (
                <details className="rounded-lg border border-shell-ink/15 bg-shell-ink/5 px-3 py-2 text-start">
                  <summary className="min-h-11 cursor-pointer content-center text-sm font-medium text-ink">
                    חשבונות דמו מקומיים
                  </summary>
                  <p className="mb-2 text-xs text-ink-muted">
                    ממלא את פרטי החשבון לבדיקה. האפשרות זמינה רק מול Supabase המקומי.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {demoAccounts.map((account) => (
                      <button key={account.role} type="button"
                        className="btn-secondary min-h-11 justify-center px-2 text-xs"
                        aria-label={`מילוי פרטי ${account.label}`}
                        onClick={() => {
                          setEmail(account.email);
                          setPassword(account.password);
                          setError(null);
                        }}>
                        {account.label}
                      </button>
                    ))}
                  </div>
                </details>
              )}
              <button type="submit" className="btn-primary w-full" disabled={busy}>
                {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Lock size={15} aria-hidden="true" />}
                {busy ? 'מתחבר…' : 'התחברות'}
              </button>
            </form>
          </div>
        </div>
      </div>
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
