import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import { useAuth, homeFor } from '../auth/AuthContext';
import { APP_NAME } from '../lib/branding';

export default function Login() {
  const { signIn, session, profile, loading } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <div className="min-h-screen flex items-center justify-center bg-shell p-4">
      <div className="w-full max-w-sm">
        {/* Nothing is authenticated here, so there is no tenant to name — the login
            screen wears the product's identity, and the tenant's appears after sign-in. */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">{APP_NAME}</h1>
          <p className="text-ink-faint mt-1 text-sm">מערכת ניהול רכש, חשבוניות ותשלומים</p>
        </div>
        <form onSubmit={(e) => void onSubmit(e)} className="card card-pad space-y-4">
          <div>
            <label className="label" htmlFor="email">אימייל</label>
            <input id="email" type="email" className="input" dir="ltr" autoComplete="username"
              value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="password">סיסמה</label>
            <input id="password" type="password" className="input" dir="ltr" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="text-sm text-alert-solid">{error}</div>}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Lock size={15} />}
            התחברות
          </button>
        </form>
      </div>
    </div>
  );
}

const replaceOpts = { replace: true };
