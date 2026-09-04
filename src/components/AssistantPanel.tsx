import { useT } from '../lib/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
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
import { ICON } from './ui';

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
  const { t } = useT();
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
        // `adoptHistory`, never `restoreHistory`: the guard above ran BEFORE these two awaits, and
        // a question asked and settled in between has already cleared the in-flight ref. Only the
        // adopting entry point re-checks that this session has stayed unasked.
        session.adoptHistory(turns, fingerprint);
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
    ? t('assistantTrigger.resume', { app: APP_NAME })
    : t('assistantTrigger.open', { app: APP_NAME });
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        /* BARE, not a filled oceanic disc (owner report 26.08.2026, ruled the same day).
           DESIGN.md:466 and :531 genuinely contradicted each other here — one says the shell
           cluster is bare dark-ink marks with no box, the other says oceanic marks the command
           that opens a check — and neither was safe to pick on styling grounds, which is why this
           line sat as `btn-primary` with the contradiction written above it instead of a decision.
           What settled it was not the document: the owner looked at the phone header and said
           "יש מספר צבעים צריך לסדר גם את זה". This trigger was one of FIVE treatments in that one
           row, and on desktop it and the account avatar were two identical filled oceanic discs
           with bare ink icons between them. The cluster wins; oceanic still marks the check
           command, inside the panel — the send button, the question bubble, the active source link
           — which honours both lines instead of deleting one.
           THE COUNTER-ARGUMENT IS ON RECORD, in DESIGN.md beside the assistant section: this is the
           only control in that cluster that STARTS something rather than opening a place. If a fill
           ever returns, that is the reason, and it returns as a named exception — not quietly.
           `btn-ghost btn-icon` keeps the 44px target exactly as it was (`btn` → min-h-11,
           `btn-icon` → min-w-11 shrink-0); only the fill changes. */
        className="btn-ghost btn-icon rounded-full"
        aria-label={label}
        title={label}
        aria-controls="inplace-assistant-panel"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {/* Sparkles, restored by owner ruling 25.08.2026 (#273). `c5604f5` replaced it with
            ClipboardCheck to satisfy the anti-goal list; the owner has now revoked that one
            item. The rest of the list — avatar, robot, model name, typing theatre — stands.
            The visible word „בדיקה" beside it is gone by owner ruling 25.08.2026: the assistant
            was never named that, and the label read as an environment tag on a live product.
            The sparkle alone is the trigger, on every width — so `gap-2` and the `lg:px-3` that
            only existed to seat the text go with it. `aria-label`/`title` still carry the full
            name, so nothing is lost to a screen reader or to a hover. */}
        <Sparkles size={ICON.xl} aria-hidden="true" data-assistant-trigger-icon="sparkles" />
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
