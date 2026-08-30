import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, RotateCcw, X } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import type { ProductHelpLocale } from '../../lib/assistant/contracts.ts';
import type { ActiveRole } from '../../lib/types.ts';
import {
  OWNER_FIRST_RUN_TOUR,
  OWNER_FIRST_RUN_TOUR_ID,
  loadProductTourProgress,
  resolveProductTourCopy,
  saveProductTourProgress,
  type ProductTourProgress,
  type ProductTourStep,
} from '../../lib/productTourRegistry.ts';
import { ICON } from '../ui.tsx';

const TARGET_WAIT_MS = 1_400;
const SPOTLIGHT_GAP = 8;
const POPOVER_WIDTH = 360;
const VIEWPORT_GAP = 16;

const viewportWidth = () => document.documentElement.clientWidth || window.innerWidth;
const viewportHeight = () => document.documentElement.clientHeight || window.innerHeight;

interface ProductTourUiCopy {
  progress: (current: number, total: number) => string;
  liveProgress: (current: number, total: number, title: string) => string;
  missingTitle: string;
  missingBody: string;
  close: string;
  retry: string;
  skipStep: string;
  clickHint: string;
  skipGuide: string;
  back: string;
  next: string;
}

const PRODUCT_TOUR_UI: Record<ProductHelpLocale, ProductTourUiCopy> = {
  he: {
    progress: (current, total) => `${current} מתוך ${total}`,
    liveProgress: (current, total, title) => `צעד ${current} מתוך ${total}: ${title}`,
    missingTitle: 'האלמנט לא זמין במסך הזה',
    missingBody: 'ייתכן שהמסך עדיין נטען או שהפקד אינו זמין במצב הנוכחי. אפשר לנסות שוב או להמשיך לצעד הבא.',
    close: 'סגירת המדריך',
    retry: 'נסה שוב',
    skipStep: 'דלג על השלב',
    clickHint: 'לחיצה על האזור המודגש תמשיך לצעד הבא.',
    skipGuide: 'דלג על המדריך',
    back: 'חזרה',
    next: 'הבא',
  },
  en: {
    progress: (current, total) => `${current} of ${total}`,
    liveProgress: (current, total, title) => `Step ${current} of ${total}: ${title}`,
    missingTitle: 'This element is not available on this screen',
    missingBody: 'The screen may still be loading, or this control may not be available in the current state. Try again or continue to the next step.',
    close: 'Close guide',
    retry: 'Try again',
    skipStep: 'Skip step',
    clickHint: 'Select the highlighted area to continue to the next step.',
    skipGuide: 'Skip guide',
    back: 'Back',
    next: 'Next',
  },
};

const productTourLocaleFromDocument = (): ProductHelpLocale => (
  document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'he'
);

/**
 * Compatibility bridge for the application-wide LocaleProvider being developed in parallel.
 * That provider owns html[lang] and html[dir]; observing the canonical DOM attribute keeps this
 * branch independent of its not-yet-merged module and switches an already-open guide immediately.
 */
export function useProductTourLocale(): ProductHelpLocale {
  const [locale, setLocale] = useState<ProductHelpLocale>(productTourLocaleFromDocument);
  useEffect(() => {
    const sync = () => setLocale(productTourLocaleFromDocument());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
    return () => observer.disconnect();
  }, []);
  return locale;
}

type TourProfile = { id: string; org_id: string; role: ActiveRole };

interface SpotlightRadii {
  startStart: string;
  startEnd: string;
  endEnd: string;
  endStart: string;
}

const DEFAULT_SPOTLIGHT_RADII: SpotlightRadii = {
  startStart: '1rem', startEnd: '1rem', endEnd: '1rem', endStart: '1rem',
};

export interface OwnerProductTourHandle {
  start: () => void;
}

export interface OwnerProductTourProps {
  profile: TourProfile | null;
  onPrepareStep?: (step: ProductTourStep) => void;
}

