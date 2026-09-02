import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { KeyRound, Loader2 } from 'lucide-react';
import { Card, ICON } from '../components/ui';
import { authCallbackFragment, supabase } from '../lib/supabase';
import { MIN_PASSWORD_LENGTH, passwordProblemOf } from '../lib/password';
import { APP_NAME } from '../lib/branding';

type LinkState = 'checking' | 'ready' | 'invalid' | 'done';

/**
 * Landing page of the recovery link (OPEN-DECISIONS #114).
 *
 * GoTrue's /verify redirect delivers either tokens (supabase-js exchanges them into a session
 * and fires onAuthStateChange) or an error_code in the hash — a consumed or expired link never
 * carries tokens. supabase.ts scrubs that fragment from the address bar as the client is created
 * and keeps it in `authCallbackFragment`, which is what this page reads. The page therefore has
 * exactly three honest states: a form when a session
 * exists, "the link is dead" when it provably is, and a short wait while the exchange runs.
 * The wait is bounded: tokens that never became a session within 8s are reported as a dead
 * link rather than a spinner that never resolves.
 */
export default function ResetPassword() {
  const { errorText, t } = useT();
  const navigate = useNavigate();
  const [state, setState] = useState<LinkState>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = authCallbackFragment; // supabase.ts scrubbed the address bar; this is what the link carried
    if (hash.get('error_code') || hash.get('error')) {
      setState('invalid');
      return;
    }
    const expectingTokens = hash.has('access_token');
    let cancelled = false;
    const markReady = () => setState((current) => (current === 'checking' ? 'ready' : current));

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled && session) markReady();
    });
    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) markReady();
      // Tokens still in the hash: supabase-js is mid-exchange; onAuthStateChange will land.
      else if (!expectingTokens) setState('invalid');
    });
    const deadline = expectingTokens
      ? window.setTimeout(() => {
          if (!cancelled) setState((current) => (current === 'checking' ? 'invalid' : current));
        }, 8000)
      : undefined;

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      if (deadline !== undefined) window.clearTimeout(deadline);
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const problem = passwordProblemOf(password, confirm);
    setError(problem && t(problem.key, problem.vars));
    if (problem) return;
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(errorText(updateError.message));
      return;
    }
    setState('done');
    const signedOut = await supabase.auth.signOut({ scope: 'global' });
    setBusy(false);
    if (signedOut.error) {
      await supabase.auth.signOut({ scope: 'local' });
      setError(t('resetPasswordTail.signOutFailed'));
      return;
    }
    navigate('/login?reset=success', { replace: true });
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-action px-4 py-6 sm:py-10">
      <div className="w-full max-w-sm">
        {/* Same shape as the other three standalone auth screens: the lockup is the mark, and the
            screen's own name is its single <h1>, in the app's one title class. */}
        <div className="text-center mb-8">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="184" height="40"
            className="mx-auto h-auto w-44" />
          <h1 className="page-title mt-2 text-shell-ink">{t('resetPasswordTail.title')}</h1>
        </div>

        {state === 'checking' && (
          <Card className="text-center">
            <Loader2 size={ICON.xl} className="animate-spin mx-auto text-ink-muted" aria-hidden />
            <p className="text-sm text-ink-muted mt-2">{t('resetPasswordTail.checking')}</p>
          </Card>
        )}

        {state === 'invalid' && (
          <Card className="space-y-3 text-center">
            <p className="text-sm">{t('resetPasswordTail.invalidLink')}</p>
            <Link to="/forgot-password" className="btn-primary w-full">{t('resetPasswordTail.sendNewLink')}</Link>
            <Link to="/login" className="text-sm text-ink-muted hover:text-ink underline underline-offset-2">
              {t('resetPasswordTail.backToLogin')}
            </Link>
          </Card>
        )}

        {state === 'ready' && (
          <Card as="form" onSubmit={(event: FormEvent) => void onSubmit(event)} className="space-y-4">
            <div>
              <label className="label" htmlFor="reset-password-new">
                {t('resetPasswordTail.newPasswordLabel', { min: MIN_PASSWORD_LENGTH })}
              </label>
              {/* `passwordProblem` judges the pair, so both boxes are marked and both point at the
                  one message — the field that failed is no longer left for the reader to guess. */}
              <input id="reset-password-new" type="password" className="input" dir="ltr"
                autoComplete="new-password" value={password}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'reset-password-problem' : undefined}
                onChange={(event) => { setPassword(event.target.value); setError(null); }} required />
            </div>
            <div>
              <label className="label" htmlFor="reset-password-confirm">{t('resetPasswordTail.confirmPassword')}</label>
              <input id="reset-password-confirm" type="password" className="input" dir="ltr"
                autoComplete="new-password" value={confirm}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'reset-password-problem' : undefined}
                onChange={(event) => { setConfirm(event.target.value); setError(null); }} required />
            </div>
            {error && <div id="reset-password-problem" role="alert" className="text-sm text-alert-fg">{error}</div>}
            <button type="submit" className="btn-primary w-full" disabled={busy || !password || !confirm}>
              {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <KeyRound size={ICON.sm} aria-hidden="true" />}
              {t('resetPasswordTail.changePassword')}
            </button>
          </Card>
        )}

        {state === 'done' && (
          <Card className="space-y-3 text-center">
            <p className="text-sm">{error ?? t('resetPasswordTail.changedRedirecting')}</p>
            <button className="btn-primary w-full" onClick={() => navigate('/login', { replace: true })}>
              {t('resetPasswordTail.backToLogin')}
            </button>
          </Card>
        )}
      </div>
    </div>
  );
}
