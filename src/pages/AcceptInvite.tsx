import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2, UserPlus, AlertCircle, MailCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { homeFor } from '../auth/AuthContext';
import { resolveRoleLabels } from '../lib/status';
import { APP_NAME } from '../lib/branding';
import {
  lookupInvitation, acceptInvitation, acceptErrorMessage,
  type InvitationLookup,
} from '../lib/invitations';

/** Public route — the invitee has no account and no session when they land here. */
export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [lookup, setLookup] = useState<InvitationLookup | null>(null);
  const [loading, setLoading] = useState(true);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
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
        const res = await lookupInvitation(token);
        if (!cancelled) setLookup(res);
      } catch (e) {
        if (!cancelled) setLookupError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (password.length < 8) { setFormError('הסיסמה חייבת להכיל לפחות 8 תווים.'); return; }
    if (password !== confirm) { setFormError('הסיסמאות אינן זהות.'); return; }

    setBusy(true);
    try {
      const email = lookup!.email!;

      // The auth user may already exist if a previous attempt got as far as sign-up but not
      // as far as accepting (e.g. the project requires email confirmation).
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
            : error.message,
        );
        return;
      }

      // No session means the project requires email confirmation. The invitation stays valid,
      // so confirming and re-opening the same link completes the flow.
      if (!auth?.session) { setConfirmEmailSent(true); return; }

      const { role } = await acceptInvitation(token, fullName.trim(), phone.trim());

      // Full reload: AuthContext loads the profile once per session change, and this session
      // was established a moment before the profile existed.
      window.location.replace(homeFor(role));
    } catch (e) {
      setFormError(acceptErrorMessage(e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Shell>
        <div className="card card-pad flex justify-center py-10 text-ink-faint">
          <Loader2 className="animate-spin" size={26} />
        </div>
      </Shell>
    );
  }

  if (lookupError) {
    return <Shell><Notice title="לא ניתן לבדוק את ההזמנה" message={lookupError} /></Shell>;
  }

  if (confirmEmailSent) {
    return (
      <Shell>
        <Notice
          tone="info"
          title="נשלח אליך מייל אימות"
          message="יש לאשר את כתובת האימייל, ואז לפתוח שוב את קישור ההזמנה כדי להשלים את ההצטרפות. ההזמנה נשארת בתוקף."
        />
      </Shell>
    );
  }

  if (lookup?.status !== 'valid') {
    return <Shell><Notice title="לא ניתן להשלים את ההצטרפות" message={INVALID_MESSAGE[lookup?.status ?? 'unknown']} /></Shell>;
  }

  return (
    <Shell>
      <form onSubmit={(e) => void onSubmit(e)} className="card card-pad space-y-4">
        <div className="pb-1 border-b border-line-soft">
          <h2 className="section-title">הצטרפות ל{lookup.org_name}</h2>
          <p className="text-sm text-ink-muted mt-1">
            התפקיד שהוגדר עבורך: <strong className="text-ink-mid">
              {resolveRoleLabels({ role_labels: lookup.role_labels })[lookup.role ?? ''] ?? lookup.role}
            </strong>
          </p>
        </div>

        <div>
          <label className="label">אימייל</label>
          <input className="input" dir="ltr" value={lookup.email ?? ''} disabled readOnly />
        </div>
        <div>
          <label className="label" htmlFor="fullName">שם מלא</label>
          <input id="fullName" className="input" autoComplete="name" required
            value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="phone">טלפון (אופציונלי)</label>
          <input id="phone" className="input" dir="ltr" autoComplete="tel"
            value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">סיסמה (8 תווים לפחות)</label>
          <input id="password" type="password" className="input" dir="ltr" autoComplete="new-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="confirm">אימות סיסמה</label>
          <input id="confirm" type="password" className="input" dir="ltr" autoComplete="new-password" required
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        {formError && <div className="text-sm text-alert-solid">{formError}</div>}

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={15} />}
          השלמת ההצטרפות
        </button>
      </form>
    </Shell>
  );
}

const INVALID_MESSAGE: Record<string, string> = {
  unknown: 'קישור ההזמנה אינו תקין. ייתכן שהועתק חלקית — בקש מהעסק לשלוח הזמנה חדשה.',
  expired: 'תוקף ההזמנה פג. בקש מהעסק לשלוח הזמנה חדשה.',
  accepted: 'ההזמנה כבר נוצלה. אפשר להתחבר עם הפרטים שהוגדרו.',
  revoked: 'ההזמנה בוטלה על ידי העסק.',
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-shell p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">{APP_NAME}</h1>
          <p className="text-shell-ink-dim mt-1 text-sm">מערכת ניהול רכש, חשבוניות ותשלומים</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function Notice({ title, message, tone = 'warn' }: { title: string; message: string; tone?: 'warn' | 'info' }) {
  const Icon = tone === 'info' ? MailCheck : AlertCircle;
  return (
    <div className="card card-pad space-y-3">
      <div className="flex items-start gap-2.5">
        <Icon size={19} className={tone === 'info' ? 'text-done-solid shrink-0 mt-0.5' : 'text-await-solid shrink-0 mt-0.5'} />
        <div>
          <div className="font-semibold text-ink">{title}</div>
          <p className="text-sm text-ink-soft mt-1 leading-relaxed">{message}</p>
        </div>
      </div>
      <Link to="/login" className="btn-secondary w-full">מעבר למסך ההתחברות</Link>
    </div>
  );
}
