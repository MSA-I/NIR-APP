// The ground inside the business plan's card.
//
// COPIED FROM THE MARKETING SITE, NOT REINTERPRETED (owner ruling 31.08.2026:
// «הכרטיס של דף הנחיתה — תעביר אותו לאפליקציה», answered «1» — everything 1:1,
// the gloss and this field included). The file it came from is
// `src/components/PlanShader.tsx` in the LANDING-PAGE-NIR repository, and the
// recipe, the ramp and the three guards below are that file's, unchanged.
//
// The owner, 28.08.2026: the premium plan gets a gloss and the business plan
// gets "a shader of its own". A gloss is a moving highlight and CSS can draw
// one; a shader is a field.
//
// `MeshGradient` AND NOT `GrainGradient`. The same instruction that asked for
// this card asked for the film grain to come off every dark surface, and a
// shader with "grain" in its name is the one place that request would have
// walked back in through the side door. This one is a flow of colour spots with
// both of its grain dials at zero, so the card moves and nothing on it is
// speckled.
//
// ─── WHAT IT COSTS HERE, WHICH IS NOT WHAT IT COSTS THERE ────────────────────
// On the marketing site the comment above this recipe reads "No new dependency"
// — that page already runs a shader behind its title. THIS repository did not,
// so `@paper-design/shaders-react` is a NEW dependency in the product, added for
// this card alone. It is pre-1.0 (`0.0.80`) and it pulls in exactly one other
// package, `@paper-design/shaders`; `npm audit` reports nothing against either.
// Recorded here rather than in a commit message because the next reader deciding
// whether this card is worth its weight needs the number, not the intent.
//
// Three guards are kept from the source, because they are the same three
// problems: the idle load, the still pane under `prefers-reduced-motion`, and
// the empty pane on the server.

import { Suspense, lazy, useEffect, useState } from 'react';
import presentation from '../data/plan-presentation.json';

const MeshGradient = lazy(() =>
  import('@paper-design/shaders-react').then((m) => ({ default: m.MeshGradient })),
);

/**
 * The card's own violet, opened at both ends the way the teal ramp is.
 *
 * READ FROM THE SHARED PRESENTATION FILE, not written here. On the marketing site this array is a
 * literal in this component; in the product `check:tokens` allows colour literals in
 * `src/styles/plan-card.css` and in no other file under `src/`, product `.tsx` very much included.
 * The ramp is a drawing decision of the same kind as the face and the glyph, so it lives beside
 * them in the half of the shared card that is not CSS. Deviation from the source file, recorded.
 */
const RAMP: string[] = presentation.shaderRamp;

const RECIPE = {
  distortion: 0.8,
  swirl: 0.55,
  // Both grain dials at zero. See the note at the top of this file.
  grainMixer: 0,
  grainOverlay: 0,
  offsetX: 0,
  offsetY: 0,
  scale: 1.1,
  rotation: 0,
  // Slower than the marketing page's ground, which runs at 1 behind a headline
  // nobody is reading closely. This one sits under fifteen lines of type.
  speed: 0.3,
};

export function PlanShader({ className }: { className?: string }) {
  const [calm, setCalm] = useState(false);
  useEffect(() => {
    // Guarded, which the marketing site's copy is not: this product renders its components under
    // jsdom, where `matchMedia` simply does not exist, and an unguarded call there throws inside a
    // passive effect and takes the whole panel's test file down with it. A missing matchMedia means
    // "no stated preference", which is the same answer as `matches: false`.
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setCalm(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const [ready, setReady] = useState(false);
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = idle(() => setReady(true), { timeout: 2500 });
    return () => cancel(handle as number);
  }, []);

  // The static pass runs in Node, where there is no GL context to paint into.
  // The card's own gradient is underneath either way, so the pane it emits is
  // empty rather than absent and nothing jumps when the client fills it.
  if (typeof window === 'undefined') return <span className={className} aria-hidden="true" />;

  return (
    <span className={className} aria-hidden="true">
      {ready ? (
        <Suspense fallback={null}>
          <MeshGradient
            {...RECIPE}
            colors={RAMP}
            speed={calm ? 0 : RECIPE.speed}
            style={{ width: '100%', height: '100%', display: 'block' }}
          />
        </Suspense>
      ) : null}
    </span>
  );
}
