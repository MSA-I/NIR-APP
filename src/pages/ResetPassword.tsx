import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { KeyRound, Loader2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME } from '../lib/branding';
import { toHebrewError } from '../lib/errors';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';
import { supabase } from '../lib/supabase';

export default function ResetPassword() {
  const { session, loading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblem(password, confirmation);
    setError(problem);
    if (problem) return;
    setBusy(true);
    const updated = await supabase.auth.updateUser({ password });
    if (updated.error) {
      setBusy(false);
      setError(toHebrewError(updated.error));
      return;
    }
    const signedOut = await supabase.auth.signOut({ scope: 'global' });
    if (signedOut.error) {
      await supabase.auth.signOut({ scope: 'local' });
      setBusy(false);
      setError('הסיסמה נשמרה, אך לא ניתן היה לנתק את כל החיבורים. התחבר מחדש ופנה למנהל המערכת אם חיבור ישן עדיין פעיל.');
      return;
    }
    navigate('/login?reset=success', { replace: true });
  }

  return (
    <main className="min-h-screen bg-shell p-4 grid place-items-center">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-bold text-white">{APP_NAME}</h1>
        <section className="card card-pad" aria-labelledby="reset-title">
          <h2 id="reset-title" className="page-title">הגדרת סיסמה חדשה</h2>
          {loading ? (
            <p role="status" className="mt-4 text-sm text-ink-soft">מאמת את קישור השחזור…</p>
          ) : !session ? (
            <div className="mt-4 space-y-4">
              <p role="alert" className="text-sm text-ink-soft">קישור השחזור אינו תקף או שפג תוקפו. ניתן לבקש קישור חדש.</p>
              <Link className="btn-primary w-full" to="/forgot-password">בקשת קישור חדש</Link>
            </div>
          ) : (
            <form className="mt-4 space-y-4" onSubmit={(event) => void submit(event)}>
              <div>
                <label className="label" htmlFor="recovery-password">סיסמה חדשה ({MIN_PASSWORD_LENGTH} תווים לפחות)</label>
                <input id="recovery-password" className="input" type="password" dir="ltr" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required
                  value={password} onChange={(event) => setPassword(event.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="recovery-password-confirm">אימות סיסמה</label>
                <input id="recovery-password-confirm" className="input" type="password" dir="ltr" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH} required
                  value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
              </div>
              {error && <p role="alert" className="text-sm text-alert-solid">{error}</p>}
              <button className="btn-primary w-full" type="submit" disabled={busy}>
                {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
                שמירת הסיסמה וניתוק כל החיבורים
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
