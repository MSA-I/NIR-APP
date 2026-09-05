import type { ReactNode } from 'react';

/**
 * The one action a review screen exists for, kept in the screen's own flow.
 *
 * **What this replaced, and why (owner report, 18.08.2026).** This was `StickyPrimaryAction`: on a
 * phone it portalled the button into a `.phone-taskbar` bar fixed above the global action bar. The
 * bar's offset is `--mobile-action-bar-size + safe-area + 2rem`, and the `2rem` is there to clear
 * the raised camera puck — so the bar came to rest roughly `6rem` above the bottom edge with page
 * content still scrolling in the gap underneath it. An opaque `bg-surface` slab with live content
 * both above AND below it does not read as a bottom bar; it reads as a panel dropped into the
 * middle of the list. The owner's instruction was to pin the button to the start of the list or to
 * the end of it, not to tune the float.
 *
 * **The placement chosen: the head of the evidence, in flow.** It is not a new idea — it is the
 * placement three of the four review screens had already authored for themselves, in comments that
 * say so: „the decision, above the folded evidence rather than below it” in
 * `DocumentAssessmentPanel`, „the whole decision, above the lines rather than below them” in
 * `PriceListReviewConfirmation`. The floating bar was overriding a decision those screens had
 * already made, dragging a button that was deliberately at the head down to the foot of the
 * viewport. `DocumentPacketReview` was the one screen whose button really did sit after the list;
 * it moved up to join them.
 *
 * The reason the head is right is the exception-inbox law (DESIGN.md §Disclosure): what the machine
 * settled is folded to a counted summary and what needs a person stays open. The list below the
 * button is therefore EVIDENCE, not a form — optional reading. A control placed after the evidence
 * says „read all of this first”, which is the opposite of what the screen promises. On a packet the
 * machine settled, the whole decision is now: read the counts, press the button. No scrolling.
 *
 * The one screen where the evidence is the OBJECT of the decision — `DocumentScanPreview`, where
 * you approve the scan image itself, under a sentence that says „check the page is complete and
 * legible” — keeps its button after the images. There the evidence is not optional.
 *
 * **What was deleted with the bar:** the `createPortal` clearance spacer at the end of `<body>`, the
 * `ResizeObserver` that measured the bar to size that spacer, and the `matchMedia` branch that
 * chose between two renderings. All three existed only to survive the float. `.phone-taskbar` in
 * `index.css` is untouched and is once again `Receiving.tsx`'s alone.
 *
 * What survives is the part that was never about position: ONE rendering of the button at every
 * width, the qualifying sentence travelling WITH the button instead of five screens above it, and a
 * full-width thumb target on a phone.
 */
export function PrimaryDecision({ children, hint, label, className = '' }: {
  /** The primary button itself — exactly one, and the same element at every width. */
  children: ReactNode;
  /**
   * The sentence that explains the button, above it rather than below: on the assessment screen it
   * is the „the server is the gate” sentence DESIGN.md requires beside an approve button that stays
   * enabled while blocked, and a reason nobody reads before pressing is not a reason.
   */
  hint?: ReactNode;
  /** Accessible name for the decision, so the pair is not an unnamed group. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="primary-decision"
      // Stretch on a phone so the button is one full-width target; from `lg` — the width the app
      // shell itself switches at — it returns to its natural size at the logical end.
      className={`flex flex-col items-stretch gap-2 rounded-xl border border-action-line bg-action-wash p-3 lg:items-end ${className}`}
    >
      <h3 className="w-full text-sm font-semibold text-ink-body">{label}</h3>
      {hint != null && <p className="w-full text-sm text-ink-muted lg:text-end">{hint}</p>}
      {children}
    </div>
  );
}
