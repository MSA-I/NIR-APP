import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useId, useRef, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { Modal, ErrorNote, ICON } from './ui';
import type { TKey } from '../lib/i18n/t';

const REAUTH_ERROR_KEY: Readonly<Record<string, TKey>> = {
  reauth_identity_unavailable: 'reauthModal.identityUnavailable',
  reauth_identity_changed: 'reauthModal.identityChanged',
  reauth_session_missing: 'reauthModal.sessionMissing',
};

/**
 * Client-side mirror of `assert_recent_password_authentication` (extracted from `0031:788-805`,
 * generalised in `0061`; contract: OPEN-DECISIONS #85). The server is the
 * boundary — this check only decides whether to *ask* the user for a password again. Two windows
 * on purpose:
 *
 * - the server accepts a password `amr` entry from the last 5 minutes (+30s clock skew);
 * - the client skips the prompt only under ~4 minutes, so a session that passes here still has
 *   a full minute of margin (including client↔server clock drift) before the RPC actually runs.
 *   Prompting a minute early is safe; skipping into a server rejection is not.
 */
export const FRESH_PASSWORD_WINDOW_SECONDS = 4 * 60;
export const FRESH_PASSWORD_CLOCK_SKEW_SECONDS = 30;

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split('.')[1];
  if (!segment) return null;
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    // Fail closed: an undecodable token means "not fresh", never "fresh".
    return null;
  }
}

/**
 * Does this access token carry a `password` AMR entry fresh enough to skip the prompt?
 *
 * Mirrors the four properties of the server assertion, fail-closed on each:
 * - `amr` must be an array (`jsonb_typeof(...) <> 'array'` on the server);
 * - only `method = 'password'` entries count (SSO/refresh entries do not);
 * - the freshest (max) timestamp wins;
 * - a timestamp further than +30s in the future is rejected, not treated as fresh.
 */
export function hasFreshPasswordAuthentication(accessToken: string, nowMs: number = Date.now()): boolean {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return false;
  const amr = payload.amr;
  if (!Array.isArray(amr)) return false;
  let latest: number | null = null;
  for (const entry of amr) {
    if (typeof entry !== 'object' || entry === null) continue;
    const method = (entry as { method?: unknown }).method;
    const timestamp = (entry as { timestamp?: unknown }).timestamp;
    if (method !== 'password' || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  if (latest === null) return false;
  const nowSeconds = nowMs / 1000;
  return (
    latest >= nowSeconds - FRESH_PASSWORD_WINDOW_SECONDS &&
    latest <= nowSeconds + FRESH_PASSWORD_CLOCK_SKEW_SECONDS
  );
}

export interface ReauthModalProps {
  open: boolean;
  /** Called with the fresh session after a successful re-authentication (or a fresh-JWT skip). */
  onConfirm: (freshSession: Session) => void;
  onCancel: () => void;
  title?: string;
  /**
   * When true (the default) and the current JWT already carries a fresh password `amr` entry,
   * the prompt is skipped and `onConfirm` fires immediately — a user who signed in seconds ago
   * must not be asked for the same password twice. The accountant payment queue passes `false`
   * to keep its historical unconditional re-authentication.
   */
  skipWhenFresh?: boolean;
}

/**
 * The app's single step-up dialog, shared by the accountant payment queue and other sensitive flows.
 *
 * Semantics preserved from the original, verbatim in behaviour:
 * - `signInWithPassword` with the **current** user's email — never a typed identity;
 * - the returned user id must equal the session's; a mismatch signs the whole session out;
 * - the password field is cleared in `finally`, success or failure.
 */
export function ReauthModal({
  open,
  onConfirm,
  onCancel,
  title,
  skipWhenFresh = true,
}: ReauthModalProps) {
  const { errorText, t } = useT();
  const { session } = useAuth();
  const passwordId = useId();
  const errorId = useId();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onConfirmRef = useRef(onConfirm);
  onConfirmRef.current = onConfirm;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Computed during render (not in an effect) so a fresh session never flashes the dialog for
  // a frame before the skip kicks in.
  const fresh =
    open && skipWhenFresh && !!session?.access_token && hasFreshPasswordAuthentication(session.access_token);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (open && fresh && sessionRef.current) onConfirmRef.current(sessionRef.current);
  }, [open, fresh]);

  async function confirm() {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const expectedUserId = session?.user.id;
      const email = session?.user.email;
      if (!expectedUserId || !email) throw new Error('reauth_identity_unavailable');
      const authResult = await supabase.auth
        .signInWithPassword({ email, password })
        .finally(() => setPassword(''));
      if (authResult.error) throw authResult.error;
      if (authResult.data.user?.id !== expectedUserId) {
        await supabase.auth.signOut();
        throw new Error('reauth_identity_changed');
      }
      if (!authResult.data.session) throw new Error('reauth_session_missing');
      onConfirm(authResult.data.session);
    } catch (e) {
      const key = e instanceof Error ? REAUTH_ERROR_KEY[e.message] : undefined;
      setError(key ? t(key) : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open || fresh) return null;

  return (
    <Modal
      open
      onClose={onCancel}
      title={title ?? t('reauthModal.title')}
      description={t('reauthModal.description')}
      busy={busy}
      statusMessage={busy ? t('reauthModal.verifying') : undefined}
    >
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
        <div>
          <label className="label" htmlFor={passwordId}>{t('reauthModal.passwordLabel')}</label>
          <input
            id={passwordId}
            type="password"
            autoComplete="current-password"
            dir="ltr"
            className="input"
            value={password}
            /* The only failure this dialog can report is about this field: a wrong password, or a
               session that can no longer be verified. So the field carries the invalid state and
               points at the sentence that explains it, instead of leaving a sighted-only red box
               below an input that still announces itself as fine. */
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => { setPassword(e.target.value); setError(null); }}
          />
        </div>
        {error && <div id={errorId}><ErrorNote message={error} /></div>}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>{t('reauthModal.cancel')}</button>
          <button type="submit" className="btn-primary" disabled={busy || !password}>
            {busy ? <Loader2 size={ICON.sm} aria-hidden="true" className="animate-spin" /> : <ShieldCheck size={ICON.sm} aria-hidden="true" />}{' '}{t('reauthModal.confirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
