import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Card, ICON } from '../components/ui';
import NewPasswordForm from '../components/NewPasswordForm';
import { supabase } from '../lib/supabase';
import { passwordPendingOf } from '../lib/password';
import { APP_NAME } from '../lib/branding';
import { useT } from '../lib/i18n/LocaleProvider';

type ScreenState = 'checking' | 'firstPassword' | 'changePassword' | 'noSession';

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
 * SO THE ORDER IS REVERSED. `public-signup` gives the admin create no password, so GoTrue generates
 * a random one nobody holds, and marks the owner `user_metadata.password_pending`. Nothing a
 * stranger typed can open that account, and nothing they typed was ever stored. The confirmation
 * link lands on `/auth/confirm`, which spends the token hash and sends a pending owner here — the
 * first moment a password anybody knows exists.
 *
 * IF THE READER CLOSES THIS SCREEN, nothing is lost and nothing is granted: they hold a session
 * because they proved the address, and the account's only password is still the generated one.
 * Coming back to `/` sends
 * them here again (`App.tsx` routes a pending session to this screen), and a new browser reaches
 * the same place through "forgot password" — which is why `/reset-password` clears the same flag.
 *
 * THE SECOND FRAMING, AND WHAT IT IS NOT (RC9 of the 03.09.2026 remediation plan). The route is
 * public, so a signed-in reader who already HAS a password can open it by typing the address. The
 * screen used to greet them with "the address is confirmed, now choose a password" — a sentence
 * that is simply false for them, and that describes a first password when what they are about to
 * do is replace an existing one.
 *
 * The fix is the wording, and deliberately nothing more. This is **not** an authorization gate and
 * must never be turned into one: a signed-in user already replaces their password with no
 * current-password field from `Settings.tsx`, and `/reset-password` does the same, so refusing
 * them here would close nothing and would state a protection that does not exist.
 * `passwordPendingOf` reads `user_metadata`, which the holder of the session can write
 * (`src/lib/password.ts`) — it is allowed to choose which sentence to show, and nothing else.
 * Both framings run exactly the same call, and closing the screen still loses nothing in either.
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
      if (!data.session) {
        setState('noSession');
        return;
      }
      // The same hint `App.tsx` routes on, read from the same place, so the screen a pending owner
      // is SENT to is the screen that greets them as one.
      setState(passwordPendingOf(data.session.user) ? 'firstPassword' : 'changePassword');
    });
    return () => { cancelled = true; };
  }, []);

  async function setPassword(password: string) {
    setBusy(true);
    setError(null);
    // The flag is cleared in the SAME call that sets the password. Two calls would leave a window
    // where the account has a password and still claims to be waiting for one. A reader who was
    // never pending clears a flag that is already false — one code path, and a no-op for them.
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

  const changing = state === 'changePassword';

  return (
    <div className="min-h-dvh flex items-center justify-center bg-action px-4 py-6 sm:py-10">
      <div className="w-full max-w-sm">
        {/* Same shape as the other standalone auth screens: the lockup is the mark, and the
            screen's own name is its single <h1>, in the app's one title class. The name follows
            the framing — a reader who already has a password is not choosing a first one. */}
        <div className="text-center mb-8">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="184" height="40"
            className="mx-auto h-auto w-44" />
          <h1 className="page-title mt-2 text-shell-ink">
            {t(changing ? 'setPassword.changeTitle' : 'setPassword.title')}
          </h1>
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

        {(state === 'firstPassword' || changing) && (
          <>
            <p className="mb-4 text-center text-sm text-shell-ink-soft">
              {t(changing ? 'setPassword.changeIntro' : 'setPassword.intro')}
            </p>
            <NewPasswordForm idPrefix="set-password" busy={busy} error={error}
              submitLabel={t(changing ? 'setPassword.changeAction' : 'setPassword.action')}
              onEdit={() => setError(null)}
              onValidPassword={(password) => void setPassword(password)} />
            {/* Only the second framing offers the way out: a pending owner has nowhere else to be
                yet, while this reader arrived at a public address by hand and has a product to
                return to. Leaving still loses nothing — the existing password stands. */}
            {changing && (
              <p className="mt-4 text-center">
                <Link to="/" className="text-sm text-shell-ink-soft hover:text-shell-ink underline underline-offset-2">
                  {t('setPassword.backToApp')}
                </Link>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
