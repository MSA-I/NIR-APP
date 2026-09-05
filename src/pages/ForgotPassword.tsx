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
/**
 * ENTRY-07 — the rate-limit branch used to test `/rate limit|too many/i` against `err.message`,
 * and GoTrue's throttle message contains neither phrase. What it really sends, captured on the
 * live site 2026-09-04 (`docs/qa/2026-09-04/entry.json`):
 *
 *   { "code": "429", "error_code": "over_email_send_rate_limit",
 *     "msg": "For security purposes, you can only request this after 55 seconds." }
 *
 * So the branch never ran, and a visitor throttled for under a minute was told the operation
 * had failed and to contact support.
 *
 * Match on the STATUS, not on prose. Which field carries the code depends on a response header:
 * with `x-supabase-api-version: 2024-01-01` supabase-js reads `data.code` (the string "429"),
 * otherwise `data.error_code`. A fix keyed to either field alone is live in one deployment and
 * dead in the next; `status` is 429 in both. The code list and the prose test stay behind it as
 * fallbacks, so a future transport that omits the status still lands here.
 */
const RATE_LIMIT_CODES = new Set([
  'over_email_send_rate_limit',
  'over_request_rate_limit',
  'over_sms_send_rate_limit',
]);

function isRateLimited(err: { status?: number; code?: string; message: string }): boolean {
  if (err.status === 429) return true;
  if (err.code && RATE_LIMIT_CODES.has(err.code)) return true;
  return /rate limit|too many/i.test(err.message);
}

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
      setError(isRateLimited(err) ? t('forgotPassword.rateLimited') : errorText(err.message));
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
            {/* The way back, at the product's own 44px floor. Measured 04.09.2026 at 390x844 it
                was 19px (`ENTRY-12`) — and this is the only control on the screen for somebody who
                has arrived here by mistake, which is most of the people who arrive here. */}
            <div className="text-center">
              <Link to="/login"
                className="inline-flex min-h-11 items-center text-sm text-ink-muted hover:text-ink underline underline-offset-2">
                {t('forgotPassword.backToLogin')}
              </Link>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
