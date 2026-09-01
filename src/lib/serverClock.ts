import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A clock the reader cannot change.
 *
 * WHY NOT `Date.now()`. Every date this product renders today comes from the device. For a figure
 * that is only ever displayed that is survivable; for a boundary that decides whether an offer is
 * still open it is not, because the reader owns that clock. `my_benefit_window()` returns
 * `server_now` beside the window precisely so a countdown can be anchored to something else.
 *
 * AND WHY NOT AN OFFSET AGAINST `Date.now()` EITHER. Storing `serverNow - Date.now()` corrects a
 * constant skew that existed AT THE MOMENT OF THE FETCH, and nothing after it: an NTP correction,
 * a manual clock change, or a laptop waking from suspend all move `Date.now()` underneath the
 * offset and the countdown silently follows. `performance.now()` is monotonic — it counts forward
 * from page load and no clock change touches it — so the anchor is `(serverNow, performance.now())`
 * and elapsed time is measured against the monotonic side.
 *
 * A MONOTONIC CLOCK STILL DRIFTS, which is why this resyncs. It does not tick while the machine is
 * suspended in some browsers, and it accumulates its own small error over hours. So the anchor is
 * refetched every fifteen minutes and on every `focus`, `visibilitychange` and `pageshow` — the
 * three events that mean "this tab may have been asleep". A tab left open overnight is the case
 * that breaks a naive implementation, and it is the one this handles.
 */

/** How long an anchor is trusted before it is refetched. */
export const RESYNC_INTERVAL_MS = 15 * 60_000;

/** How often the DISPLAY recomputes. Once a minute, never once a second: a ticking seconds
 *  counter is the pressure `#204` forbids, and it also floods a screen reader. */
export const TICK_INTERVAL_MS = 60_000;

export interface ServerClock {
  /** The server's instant, advanced by monotonic elapsed time. Null until the first anchor. */
  now: () => Date | null;
  /** Recompute-trigger: changes once a minute, and on every resync. */
  tick: number;
}

interface Anchor {
  serverMs: number;
  monotonicMs: number;
}

/**
 * @param serverNow the `server_now` field of the most recent successful fetch, as an ISO string.
 * @param onResync  asks the caller to refetch. Called on the interval and on wake events.
 */
export function useServerClock(serverNow: string | null | undefined,
                               onResync?: () => void): ServerClock {
  const anchor = useRef<Anchor | null>(null);
  const [tick, setTick] = useState(0);

  // A new `server_now` re-anchors. `performance.now()` is read in the same synchronous step so the
  // two halves of the anchor describe the same instant.
  useEffect(() => {
    if (!serverNow) return;
    const parsed = Date.parse(serverNow);
    if (Number.isNaN(parsed)) return;
    anchor.current = { serverMs: parsed, monotonicMs: performance.now() };
    setTick((value) => value + 1);
  }, [serverNow]);

  // The display tick. Once a minute is the whole resolution this clock is ever read at.
  useEffect(() => {
    const id = window.setInterval(() => setTick((value) => value + 1), TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // The resync. Interval plus the three events that mean the tab may have been asleep — a monotonic
  // clock is not immune to a suspended machine, only to a changed one.
  const resync = useCallback(() => { onResync?.(); }, [onResync]);
  useEffect(() => {
    if (!onResync) return;
    const id = window.setInterval(resync, RESYNC_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') resync(); };
    window.addEventListener('focus', resync);
    window.addEventListener('pageshow', resync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', resync);
      window.removeEventListener('pageshow', resync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [onResync, resync]);

  const now = useCallback(() => {
    if (!anchor.current) return null;
    return new Date(anchor.current.serverMs + (performance.now() - anchor.current.monotonicMs));
  }, []);

  return { now, tick };
}
