import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useLocation } from 'react-router';
import { ASSISTANT_FLAG_KEYS } from '../lib/assistant/contracts';
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
