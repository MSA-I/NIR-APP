import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Loader2, MailQuestion } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { toHebrewError } from '../lib/errors';
import { APP_NAME } from '../lib/branding';

/**
 * Self-service password recovery (OPEN-DECISIONS #114, decided 08.08.2026).
 *
 * The success sentence is identical whether or not the address is registered — a login screen
 * must not double as a member directory. This is not a mask over an error: Supabase Auth itself
 * answers 200 for unknown addresses, so the only failures that reach `error` are real transport
 * or rate-limit failures, and those ARE shown, because "נשלח קישור" over a failed request would
 * be a false claim on screen.
 *
 * Delivery limitation, stated rather than hidden (#114): there is no verified sending domain
 * yet, so recovery mail rides Supabase's built-in mailer — rate-limited and unbranded. The
 * rate-limit failure is the one worth naming in the user's language.
 */
export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (err) {
      setError(/rate limit|too many/i.test(err.message)
        ? 'נשלחו יותר מדי בקשות איפוס. יש להמתין מספר דקות ולנסות שוב.'
        : toHebrewError(err.message));
      return;
    }
    setSent(true);
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-shell p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">{APP_NAME}</h1>
          <p className="text-shell-ink-dim mt-1 text-sm">איפוס סיסמה</p>
        </div>
        {sent ? (
          <div className="card card-pad space-y-3 text-center">
            <MailQuestion size={28} className="mx-auto text-ink-muted" aria-hidden />
            <p className="text-sm">
              אם הכתובת רשומה במערכת, נשלח אליה קישור לאיפוס הסיסמה. הקישור תקף לשעה.
            </p>
            <p className="text-sm text-ink-muted">
              לא הגיע מייל? בדקו את תיקיית הספאם, או פנו למפעיל המערכת.
            </p>
            <Link to="/login" className="btn-secondary w-full">חזרה למסך הכניסה</Link>
          </div>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} className="card card-pad space-y-4">
            <p className="text-sm text-ink-muted">
              הזינו את כתובת האימייל שאיתה נרשמתם — יישלח אליה קישור להגדרת סיסמה חדשה.
            </p>
            <div>
              <label className="label" htmlFor="email">אימייל</label>
              <input id="email" type="email" className="input" dir="ltr" autoComplete="username"
                value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            {error && <div role="alert" className="text-sm text-alert-solid">{error}</div>}
            <button type="submit" className="btn-primary w-full" disabled={busy || !email.trim()}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <MailQuestion size={15} />}
              שליחת קישור איפוס
            </button>
            <div className="text-center">
              <Link to="/login" className="text-sm text-ink-muted hover:text-ink underline underline-offset-2">
                חזרה למסך הכניסה
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
