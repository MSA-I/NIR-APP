import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Card, ICON } from '../components/ui';
import NewPasswordForm from '../components/NewPasswordForm';
import { supabase } from '../lib/supabase';
import { APP_NAME } from '../lib/branding';
import { useT } from '../lib/i18n/LocaleProvider';

type ScreenState = 'checking' | 'ready' | 'noSession';

/**
 * `/set-password` — the screen owner ruling #332 created, and the reason the signup form no longer
 * asks for a password.
 *
 * THE ATTACK IT CLOSES. Signup used to create the auth account WITH the password typed into an
 * anonymous form, against an address nobody had proved. A stranger could therefore pre-register
 * your address with their password; the confirmation mail went to YOU, and the moment you clicked
 * it the account went live — as the owner of an organization, with their password on it. That is
 * account pre-hijacking, and it was finding 4 of the 02.09.2026 security scan.
 *
 * SO THE ORDER IS REVERSED. `public-signup` creates the owner with no password at all and marks
 * them `user_metadata.password_pending`; until the address is confirmed there is nothing to sign in
 * with, and nothing a stranger can have set. The confirmation link lands on `/auth/confirm`, which
 * spends the token hash and sends a pending owner here. This is the first moment a password exists.
 *
 * IF THE READER CLOSES THIS SCREEN, nothing is lost and nothing is granted: they hold a session
 * because they proved the address, and the account still has no password. Coming back to `/` sends
 * them here again (`App.tsx` routes a pending session to this screen), and a new browser reaches
 * the same place through "forgot password" — which is why `/reset-password` clears the same flag.
 */
export default function SetPassword() {
  const { errorText, t } = useT();
  const [state, setState] = useState<ScreenState>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setState(data.session ? 'ready' : 'noSession');
    });
    return () => { cancelled = true; };
  }, []);

  async function setPassword(password: string) {
    setBusy(true);
    setError(null);
    // The flag is cleared in the SAME call that sets the password. Two calls would leave a window
    // where the account has a password and still claims to be waiting for one.
    const { error: updateError } = await supabase.auth.updateUser({
      password,
      data: { password_pending: false },
    });
    if (updateError) {
      setBusy(false);
      setError(errorText(updateError.message));
      return;
    }
    // A full document load, for `AcceptInvite`'s reason: AuthContext reads the session once per
    // change, and the metadata that decides where a pending owner is sent has just changed.
    window.location.replace('/');
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-action px-4 py-6 sm:py-10">
      <div className="w-full max-w-sm">
        {/* Same shape as the other standalone auth screens: the lockup is the mark, and the
            screen's own name is its single <h1>, in the app's one title class. */}
        <div className="text-center mb-8">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="184" height="40"
            className="mx-auto h-auto w-44" />
          <h1 className="page-title mt-2 text-shell-ink">{t('setPassword.title')}</h1>
        </div>

        {state === 'checking' && (
          <Card className="text-center">
            <Loader2 size={ICON.xl} className="animate-spin mx-auto text-ink-muted" aria-hidden />
            <p className="text-sm text-ink-muted mt-2">{t('setPassword.checking')}</p>
          </Card>
        )}

        {state === 'noSession' && (
          <Card className="space-y-3 text-center">
            <p className="text-sm">{t('setPassword.needsConfirmedLink')}</p>
            <Link to="/forgot-password" className="btn-primary w-full">{t('setPassword.sendNewLink')}</Link>
            <Link to="/login" className="text-sm text-ink-muted hover:text-ink underline underline-offset-2">
              {t('setPassword.backToLogin')}
            </Link>
          </Card>
        )}

        {state === 'ready' && (
          <>
            <p className="mb-4 text-center text-sm text-shell-ink-soft">{t('setPassword.intro')}</p>
            <NewPasswordForm idPrefix="set-password" busy={busy} error={error}
              submitLabel={t('setPassword.action')}
              onEdit={() => setError(null)}
              onValidPassword={(password) => void setPassword(password)} />
          </>
        )}
      </div>
    </div>
  );
}
