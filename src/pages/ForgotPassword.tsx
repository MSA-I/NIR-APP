import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Loader2, Mail } from 'lucide-react';
import { APP_NAME } from '../lib/branding';
import { toHebrewError } from '../lib/errors';
import { supabase } from '../lib/supabase';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (result.error) {
      setError(toHebrewError(result.error));
      return;
    }
    setSent(true);
  }

  return (
    <main className="min-h-screen bg-shell p-4 grid place-items-center">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-bold text-white">{APP_NAME}</h1>
        <section className="card card-pad" aria-labelledby="forgot-title">
          <h2 id="forgot-title" className="page-title">שחזור גישה לחשבון</h2>
          {sent ? (
            <div className="mt-4 space-y-4">
              <p role="status" className="text-sm text-ink-soft">אם קיימת כתובת תואמת, נשלח אליה קישור חד־פעמי להגדרת סיסמה חדשה.</p>
              <Link className="btn-secondary w-full" to="/login">חזרה לכניסה</Link>
            </div>
          ) : (
            <form className="mt-4 space-y-4" onSubmit={(event) => void submit(event)}>
              <p className="text-sm text-ink-soft">יש להזין את כתובת המייל של החשבון. מטעמי אבטחה לא נציין אם הכתובת קיימת במערכת.</p>
              <div>
                <label className="label" htmlFor="recovery-email">אימייל</label>
                <input id="recovery-email" className="input" type="email" dir="ltr" autoComplete="email" required
                  value={email} onChange={(event) => setEmail(event.target.value)} />
              </div>
              {error && <p role="alert" className="text-sm text-alert-solid">{error}</p>}
              <button className="btn-primary w-full" type="submit" disabled={busy}>
                {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}
                שליחת קישור מאובטח
              </button>
              <Link className="btn-ghost w-full" to="/login">ביטול</Link>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
