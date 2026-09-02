import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Card, ICON } from '../components/ui';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../lib/branding';
import { useT } from '../lib/i18n/LocaleProvider';
import { confirmDestination, confirmTypeOf, otpTypeOf } from '../lib/authConfirm';
import { passwordPendingOf } from '../lib/password';

/**
 * `/auth/confirm` — the one address every e-mail Supabase Auth sends now points at.
 *
 * WHY IT EXISTS AT ALL. The client moved to PKCE (`src/lib/supabase.ts`), which keeps tokens out of
 * the address bar but stores a code verifier in the browser that STARTED the flow. A mail opened on
 * a phone was started nowhere, so a PKCE `code=` link would fail there — and "the link works on my
 * laptop but not on my phone" is the worst possible failure for a recovery mail. A token hash has
 * no such tie: it is a one-time secret from the mail, spendable in any browser, which is why every
 * template links here with `token_hash` and `type` instead (`docs/auth-email-templates/`).
 *
 * WHAT THIS SCREEN OWES THE READER. Nothing but speed and an honest failure. It spends the hash,
 * and then sends the person where they were going: a recovery link to `/reset-password`, an
 * invitation back to the invitation it came from, and a fresh owner to `/set-password` — because
 * under owner ruling #332 the only password on their account is one GoTrue generated. The rule is
 * `src/lib/authConfirm.ts`, where `next` is checked against this origin: a redirect target read out
 * of a URL is an open redirect, and this one would come with a session already established.
 *
 * A dead link is said plainly. `verifyOtp` refuses a hash that was already spent or has expired,
 * and the reader is told which door to knock on next rather than being left on a spinner.
 */
export default function AuthConfirm() {
  const { t } = useT();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [failed, setFailed] = useState(false);

  // Read as primitives so the effect depends on the link, not on the identity of the params object.
  const tokenHash = params.get('token_hash');
  const rawType = params.get('type');
  const next = params.get('next');

  useEffect(() => {
    const type = confirmTypeOf(rawType);
    if (!tokenHash || !type) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash: tokenHash,
        type: otpTypeOf(type),
      });
      if (cancelled) return;
      if (error || !data.session) {
        setFailed(true);
        return;
      }
      navigate(
        confirmDestination({
          type,
          next,
          origin: window.location.origin,
          passwordPending: passwordPendingOf(data.user ?? data.session.user),
        }),
        { replace: true },
      );
    })();
    return () => { cancelled = true; };
  }, [tokenHash, rawType, next, navigate]);

  return (
    <div className="min-h-dvh flex items-center justify-center bg-action px-4 py-6 sm:py-10">
      <div className="w-full max-w-sm">
        {/* Same shape as the other standalone auth screens: the lockup is the mark, and the
            screen's own name is its single <h1>, in the app's one title class. */}
        <div className="text-center mb-8">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="184" height="40"
            className="mx-auto h-auto w-44" />
          <h1 className="page-title mt-2 text-shell-ink">{t('authConfirm.title')}</h1>
        </div>

        {failed ? (
          <Card className="space-y-3 text-center">
            <p className="text-sm">{t('authConfirm.invalidLink')}</p>
            <Link to="/forgot-password" className="btn-primary w-full">{t('authConfirm.sendNewLink')}</Link>
            <Link to="/login" className="text-sm text-ink-muted hover:text-ink underline underline-offset-2">
              {t('authConfirm.backToLogin')}
            </Link>
          </Card>
        ) : (
          <Card className="text-center">
            <Loader2 size={ICON.xl} className="animate-spin mx-auto text-ink-muted" aria-hidden />
            <p className="text-sm text-ink-muted mt-2">{t('authConfirm.checking')}</p>
          </Card>
        )}
      </div>
    </div>
  );
}
