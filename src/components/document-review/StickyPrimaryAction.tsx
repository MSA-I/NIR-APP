import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * The one action a review screen exists for, pinned to the thumb on a phone.
 *
 * These screens are opened many times a day, standing up, on a phone: a real invoice review is
 * ~4,900px of page and every primary control on it used to sit mid-document, so completing the
 * decision meant scrolling five screens to a button whose position depended on how many findings
 * the machine happened to return. The bar removes the scroll, not the decision — the button, its
 * disabled state and its confirm dialogs are exactly the ones that were inline.
 *
 * Three rules this component exists to enforce, because each was easy to break by hand:
 *
 * **1. One rendering, never two.** The CTA is rendered EITHER inline (desktop) OR in the bar
 * (phone) — chosen in JS from `matchMedia`, not with `lg:hidden`/`hidden lg:block`. A CSS pair
 * leaves both in the DOM: two nodes with the same accessible name, the same `data-testid` and, on
 * the price list, the same `id`s underneath. The gate is the same `lg` (64rem) the app shell
 * itself switches at, so the bar exists exactly where `.mobile-action-bar` exists.
 *
 * **2. Desktop is untouched.** Above `lg` this renders a plain wrapper `<div>` in the button's
 * original position, so DOM order — exception, decision, then the machine's working — is the same
 * order `DocumentAssessmentPanel.spec` asserts. jsdom has no `matchMedia`, so unit tests get the
 * desktop branch unless they state a phone, matching `useMediaQuery` in `ui.tsx`.
 *
 * **3. The bar never eats the last row.** `.phone-safe-main` reserves the global mobile action
 * bar's envelope and no more, and this bar is stacked ABOVE that envelope by `.phone-taskbar`
 * (`index.css`) — so at full scroll the final list row would sit under it. `StickyClearance`
 * portals a spacer to the end of `document.body`, which is in normal flow and therefore extends
 * the document's own scroll height. It is a portal rather than a sibling because the CTA is
 * usually in the middle of the page (the approve button sits ABOVE the folded evidence), and a
 * spacer rendered there would open a hole in the middle of the screen instead of at its end.
 *
 * The idiom is `Receiving.tsx`'s `.phone-taskbar`, deliberately, rather than a second one: that is
 * the only per-screen sticky bar in the product and `index.css` already positions it above the
 * global bar and lifts the toast stack over it.
 *
 * TODO (shared): `usePhoneLayout` duplicates the private `useMediaQuery` in `ui.tsx`, and this bar
 * is the second `.phone-taskbar` consumer. Both belong in `ui.tsx` once the file is not owned by a
 * parallel change; they live here so this package touches nothing outside `document-review/`.
 */
const PHONE_QUERY = '(max-width: 63.999rem)';

function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(PHONE_QUERY).matches
      : false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(media.matches);
    media.addEventListener('change', onChange);
    setPhone(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return phone;
}

/**
 * Scroll room for the bar, at the end of the document rather than at the CTA's position.
 *
 * How much is arithmetic, not a guess: the bar's top edge sits
 * `--mobile-action-bar-size + safe-area + 2rem + its own height` above the viewport bottom, and
 * `.phone-safe-main` already pads `--mobile-action-bar-size + safe-area + 1.5rem`. The two
 * variable terms cancel — including in the landscape shell, which shrinks both together — leaving
 * exactly `0.5rem + bar height` to find.
 *
 * The bar's height is measured rather than assumed, because it is not a constant: the button label
 * carries a live count on the price list, the hint wraps to two lines at 375px, and a long label
 * wraps at all. A hard-coded worst case would be dead space on every screen that does not hit it,
 * and silently wrong on the one that exceeds it. `h-28` is the pre-measurement default so the
 * spacer is never zero on the first paint.
 */
function StickyClearance({ barHeight }: { barHeight: number }) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      aria-hidden="true"
      className="no-print h-28"
      data-testid="sticky-primary-action-clearance"
      style={barHeight > 0 ? { blockSize: `calc(${barHeight}px + 0.5rem)` } : undefined}
    />,
    document.body,
  );
}

export function StickyPrimaryAction({ children, hint, label, className = '', inline = false }: {
  /** The primary button itself — exactly one, and the same element in both renderings. */
  children: ReactNode;
  /**
   * The sentence that explains the button. It travels WITH the button rather than staying inline:
   * on the assessment screen it is the "the server is the gate" sentence DESIGN.md requires beside
   * an approve button that stays enabled while blocked, and a reason five screens above the
   * control it qualifies is not a reason anybody reads.
   */
  hint?: ReactNode;
  /** Accessible name for the bar, so its contents are not an unnamed region on a phone. */
  label: string;
  /** Applied to the inline wrapper only; the bar owns its own geometry. */
  className?: string;
  /**
   * Keep the inline placement at every width.
   *
   * For an action nobody on this screen can take — a read-only organisation — the bar would be a
   * permanent strip across the bottom of the phone advertising a dead button. A disabled button
   * inside the bar is fine when the state is transient and the reviewer's own work clears it
   * (nothing selected yet, catalogue still loading); it is not fine when the answer is "never".
   */
  inline?: boolean;
}) {
  const phone = usePhoneLayout();
  const barRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(0);

  useEffect(() => {
    const node = barRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBarHeight(node.offsetHeight));
    observer.observe(node);
    setBarHeight(node.offsetHeight);
    return () => observer.disconnect();
  }, [phone]);

  if (!phone || inline) {
    return (
      <div className={className}>
        {children}
        {hint != null && <p className="mt-2 text-sm text-ink-muted">{hint}</p>}
      </div>
    );
  }

  return (
    <>
      <StickyClearance barHeight={barHeight} />
      <div
        ref={barRef}
        role="group"
        aria-label={label}
        data-testid="sticky-primary-action"
        className="phone-taskbar no-print fixed start-0 end-0 z-30 border-t border-line bg-surface px-3 pt-3 shadow-menu"
      >
        {hint != null && <p className="mb-2 line-clamp-2 text-xs text-ink-muted">{hint}</p>}
        {/* A column so the button stretches to the bar: one full-width target, reachable with the
            thumb at 375px, and no second control competing with it inside the bar. */}
        <div className="flex flex-col">{children}</div>
      </div>
    </>
  );
}
