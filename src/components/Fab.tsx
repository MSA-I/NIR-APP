import { Camera, Loader2 } from 'lucide-react';
import { matchPath, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useQuickCapture } from './QuickCapture';

const CAPTURE_ROLES = ['owner', 'office', 'kitchen'];

/** One global tool, not a speed dial: capture the paper now and file it later. */
export default function Fab() {
  const { profile } = useAuth();
  const { pathname } = useLocation();
  const { openCapture, element, busy } = useQuickCapture();

  if (!profile || !CAPTURE_ROLES.includes(profile.role) || pathname === '/dashboard') return null;
  const aboveTaskbar = matchPath('/receiving/:orderId', pathname) != null;

  return (
    <div className={`phone-fab fixed z-40 no-print ${aboveTaskbar ? 'phone-fab-taskbar' : ''}`}>
      <button type="button" onClick={openCapture} disabled={busy}
        aria-label={busy ? 'מעלה מסמך' : 'צילום מסמך'} title="צילום מסמך"
        className="grid size-12 place-items-center border border-action-line bg-action text-white shadow-fab transition-colors hover:bg-action-hover active:bg-action-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:opacity-60">
        {busy
          ? <Loader2 size={21} className="animate-spin" aria-hidden="true" />
          : <Camera size={21} aria-hidden="true" />}
      </button>
      {element}
    </div>
  );
}
