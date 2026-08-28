import { useT } from '../lib/i18n/LocaleProvider';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Loader2, MailQuestion } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Card, ICON } from '../components/ui';
import { APP_NAME } from '../lib/branding';

/**
 * Self-service password recovery (OPEN-DECISIONS #114, decided 09.08.2026).
 *
 * The success sentence ("אם קיימת כתובת תואמת") is identical whether or not the address is
 * registered — a login screen
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
  const { errorText, t } = useT();
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
        ? t('forgotPassword.rateLimited')
        : errorText(err.message));
      return;
    }
    setSent(true);
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-action px-4 py-6 sm:py-10">
      <div className="w-full max-w-sm">
        {/* Same shape as the other three standalone auth screens: the lockup is the mark, and the
            screen's own name is its single <h1>, in the app's one title class. */}
        <div className="text-center mb-8">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="184" height="40"
            className="mx-auto h-auto w-44" />
          <h1 className="page-title mt-2 text-shell-ink">{t('forgotPassword.title')}</h1>
        </div>
        {sent ? (
          <Card className="space-y-3 text-center">
            <MailQuestion size={ICON.hero} className="mx-auto text-ink-muted" aria-hidden />
            <p className="text-sm">
              {t('forgotPassword.sentNotice')}
            </p>
            <p className="text-sm text-ink-muted">
              {t('forgotPassword.notReceived')}
            </p>
            <Link to="/login" className="btn-secondary w-full">{t('forgotPassword.backToLogin')}</Link>
          </Card>
        ) : (
          <Card as="form" onSubmit={(e: FormEvent) => void onSubmit(e)} className="space-y-4">
            <p className="text-sm text-ink-muted">
              {t('forgotPassword.instructions')}
            </p>
            <div>
              <label className="label" htmlFor="email">{t('forgotPassword.email')}</label>
              <input id="email" type="email" className="input" dir="ltr" autoComplete="username"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'forgot-password-problem' : undefined}
                value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            {error && <div id="forgot-password-problem" role="alert" className="text-sm text-alert-fg">{error}</div>}
            <button type="submit" className="btn-primary w-full" disabled={busy || !email.trim()}>
              {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <MailQuestion size={ICON.sm} aria-hidden="true" />}
              {t('forgotPassword.sendResetLink')}
            </button>
            <div className="text-center">
              <Link to="/login" className="text-sm text-ink-muted hover:text-ink underline underline-offset-2">
                {t('forgotPassword.backToLogin')}
              </Link>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
