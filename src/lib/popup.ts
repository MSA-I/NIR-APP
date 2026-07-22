export type PopupResult = 'opened' | 'blocked' | 'error';

type PopupWindow = {
  opener: unknown;
  closed: boolean;
  close: () => void;
  location: { replace: (url: string) => void };
};

type ReserveWindow = (url: string) => PopupWindow | null;

const browserWindow: ReserveWindow = (url) => window.open(url, '_blank') as PopupWindow | null;

function detachOpener(viewer: PopupWindow) {
  try { viewer.opener = null; } catch { /* cross-origin browser guard */ }
}

/** Opens immediately from the user gesture, then resolves the asynchronous URL in that tab. */
export async function openReservedPopup(
  resolveUrl: () => Promise<string>,
  reserveWindow: ReserveWindow = browserWindow,
): Promise<PopupResult> {
  const viewer = reserveWindow('about:blank');
  if (!viewer) return 'blocked';
  detachOpener(viewer);
  try {
    const url = await resolveUrl();
    if (viewer.closed) return 'blocked';
    viewer.location.replace(url);
    return 'opened';
  } catch {
    viewer.close();
    return 'error';
  }
}

/** Opens an already-known external URL and reports a popup blocker before callers mutate data. */
export function openExternalPopup(url: string, reserveWindow: ReserveWindow = browserWindow): PopupResult {
  const viewer = reserveWindow(url);
  if (!viewer) return 'blocked';
  detachOpener(viewer);
  return 'opened';
}
