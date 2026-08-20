import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ASSISTANT_FLAG_KEYS } from '../lib/assistant/contracts';
import { useFeatureFlags } from '../lib/flags';
import { APP_NAME } from '../lib/branding';
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
export default function AssistantPanel() {
  const { isEnabled } = useFeatureFlags();
  const [open, setOpen] = useState(false);

  if (!isEnabled(ASSISTANT_FLAG_KEYS.ui)) return null;

  const label = `העוזר של ${APP_NAME}`;
  return (
    <>
      <button
        type="button"
        className="grid size-[44px] shrink-0 place-items-center rounded-full text-ink-soft transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Sparkles size={19} aria-hidden="true" />
      </button>
      {open && <AssistantDialog onClose={() => setOpen(false)} />}
    </>
  );
}
