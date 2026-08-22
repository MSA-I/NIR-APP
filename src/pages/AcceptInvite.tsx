import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Loader2, UserPlus, AlertCircle, MailCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { homeFor } from '../auth/AuthContext';
import { resolveRoleLabels } from '../lib/status';
import { toHebrewError } from '../lib/errors';
import { APP_NAME } from '../lib/branding';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';
import {
  lookupInvitation, acceptInvitation, acceptErrorMessage,
  type InvitationLookup,
} from '../lib/invitations';
import { TERMS_VERSION } from './Legal';

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
  // Package 7: consent is a server precondition (0089) — the checkbox is the human act,
  // the RPC refusal is the enforcement, and the audit row is the record.
  const [consent, setConsent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token) { setLookup({ status: 'unknown' }); setLoading(false); return; }
      try {
        const res = await lookupInvitation(token);
        if (!cancelled) setLookup(res);
      } catch (e) {
        // Raw otherwise, on the screen where an invited employee first meets the product.
        if (!cancelled) setLookupError(toHebrewError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const problem = passwordProblem(password, confirm);
    if (problem) { setFormError(problem); return; }

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
            : toHebrewError(error),
        );
        return;
      }

      // No session means the project requires email confirmation. The invitation stays valid,
      // so confirming and re-opening the same link completes the flow.
      if (!auth?.session) { setConfirmEmailSent(true); return; }

      const { role } = await acceptInvitation(token, fullName.trim(), phone.trim(), TERMS_VERSION);

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
              {/* Never the bare enum: an unrecognised role used to print "office" to the invitee. */}
              {resolveRoleLabels({ role_labels: lookup.role_labels })[lookup.role ?? ''] ?? '—'}
            </strong>
          </p>
        </div>

        <div>
          <label className="label" htmlFor="invite-email">אימייל</label>
          <input id="invite-email" className="input" dir="ltr" value={lookup.email ?? ''} disabled readOnly />
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
          <label className="label" htmlFor="password">סיסמה ({MIN_PASSWORD_LENGTH} תווים לפחות)</label>
          <input id="password" type="password" className="input" dir="ltr" autoComplete="new-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="confirm">אימות סיסמה</label>
          <input id="confirm" type="password" className="input" dir="ltr" autoComplete="new-password" required
            value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>

        <label className="flex items-start gap-2 text-sm text-ink-mid">
          <input type="checkbox" className="rounded mt-0.5" checked={consent}
            onChange={(e) => setConsent(e.target.checked)} />
          <span>
            קראתי ואני מסכים/ה ל<Link className="link" to="/terms" target="_blank">תנאי השימוש</Link>{' '}
            ול<Link className="link" to="/privacy" target="_blank">מדיניות הפרטיות</Link> (גרסה {TERMS_VERSION}).
          </span>
        </label>

        {formError && <div role="alert" className="text-sm text-alert-fg">{formError}</div>}

        <button type="submit" className="btn-primary w-full" disabled={busy || !consent}>
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
    <div className="min-h-dvh flex items-center justify-center bg-action p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1>
            <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="184" height="40"
              className="mx-auto h-auto w-44" />
          </h1>
          <p className="text-shell-ink-soft mt-1 text-sm">רכש, חשבוניות ותשלומים במקום אחד</p>
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
        <Icon size={19} className={tone === 'info' ? 'text-done-fg shrink-0 mt-0.5' : 'text-await-fg shrink-0 mt-0.5'} />
        <div>
          <div className="font-semibold text-ink">{title}</div>
          <p className="text-sm text-ink-soft mt-1 leading-relaxed">{message}</p>
        </div>
      </div>
      <Link to="/login" className="btn-secondary w-full">מעבר למסך ההתחברות</Link>
    </div>
  );
}
