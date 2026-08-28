import { useEffect } from 'react';

/* T7.3f pointer atmosphere: `--glow-x/y` drive the background's oceanic wash (`.app-glow`) and
   the hero band's inner light (index.css). The canvas base itself is static pure wheat.
   Mouse-only by design — attach nothing on touch devices or under reduced-motion, so those
   users keep the static default position. rAF-throttled; the CSS `--glow-x/y` transition
   supplies the easing, so React never re-renders on mouse move.

   It lives here rather than inside `Layout` because the operator console is a second application
   shell on the same design system (DESIGN.md §1, "אווירת הסמן"), and the atmosphere is a property
   of the product's canvas, not of the tenant layout. Two copies of a measured effect is how the
   two shells start drifting apart one constant at a time. */
export function useGlowPointer() {
  useEffect(() => {
    if (!window.matchMedia('(pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let x = 0;
    let y = 0;
    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const style = document.documentElement.style;
        style.setProperty('--glow-x', `${((x / window.innerWidth) * 100).toFixed(1)}%`);
        style.setProperty('--glow-y', `${((y / window.innerHeight) * 100).toFixed(1)}%`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
      document.documentElement.style.removeProperty('--glow-x');
      document.documentElement.style.removeProperty('--glow-y');
    };
  }, []);
}
