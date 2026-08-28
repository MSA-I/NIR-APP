import { useT } from '../lib/i18n/LocaleProvider';
import type { TKey } from '../lib/i18n/t';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Loader2, UserPlus, AlertCircle, MailCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Card, ICON } from '../components/ui';
import { homeFor } from '../auth/AuthContext';
import { resolveRoleLabels } from '../lib/status';
import { APP_NAME } from '../lib/branding';
import { MIN_PASSWORD_LENGTH, passwordProblem } from '../lib/password';
import {
  lookupInvitation, acceptInvitation, acceptErrorCondition,
  type InvitationLookup,
} from '../lib/invitations';
import { TERMS_VERSION } from './Legal';

/** Public route — the invitee has no account and no session when they land here. */
export default function AcceptInvite() {
  const { errorText, statusLabel, t } = useT();
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
        if (!cancelled) setLookupError(errorText(e));
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
            ? t('acceptInvite.text')
            : errorText(error),
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
      setFormError(errorText(acceptErrorCondition(e instanceof Error ? e.message : String(e))));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <Shell>
        <Card className="flex justify-center py-10 text-ink-faint">
          <Loader2 className="animate-spin" size={ICON.xl} aria-hidden="true" />
        </Card>
      </Shell>
    );
  }

  if (lookupError) {
    return <Shell><Notice title={t('acceptInvite.title')} message={lookupError} /></Shell>;
  }

  if (confirmEmailSent) {
    return (
      <Shell>
        <Notice
          tone="info"
          title={t('acceptInvite.title_2')}
          message={t('acceptInvite.message')}
        />
      </Shell>
    );
  }

  if (lookup?.status !== 'valid') {
    return <Shell><Notice title={t('acceptInvite.title_3')} message={t(INVALID_KEY[lookup?.status ?? 'unknown'])} /></Shell>;
  }

  return (
    <Shell>
      <Card as="form" onSubmit={(e: FormEvent) => void onSubmit(e)} className="space-y-4">
        <div className="pb-1 border-b border-line-soft">
          {/* h2 under the shell's h1 — the shell names the task, this names the business. */}
          <h2 className="section-title">{t('acceptInvite.joinHeading', { org: lookup.org_name ?? '' })}</h2>
          <p className="text-sm text-ink-muted mt-1">
            {t('acceptInvite.yourRoleIs')} <strong className="text-ink-mid">
              {/* Never the bare enum: an unrecognised role used to print "office" to the invitee. */}
              {resolveRoleLabels({ role_labels: lookup.role_labels }, statusLabel)[lookup.role ?? ''] ?? '—'}
            </strong>
          </p>
        </div>

        <div>
          <label className="label" htmlFor="invite-email">{t('acceptInvite.text_2')}</label>
          <input id="invite-email" className="input" dir="ltr" value={lookup.email ?? ''} disabled readOnly />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="fullName">{t('acceptInvite.text_3')}</label>
            <input id="fullName" className="input" autoComplete="name" required
              value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="phone">{t('acceptInvite.text_4')}</label>
            <input id="phone" className="input" dir="ltr" autoComplete="tel"
              value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="password">{t('acceptInvite.passwordLabel', { min: MIN_PASSWORD_LENGTH })}</label>
            {/* Both boxes carry the mark: `passwordProblem` judges the pair, so naming one of
                them would be a claim the check does not make. */}
            <input id="password" type="password" className="input" dir="ltr" autoComplete="new-password" required
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? 'accept-invite-problem' : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="confirm">{t('acceptInvite.text_5')}</label>
            <input id="confirm" type="password" className="input" dir="ltr" autoComplete="new-password" required
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? 'accept-invite-problem' : undefined}
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
        </div>

        {/* The consent gate. `min-h-11` is not decoration here: this is the control that decides
            whether a legal agreement was given, and it was the smallest tap target on the screen
            an invited employee ever sees. */}
        <label className="flex min-h-11 cursor-pointer items-start gap-2 py-1 text-sm text-ink-mid">
          <input type="checkbox" className="mt-1 size-4 shrink-0 rounded accent-action" checked={consent}
            onChange={(e) => setConsent(e.target.checked)} />
          <span>
            {t('acceptInvite.consentLead')}{' '}
            <Link className="link" to="/terms" target="_blank">{t('acceptInvite.text_6')}</Link>{' '}
            {t('acceptInvite.consentAnd')}{' '}
            <Link className="link" to="/privacy" target="_blank">{t('acceptInvite.text_7')}</Link>{' '}
            {t('acceptInvite.consentVersion', { version: TERMS_VERSION })}
          </span>
        </label>

        {formError && <div id="accept-invite-problem" role="alert" className="text-sm text-alert-fg">{formError}</div>}

        <button type="submit" className="btn-primary w-full" disabled={busy || !consent}>
          {busy ? <Loader2 size={ICON.sm} className="animate-spin" aria-hidden="true" /> : <UserPlus size={ICON.sm} aria-hidden="true" />}
          {t('acceptInvite.text_8')}
        </button>
      </Card>
    </Shell>
  );
}

const INVALID_KEY: Record<string, TKey> = {
  unknown: 'acceptInvite.invalidUnknown',
  expired: 'acceptInvite.invalidExpired',
  accepted: 'acceptInvite.invalidAccepted',
  revoked: 'acceptInvite.invalidRevoked',
};

function Shell({ children }: { children: ReactNode }) {
  const { t } = useT();
  return (
    <div className="min-h-dvh flex items-center justify-center bg-action px-4 py-6 sm:py-10">
      <div className="w-full max-w-sm sm:max-w-md">
        {/* Same shape as the other three standalone auth screens: the lockup is the mark, the
            screen's own name is its single <h1>, and the tagline stays a paragraph under it. */}
        <div className="text-center mb-8">
          <img src="/brand/inplace-lockup-paper.svg" alt={APP_NAME} width="184" height="40"
            className="mx-auto h-auto w-44" />
          <h1 className="page-title mt-2 text-shell-ink">{t('acceptInvite.text_9')}</h1>
          <p className="text-shell-ink-soft mt-1 text-sm">{t('acceptInvite.text_10')}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function Notice({ title, message, tone = 'warn' }: { title: string; message: string; tone?: 'warn' | 'info' }) {
  const { t } = useT();
  const Icon = tone === 'info' ? MailCheck : AlertCircle;
  return (
    <Card className="space-y-3">
      <div className="flex items-start gap-2.5">
        <Icon size={ICON.md} aria-hidden="true" className={tone === 'info' ? 'text-done-fg shrink-0 mt-0.5' : 'text-await-fg shrink-0 mt-0.5'} />
        <div>
          <div className="font-semibold text-ink">{title}</div>
          <p className="text-sm text-ink-soft mt-1 leading-relaxed">{message}</p>
        </div>
      </div>
      <Link to="/login" className="btn-secondary w-full">{t('acceptInvite.text_11')}</Link>
    </Card>
  );
}
