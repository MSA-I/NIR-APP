import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { KeyRound, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';
import { toHebrewError } from '../lib/errors';
import { APP_NAME } from '../lib/branding';

type LinkState = 'checking' | 'ready' | 'invalid' | 'done';

/**
 * Landing page of the recovery link (OPEN-DECISIONS #114).
 *
 * GoTrue's /verify redirect delivers either tokens (supabase-js exchanges them into a session
 * and fires onAuthStateChange) or an error_code in the hash — a consumed or expired link never
 * carries tokens. The page therefore has exactly three honest states: a form when a session
 * exists, "the link is dead" when it provably is, and a short wait while the exchange runs.
 * The wait is bounded: tokens that never became a session within 8s are reported as a dead
 * link rather than a spinner that never resolves.
 */
export default function ResetPassword() {
  const navigate = useNavigate();
  const [state, setState] = useState<LinkState>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
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
    const problem = passwordProblem(password, confirm);
    setError(problem);
    if (problem) return;
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(toHebrewError(updateError.message));
      return;
    }
    setState('done');
    const signedOut = await supabase.auth.signOut({ scope: 'global' });
    setBusy(false);
    if (signedOut.error) {
      await supabase.auth.signOut({ scope: 'local' });
      setError('הסיסמה הוחלפה, אך לא ניתן היה לנתק את כל החיבורים. יש להתחבר מחדש ולפנות למנהל המערכת אם חיבור ישן עדיין פעיל.');
      return;
    }
    navigate('/login?reset=success', { replace: true });
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-action p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-semibold text-on-solid">{APP_NAME}</h1>
          <p className="text-shell-ink-dim mt-1 text-sm">הגדרת סיסמה חדשה</p>
        </div>

        {state === 'checking' && (
          <div className="card card-pad text-center">
            <Loader2 size={22} className="animate-spin mx-auto text-ink-muted" aria-hidden />
            <p className="text-sm text-ink-muted mt-2">בודק את קישור האיפוס…</p>
          </div>
        )}

        {state === 'invalid' && (
          <div className="card card-pad space-y-3 text-center">
            <p className="text-sm">הקישור אינו תקין או שפג תוקפו. קישור איפוס תקף לשעה וניתן לשימוש פעם אחת.</p>
            <Link to="/forgot-password" className="btn-primary w-full">שליחת קישור חדש</Link>
            <Link to="/login" className="text-sm text-ink-muted hover:text-ink underline underline-offset-2">
              חזרה למסך הכניסה
            </Link>
          </div>
        )}

        {state === 'ready' && (
          <form onSubmit={(event) => void onSubmit(event)} className="card card-pad space-y-4">
            <div>
              <label className="label" htmlFor="reset-password-new">
                סיסמה חדשה ({MIN_PASSWORD_LENGTH} תווים לפחות)
              </label>
              <input id="reset-password-new" type="password" className="input" dir="ltr"
                autoComplete="new-password" value={password}
                onChange={(event) => { setPassword(event.target.value); setError(null); }} required />
            </div>
            <div>
              <label className="label" htmlFor="reset-password-confirm">אימות סיסמה</label>
              <input id="reset-password-confirm" type="password" className="input" dir="ltr"
                autoComplete="new-password" value={confirm}
                onChange={(event) => { setConfirm(event.target.value); setError(null); }} required />
            </div>
            {error && <div role="alert" className="text-sm text-alert-fg">{error}</div>}
            <button type="submit" className="btn-primary w-full" disabled={busy || !password || !confirm}>
              {busy ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={15} />}
              החלפת סיסמה
            </button>
          </form>
        )}

        {state === 'done' && (
          <div className="card card-pad space-y-3 text-center">
            <p className="text-sm">{error ?? 'הסיסמה הוחלפה. מנתק את החיבורים הישנים ומעביר למסך הכניסה…'}</p>
            <button className="btn-primary w-full" onClick={() => navigate('/login', { replace: true })}>
              חזרה למסך הכניסה
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