function progressFor(step: ProductTourStep, status: ProductTourProgress['status']): ProductTourProgress {
  return {
    tourId: OWNER_FIRST_RUN_TOUR_ID,
    status,
    stepId: step.id,
    updatedAt: new Date().toISOString(),
  };
}

function isVisibleTarget(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findTarget(anchor: string): HTMLElement | null {
  const candidates = [...document.querySelectorAll<HTMLElement>(`[data-tour-anchor="${anchor}"]`)];
  return candidates.find(isVisibleTarget) ?? null;
}

function revealTarget(target: HTMLElement): void {
  target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' });
}

function paddedRect(rect: DOMRect): DOMRect {
  const left = Math.max(0, rect.left - SPOTLIGHT_GAP);
  const top = Math.max(0, rect.top - SPOTLIGHT_GAP);
  const right = Math.min(viewportWidth(), rect.right + SPOTLIGHT_GAP);
  const bottom = Math.min(viewportHeight(), rect.bottom + SPOTLIGHT_GAP);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

function expandCornerRadius(value: string): string {
  const normalized = value.trim();
  if (!normalized) return '1rem';
  return normalized.replace(/(-?\d+(?:\.\d+)?)px/g, (_, raw: string) => (
    `${Math.max(0, Number(raw) + SPOTLIGHT_GAP)}px`
  ));
}

function spotlightRadii(target: HTMLElement): SpotlightRadii {
  const style = window.getComputedStyle(target);
  const rtl = style.direction === 'rtl' || document.documentElement.dir === 'rtl';
  const shorthandRadius = style.borderRadius.trim();
  const logicalOrPhysical = (logical: string, physical: string) => {
    const logicalValue = style.getPropertyValue(logical).trim();
    const physicalValue = style.getPropertyValue(physical).trim();
    // jsdom and older Chromium builds expose unsupported logical corners as the string "0";
    // prefer the resolved physical corner when it carries the actual shape.
    return physicalValue && physicalValue !== '0px' && physicalValue !== '0'
      ? physicalValue
      : logicalValue && logicalValue !== '0px' && logicalValue !== '0'
        ? logicalValue
        : shorthandRadius || logicalValue || physicalValue;
  };
  return {
    startStart: expandCornerRadius(logicalOrPhysical(
      'border-start-start-radius', rtl ? 'border-top-right-radius' : 'border-top-left-radius',
    )),
    startEnd: expandCornerRadius(logicalOrPhysical(
      'border-start-end-radius', rtl ? 'border-top-left-radius' : 'border-top-right-radius',
    )),
    endEnd: expandCornerRadius(logicalOrPhysical(
      'border-end-end-radius', rtl ? 'border-bottom-left-radius' : 'border-bottom-right-radius',
    )),
    endStart: expandCornerRadius(logicalOrPhysical(
      'border-end-start-radius', rtl ? 'border-bottom-right-radius' : 'border-bottom-left-radius',
    )),
  };
}

function logicalInsetStart(left: number, width: number): number {
  return document.documentElement.dir === 'rtl' ? viewportWidth() - left - width : left;
}

function popoverStyle(rect: DOMRect): React.CSSProperties {
  const width = Math.min(POPOVER_WIDTH, viewportWidth() - VIEWPORT_GAP * 2);
  const estimatedHeight = 250;
  const placeBelow = viewportHeight() - rect.bottom >= estimatedHeight + VIEWPORT_GAP;
  const top = placeBelow
    ? Math.min(viewportHeight() - estimatedHeight - VIEWPORT_GAP, rect.bottom + 12)
    : Math.max(VIEWPORT_GAP, rect.top - estimatedHeight - 12);
  const centered = rect.left + rect.width / 2 - width / 2;
  const left = Math.max(VIEWPORT_GAP, Math.min(viewportWidth() - width - VIEWPORT_GAP, centered));
  return { position: 'fixed', insetInlineStart: logicalInsetStart(left, width), top, width };
}

export const OwnerProductTour = forwardRef<OwnerProductTourHandle, OwnerProductTourProps>(
  function OwnerProductTour({ profile, onPrepareStep }, ref) {
    const location = useLocation();
    const navigate = useNavigate();
    const locale = useProductTourLocale();
    const ui = PRODUCT_TOUR_UI[locale];
    const identityKey = profile?.role === 'owner' ? `${profile.org_id}:${profile.id}` : null;
    const [progress, setProgress] = useState<ProductTourProgress | null>(() => (
      profile?.role === 'owner' ? loadProductTourProgress(profile.org_id, profile.id) : null
    ));
    const [hydratedIdentity, setHydratedIdentity] = useState<string | null>(() => identityKey);
    const [target, setTarget] = useState<HTMLElement | null>(null);
    const [rect, setRect] = useState<DOMRect | null>(null);
    const [radii, setRadii] = useState<SpotlightRadii>(DEFAULT_SPOTLIGHT_RADII);
    const [measuredStepId, setMeasuredStepId] = useState<string | null>(null);
    const [targetMissing, setTargetMissing] = useState(false);
    const nextButtonRef = useRef<HTMLButtonElement>(null);
    const layerRef = useRef<HTMLDivElement>(null);

    const active = profile?.role === 'owner' && progress?.status === 'active';
    const stepIndex = active
      ? Math.max(0, OWNER_FIRST_RUN_TOUR.findIndex((candidate) => candidate.id === progress.stepId))
      : 0;
    const step = OWNER_FIRST_RUN_TOUR[stepIndex];
    const copy = useMemo(
      () => resolveProductTourCopy(step, undefined, locale),
      [locale, step],
    );
    const BackIcon = locale === 'he' ? ArrowRight : ArrowLeft;
    const NextIcon = locale === 'he' ? ArrowLeft : ArrowRight;

    const store = useCallback((next: ProductTourProgress) => {
      setProgress(next);
      if (profile?.role === 'owner') saveProductTourProgress(profile.org_id, profile.id, next);
    }, [profile]);

    const start = useCallback(() => {
      if (profile?.role !== 'owner') return;
      store(progressFor(OWNER_FIRST_RUN_TOUR[0], 'active'));
    }, [profile, store]);
    useImperativeHandle(ref, () => ({ start }), [start]);

    useEffect(() => {
      if (identityKey === hydratedIdentity) return;
      if (!identityKey || profile?.role !== 'owner') {
        setProgress(null);
        setHydratedIdentity(null);
        return;
      }
      setProgress(loadProductTourProgress(profile.org_id, profile.id));
      setHydratedIdentity(identityKey);
    }, [hydratedIdentity, identityKey, profile]);

    const finishOrAdvance = useCallback(() => {
      if (!profile || !active) return;
      if (stepIndex === OWNER_FIRST_RUN_TOUR.length - 1) {
        store(progressFor(step, 'completed'));
        return;
      }
      store(progressFor(OWNER_FIRST_RUN_TOUR[stepIndex + 1], 'active'));
    }, [active, profile, step, stepIndex, store]);

    const goBack = useCallback(() => {
      if (!active || stepIndex === 0) return;
      store(progressFor(OWNER_FIRST_RUN_TOUR[stepIndex - 1], 'active'));
    }, [active, stepIndex, store]);

    const dismiss = useCallback(() => {
      if (!active) return;
      store(progressFor(step, 'dismissed'));
    }, [active, step, store]);

    // The existing dashboard first-run probe is the oracle. No second supplier query and no
    // guessed account age: the tour starts only when the owner can see the real setup door.
    useEffect(() => {
      if (profile?.role !== 'owner' || hydratedIdentity !== identityKey || progress !== null || location.pathname !== '/dashboard') return;
      const tryStart = () => {
        if (document.querySelector('[data-tour-first-run="true"]')) start();
      };
      tryStart();
      const observer = new MutationObserver(tryStart);
      observer.observe(document.body, { childList: true, subtree: true });
      return () => observer.disconnect();
    }, [hydratedIdentity, identityKey, location.pathname, profile?.role, progress, start]);

    // Route changes made by "הבא" are navigation only. They never submit, approve or save.
    useEffect(() => {
      if (!active || location.pathname === step.route) return;
      navigate(step.route);
    }, [active, location.pathname, navigate, step.route]);

    const resolveTarget = useCallback(() => {
      const found = findTarget(step.anchor);
      setTarget(found);
      setRect(found ? paddedRect(found.getBoundingClientRect()) : null);
      setRadii(found ? spotlightRadii(found) : DEFAULT_SPOTLIGHT_RADII);
      setMeasuredStepId(found ? step.id : null);
      setTargetMissing(!found);
      if (found) revealTarget(found);
      return found;
    }, [step.anchor]);

    // A step can need the mobile drawer or a desktop disclosure opened before its anchor exists.
    useEffect(() => {
      if (!active || location.pathname !== step.route) return;
      setTarget(null);
      setRect(null);
      setMeasuredStepId(null);
      setTargetMissing(false);
      // Layout closes route-owned drawers/dropdowns in its pathname effect. Preparing in the same
      // commit loses that race at the final onboarding step, so open the required surface only
      // after the route effects have settled.
      const prepareFrame = requestAnimationFrame(() => onPrepareStep?.(step));

      let settled = false;
      let timeout = 0;
      const tryResolve = () => {
        const found = findTarget(step.anchor);
        if (!found) return;
        settled = true;
        setTarget(found);
        revealTarget(found);
        setRect(paddedRect(found.getBoundingClientRect()));
        setRadii(spotlightRadii(found));
        setMeasuredStepId(step.id);
        setTargetMissing(false);
        observer.disconnect();
        window.clearTimeout(timeout);
      };
      const observer = new MutationObserver(tryResolve);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      tryResolve();
      timeout = window.setTimeout(() => {
        if (!settled) setTargetMissing(true);
      }, TARGET_WAIT_MS);
      return () => {
        cancelAnimationFrame(prepareFrame);
        observer.disconnect();
        window.clearTimeout(timeout);
      };
    }, [active, location.pathname, onPrepareStep, step]);

    useEffect(() => {
      if (!active || !target) return;
      const measure = () => {
        setRect(paddedRect(target.getBoundingClientRect()));
        setRadii(spotlightRadii(target));
      };
      const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
      resize?.observe(target);
      window.addEventListener('resize', measure);
      window.addEventListener('scroll', measure, true);
      return () => {
        resize?.disconnect();
        window.removeEventListener('resize', measure);
        window.removeEventListener('scroll', measure, true);
      };
    }, [active, target]);

    useEffect(() => {
      if (!active || !target || step.advance !== 'click') return;
      const onClick = () => finishOrAdvance();
      target.addEventListener('click', onClick);
      return () => target.removeEventListener('click', onClick);
    }, [active, finishOrAdvance, step.advance, target]);

    useEffect(() => {
      if (!active) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          dismiss();
          return;
        }
        if (event.key !== 'Tab') return;
        const controls: HTMLElement[] = [];
        if (step.advance === 'click' && target && !target.matches(':disabled')) controls.push(target);
        controls.push(...(layerRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
        ) ?? []));
        if (controls.length === 0) return;
        event.preventDefault();
        const current = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? (current <= 0 ? controls.length - 1 : current - 1)
          : (current < 0 || current === controls.length - 1 ? 0 : current + 1);
        controls[next].focus();
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [active, dismiss, step.advance, target]);

    useEffect(() => {
      if (!active || targetMissing) return;
      if (step.advance === 'click') target?.focus();
      else nextButtonRef.current?.focus();
    }, [active, step.advance, target, targetMissing]);

    if (!active || profile?.role !== 'owner') return null;

    const content = targetMissing ? (
      <div className="product-tour-popover product-tour-popover-fallback" role="dialog" aria-modal="false" aria-labelledby="product-tour-missing-title">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-ink-muted">{ui.progress(stepIndex + 1, OWNER_FIRST_RUN_TOUR.length)}</div>
            <h2 id="product-tour-missing-title" className="mt-1 text-lg font-semibold text-ink">{ui.missingTitle}</h2>
          </div>
          <button type="button" className="btn-ghost btn-icon" onClick={dismiss} aria-label={ui.close}><X size={ICON.md} aria-hidden="true" /></button>
        </div>
        <p className="mt-3 text-sm leading-6 text-ink-body">{ui.missingBody}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={resolveTarget}><RotateCcw size={ICON.sm} aria-hidden="true" /> {ui.retry}</button>
          <button type="button" className="btn-primary" onClick={finishOrAdvance}>{ui.skipStep}</button>
        </div>
      </div>
    ) : rect && measuredStepId === step.id ? (
      <>
        <div className="product-tour-shield" style={{ insetBlockStart: 0, insetInlineStart: 0, width: '100vw', height: rect.top }} />
        <div className="product-tour-shield" style={{ insetBlockStart: rect.bottom, insetInlineStart: 0, width: '100vw', height: Math.max(0, viewportHeight() - rect.bottom) }} />
        <div className="product-tour-shield" style={{ insetBlockStart: rect.top, insetInlineStart: logicalInsetStart(0, rect.left), width: rect.left, height: rect.height }} />
        <div className="product-tour-shield" style={{ insetBlockStart: rect.top, insetInlineStart: logicalInsetStart(rect.right, Math.max(0, viewportWidth() - rect.right)), width: Math.max(0, viewportWidth() - rect.right), height: rect.height }} />
        <div className="product-tour-spotlight" aria-hidden="true" style={{
          insetBlockStart: rect.top,
          insetInlineStart: logicalInsetStart(rect.left, rect.width),
          width: rect.width,
          height: rect.height,
          '--product-tour-radius-start-start': radii.startStart,
          '--product-tour-radius-start-end': radii.startEnd,
          '--product-tour-radius-end-end': radii.endEnd,
          '--product-tour-radius-end-start': radii.endStart,
        } as React.CSSProperties} />
        <div className="product-tour-popover" style={popoverStyle(rect)} role="dialog" aria-modal="false" aria-labelledby="product-tour-title" aria-describedby="product-tour-body">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-ink-muted">{ui.progress(stepIndex + 1, OWNER_FIRST_RUN_TOUR.length)}</div>
              <h2 id="product-tour-title" className="mt-1 text-lg font-semibold text-ink">{copy.title}</h2>
            </div>
            <button type="button" className="btn-ghost btn-icon" onClick={dismiss} aria-label={ui.close}><X size={ICON.md} aria-hidden="true" /></button>
          </div>
          <p id="product-tour-body" className="mt-3 text-sm leading-6 text-ink-body">{copy.body}</p>
          {step.advance === 'click' && (
            <p className="mt-3 text-sm font-medium text-action" aria-live="polite">{ui.clickHint}</p>
          )}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
            <button type="button" className="btn-ghost min-h-11" onClick={dismiss}>{ui.skipGuide}</button>
            <div className="flex gap-2">
              {stepIndex > 0 && <button type="button" className="btn-secondary" onClick={goBack}><BackIcon size={ICON.sm} aria-hidden="true" /> {ui.back}</button>}
              {step.advance === 'next' && (
                <button ref={nextButtonRef} type="button" className="btn-primary" onClick={finishOrAdvance}>{ui.next} <NextIcon size={ICON.sm} aria-hidden="true" /></button>
              )}
            </div>
          </div>
        </div>
        <span className="sr-only" aria-live="polite">{ui.liveProgress(stepIndex + 1, OWNER_FIRST_RUN_TOUR.length, copy.title)}</span>
      </>
    ) : null;

    return createPortal(<div ref={layerRef} className="product-tour-layer no-print" data-product-tour-step={step.id}>{content}</div>, document.body);
  },
);
