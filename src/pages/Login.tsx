import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { Eye, EyeOff, Loader2, Lock } from 'lucide-react';
import { useAuth, homeFor } from '../auth/AuthContext';
import { APP_NAME } from '../lib/branding';

export default function Login() {
  const { signIn, session, profile, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (!loading && session && profile) return <Navigate to={homeFor(profile.role)} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const err = await signIn(email.trim(), password);
    setBusy(false);
    if (err) {
      setError(err === 'Invalid login credentials' ? 'אימייל או סיסמה שגויים' : err);
    } else {
      navigate('/', replaceOpts);
    }
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-shell p-4">
      <div className="w-full max-w-sm">
        {/* Nothing is authenticated here, so there is no tenant to name — the login
            screen wears the product's identity, and the tenant's appears after sign-in. */}
        <div className="text-center mb-8">
          <img src="/icons/icon-192.png" alt="" width="52" height="52"
            className="mx-auto mb-3 size-13 rounded-xl shadow-menu" />
          <h1 className="text-3xl font-bold text-white">{APP_NAME}</h1>
          <p className="text-shell-ink-soft mt-1 text-sm">רכש, חשבוניות ותשלומים במקום אחד</p>
          <p className="text-shell-ink-dim mt-2 text-xs">כניסה מאובטחת לסביבת העבודה</p>
        </div>
        <form onSubmit={(e) => void onSubmit(e)} className="card card-pad space-y-5" aria-busy={busy || undefined}>
          <div>
            <label className="label" htmlFor="email">אימייל</label>
            <input id="email" type="email" className="input" dir="ltr" autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="password">סיסמה</label>
            <div className="relative">
              <input id="password" type={showPassword ? 'text' : 'password'} className="input pe-12" dir="ltr" autoComplete="current-password"
                value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" onClick={() => setShowPassword((current) => !current)}
                className="absolute inset-y-0 end-0 flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                aria-label={showPassword ? 'הסתרת סיסמה' : 'הצגת סיסמה'} aria-pressed={showPassword}>
                {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </div>
          </div>
          {error && <div role="alert" className="note-alert">{error}</div>}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Lock size={15} aria-hidden="true" />}
            {busy ? 'מתחבר…' : 'התחברות'}
          </button>
          <div className="text-center">
            <Link to="/forgot-password" className="text-sm text-ink-muted hover:text-ink underline underline-offset-2">
              שכחתי סיסמה
            </Link>
          </div>
        </form>
        <div className="mt-4 text-center text-xs text-shell-ink-dim space-x-3">
          <Link to="/terms" className="hover:underline">תנאי שימוש</Link>
          <span aria-hidden>·</span>
          <Link to="/privacy" className="hover:underline">מדיניות פרטיות</Link>
        </div>
      </div>
    </main>
  );
}

const replaceOpts = { replace: true };
