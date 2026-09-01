import { useT } from '../../lib/i18n/LocaleProvider';
import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { ICON } from '../ui';

/**
 * One answer, clamped until the reader asks for the rest (owner ruling 01.09.2026: „יש לפעמים
 * תשובות ארוכות ואני לא רוצה שהם ייפתחו בבת אחת").
 *
 * Three things this deliberately is not:
 *
 *   - It is NOT a nested scrollport. The thread already scrolls; a second scrolling box inside it
 *     eats the wheel gesture and strands a person in the middle of an answer they cannot leave.
 *     The clamp hides the overflow and the control reveals it, so there is one scroller on screen.
 *   - It is NOT a fixed line count. `line-clamp` counts lines of text, and an answer here is an
 *     evidence card — a claim, a `<dl>` of facts, source links. Six lines of that is not six lines
 *     of prose. The clamp is a height, and the height in CSS is also the measurement: the element
 *     compares its own `scrollHeight` with its clamped `clientHeight`, so the number lives in
 *     `.assistant-clamped` and nowhere else.
 *   - It NEVER hides an answer that fits. A control offering to expand something already whole is
 *     a control that teaches people to distrust the surface.
 *
 * The measurement is repeated through a `ResizeObserver` because the content is not static:
 * `AnswerView` contains a `Disclosure` for the tools it used, and opening it changes the height
 * of a bubble that may have been measured as short.
 */
export default function CollapsibleAnswer({ children }: { children: React.ReactNode }) {
  const { t } = useT();
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    // Only meaningful while the clamp is applied: expanded, the two heights are equal by
    // definition, so measuring then would report "fits" for an answer that does not.
    const measure = () => {
      if (expanded) return;
      setOverflowing(element.scrollHeight > element.clientHeight + 4);
    };
    measure();
    // Guarded because the mount measurement is the load-bearing one and the observer is the
    // refinement: jsdom ships no ResizeObserver, and a component that throws in a test
    // environment over a progressive enhancement is a component that will be deleted from it.
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);

  /**
   * The clamp is applied while collapsed REGARDLESS of the measurement, and that ordering is the
   * whole trick: `scrollHeight > clientHeight` can only be true for an element that is actually
   * clamped, so gating the class on the measurement made the measurement measure an unclamped
   * element and answer "fits" forever. Measured in the live browser (01.09.2026) as a 785px
   * answer that reported no overflow at all.
   *
   * On an answer that genuinely fits, the class costs nothing visible — the max-height is above
   * the content and there is nothing to hide.
   */
  const clamped = overflowing && !expanded;

  return (
    <div>
      <div id={bodyId} ref={bodyRef} className={expanded ? undefined : 'assistant-clamped'}>
        {children}
        {clamped && (
          <>
            {/* The clamp is a visual fact, so it has to be an audible one too: without this a
                screen reader reads the whole answer and never learns why a button below it
                offers to show more. */}
            <span className="sr-only">{t('assistantDialog.answerTruncated')}</span>
            <div
              aria-hidden="true"
              className="assistant-clamp-fade pointer-events-none absolute inset-x-0 bottom-0 h-14"
            />
          </>
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          className="btn-ghost btn-sm mt-2"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded
            ? <ChevronUp size={ICON.xs} aria-hidden="true" />
            : <ChevronDown size={ICON.xs} aria-hidden="true" />}
          {expanded ? t('assistantDialog.showLessAnswer') : t('assistantDialog.showMoreAnswer')}
        </button>
      )}
    </div>
  );
}
