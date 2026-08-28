import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { AlertCircle, Loader2, MailCheck, ShieldCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Card, ICON } from '../components/ui';
import { toHebrewError } from '../lib/errors';
import { APP_NAME } from '../lib/branding';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';
import {
  acceptOperatorInvitation, lookupOperatorInvitation, type InvitationLookup,
} from '../lib/platform';

/**
 * Joining the platform team — the door 0215 opened.
 *
 * It is a PUBLIC route in the tenant application, not a screen in the operator console, and that
 * is forced rather than chosen: the person holding this link has no account and no authority, so
 * the console's guard would bounce them before anything rendered.
 *
 * The flow mirrors `AcceptInvite` deliberately, because it is the same problem: sign the person
 * up, then turn that fresh session into membership. What differs is what membership means. This
 * writes no `profiles` row and joins no organization — an operator is staff, not a tenant user,
 * and the two axes stay apart all the way down to the command (`accept_platform_operator_invitation`).
 */
export default function AcceptOperatorInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [lookup, setLookup] = useState<InvitationLookup | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmEmailSent, setConfirmEmailSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) { setLookup({ status: 'unknown' }); setLoading(false); return; }
      try {
        const result = await lookupOperatorInvitation(token);
        if (!cancelled) setLookup(result);
      } catch {
        if (!cancelled) setLookup({ status: 'unknown' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const problem = passwordProblem(password, confirm);
    if (problem) { setFormError(problem); return; }

    setBusy(true);
    try {
      const email = lookup!.email!;
      // The account may already exist if a previous attempt signed up but did not finish. Same
      // recovery as the tenant flow: sign in with what they just typed.
      let { data: auth, error } = await supabase.auth.signUp({ email, password });
      if (error && /already registered|already exists/i.test(error.message)) {
        const retry = await supabase.auth.signInWithPassword({ email, password });
        auth = retry.data;
        error = retry.error;
      }
      if (error) {
        setFormError(
          /Invalid login credentials/i.test(error.message)
            ? 'קיים כבר חשבון לכתובת הזו, והסיסמה שהוזנה אינה נכונה.'
            : toHebrewError(error),
        );
        return;
      }
      // No session means the project requires email confirmation. The window here is fifteen
      // minutes, so say so plainly rather than implying the link will wait.
      if (!auth?.session) { setConfirmEmailSent(true); return; }

      await acceptOperatorInvitation(token);
      // Full reload into the console: it is a separate application on this origin, and the
      // session that was just established is what the guard will read.
      window.location.replace('/operator');
    } catch (error) {
      setFormError(toHebrewError(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Shell>
        <Card className="flex justify-center py-10 text-ink-faint">
          <Loader2 size={ICON.xl} className="animate-spin" aria-label="טוען" />
        </Card>
      </Shell>
    );
  }

  if (lookup?.status !== 'valid') {
    const message = {
      expired: 'תוקף ההזמנה פג. ההזמנות לצוות תקפות לחמש עשרה דקות בלבד — יש לבקש קישור חדש.',
      revoked: 'ההזמנה בוטלה.',
      accepted: 'ההזמנה כבר נוצלה. אפשר להיכנס עם החשבון שנפתח.',
      unknown: 'הקישור אינו תקין.',
      valid: '',
    }[lookup?.status ?? 'unknown'];
    return (
      <Shell>
        <Card className="space-y-4 text-center">
          <AlertCircle size={ICON.hero} className="mx-auto text-alert-fg" aria-hidden="true" />
          <p className="text-ink">{message}</p>
          <Link to="/login" className="btn-secondary">למסך הכניסה</Link>
        </Card>
      </Shell>
    );
  }

  if (confirmEmailSent) {
    return (
      <Shell>
        <Card className="space-y-4 text-center">
          <MailCheck size={ICON.hero} className="mx-auto text-info-fg" aria-hidden="true" />
          <p className="text-ink">
            נשלח מייל אימות לכתובת. יש לאשר אותו ולפתוח שוב את הקישור — ואם חלפו חמש עשרה דקות,
            לבקש קישור חדש.
          </p>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card className="space-y-4">
        <div className="space-y-1">
          <p className="text-sm text-ink-soft">
            הוזמנת להצטרף לצוות התפעול של {APP_NAME} בתפקיד
            {' '}<span className="font-medium text-ink">{lookup.role_label}</span>.
          </p>
          <p dir="ltr" className="text-sm text-ink-muted">{lookup.email}</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label" htmlFor="operator-invite-password">סיסמה</label>
            <input id="operator-invite-password" className="input" type="password" autoComplete="new-password"
              value={password} onChange={(event) => setPassword(event.target.value)} />
            <p className="mt-1 text-xs text-ink-muted">לפחות {MIN_PASSWORD_LENGTH} תווים</p>
          </div>
          <div>
            <label className="label" htmlFor="operator-invite-confirm">אימות סיסמה</label>
            <input id="operator-invite-confirm" className="input" type="password" autoComplete="new-password"
              value={confirm} onChange={(event) => setConfirm(event.target.value)} />
          </div>
          {formError && (
            <p role="alert" className="note-alert text-sm">{formError}</p>
          )}
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'מצטרף…' : 'הצטרפות לצוות'}
          </button>
        </form>

        <p className="text-xs text-ink-muted">
          ההצטרפות פותחת חשבון לניהול הפלטפורמה בלבד. היא אינה פותחת עסק ואינה מצרפת אותך לאף ארגון.
        </p>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-action px-4 py-6 sm:py-10">
      <div className="w-full max-w-sm sm:max-w-md">
        <div className="text-center mb-8">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="184" height="40"
            className="mx-auto h-auto w-44" />
          <h1 className="page-title mt-2 flex items-center justify-center gap-2 text-shell-ink">
            <ShieldCheck size={ICON.xl} aria-hidden="true" /> הצטרפות לצוות
          </h1>
          <p className="text-shell-ink-soft mt-1 text-sm">ניהול הפלטפורמה, לא ניהול עסק</p>
        </div>
        {children}
      </div>
    </div>
  );
}
