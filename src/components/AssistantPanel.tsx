import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useLocation } from 'react-router';
import { ASSISTANT_FLAG_KEYS } from '../lib/assistant/contracts';
import {
  listAssistantConversations,
  loadAssistantConversation,
} from '../lib/assistant/client';
import { useFeatureFlags } from '../lib/flags';
import { APP_NAME } from '../lib/branding';
import { useAuth } from '../auth/AuthContext';
import {
  assistantAuthorizationFingerprint,
  useAssistantRunSession,
  type AssistantRunSession,
} from '../lib/assistant/runSession';
import AssistantDialog from './assistant/AssistantDialog';

/**
 * העוזר של InPlace — the trigger and its dialog.
 *
 * Rendered only while `assistant.ui` is on, and the flag is fail-closed (unknown/unloaded reads
 * as off). UI VISIBILITY IS NOT AUTHORIZATION: hiding this button grants and revokes nothing —
 * the Edge function re-resolves flags and entitlements from the authenticated server context on
 * every run and refuses independently. This gate only spares people a door that leads to a
 * refusal.
 *
 * Layout mounts one instance in the desktop header end-cluster and one in the mobile action
 * cluster; each owns its own open state, and only the visible cluster's trigger can be pressed.
 */
export default function AssistantPanel({ session: sharedSession }: {
  session?: AssistantRunSession;
} = {}) {
  const { isEnabled } = useFeatureFlags();
  const { session: authSession, profile, org, organizationAccess, accessStatus } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [sourceReturnFromLocation, setSourceReturnFromLocation] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);
  const localSession = useAssistantRunSession(assistantAuthorizationFingerprint({
    userId: authSession?.user.id,
    profileId: profile?.id,
    orgId: org?.id ?? profile?.org_id,
    role: profile?.role,
    profileActive: profile?.active,
    orgStatus: org?.status,
    accessMode: organizationAccess?.mode,
    accessStatus,
  }));
  const session = sharedSession ?? localSession;
  const hasActiveCheck = session.pending || session.result !== null || session.submittedQuestion !== null;

  /**
   * A refresh empties the run session — it lives in browser memory on purpose, because a stored
   * answer would outlive the authorization it was produced under. What it should NOT cost is the
   * conversation: that is on the server, and before this the person had to go find it in a list.
   *
   * So the first time this panel opens under a given authorization, an empty session adopts the
   * newest conversation. Once per authorization, not once per open: reopening after "בדיקה חדשה"
   * must not drag the old thread back, and the fingerprint is what a new sign-in changes.
   *
   * Every turn is re-validated and re-authorized by the Edge function on this load, so nothing is
   * shown here that the current role could not be shown now. A failure is silent by design — the
   * panel still opens ready for a new question, which is exactly where it was before.
   */
  const restoredFingerprintRef = useRef<string | null>(null);
  const historyEnabled = isEnabled(ASSISTANT_FLAG_KEYS.history);
  useEffect(() => {
    if (!open || !historyEnabled) return;
    const fingerprint = session.authorizationFingerprint;
    if (restoredFingerprintRef.current === fingerprint) return;
    restoredFingerprintRef.current = fingerprint;
    if (hasActiveCheck || session.conversationId !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const conversations = await listAssistantConversations(1);
        const newest = conversations[0];
        if (cancelled || !newest) return;
        const turns = await loadAssistantConversation(newest.id);
        if (cancelled) return;
        session.restoreHistory(turns, fingerprint);
      } catch {
        // An unavailable history is not an error the person asked for. The panel stays usable.
      }
    })();
    return () => { cancelled = true; };
    // Deliberately keyed to the open edge and the authorization, not to `session`: the session
    // object changes on every keystroke, and the fingerprint guard is what keeps this to one run.
  }, [open, historyEnabled, session.authorizationFingerprint]);

  // A source navigation and the layer cleanup can settle in adjacent frames. Reassert the
  // explicit mobile return path after the route commit so focus never falls back to <body>.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current || !hasActiveCheck) return;
    wasOpenRef.current = false;
    const frame = requestAnimationFrame(() => triggerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, hasActiveCheck]);

  useEffect(() => {
    if (
      open || sourceReturnFromLocation === null ||
      location.key === sourceReturnFromLocation
    ) return;
    const frame = requestAnimationFrame(() => {
      triggerRef.current?.focus();
      setSourceReturnFromLocation(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [location.key, open, sourceReturnFromLocation]);

  if (!isEnabled(ASSISTANT_FLAG_KEYS.ui)) return null;

  const label = hasActiveCheck
    ? `חזרה לבדיקה עם העוזר של ${APP_NAME}`
    : `העוזר של ${APP_NAME}`;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full bg-action px-0 text-on-solid transition-colors hover:bg-action-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus lg:px-3"
        aria-label={label}
        title={label}
        aria-controls="inplace-assistant-panel"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <ClipboardCheck size={19} aria-hidden="true" data-assistant-trigger-icon="operational-check" />
        <span className="hidden text-sm font-medium lg:inline">
          {hasActiveCheck ? 'חזרה לבדיקה' : 'בדיקה'}
        </span>
      </button>
      {open && (
        <AssistantDialog
          session={session}
          onClose={() => setOpen(false)}
          onMobileSourceNavigate={() => {
            setSourceReturnFromLocation(location.key);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
