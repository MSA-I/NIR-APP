import { describe, expect, it, vi } from 'vitest';
import { startAurora } from './loginAurora';

// jsdom has no WebGL2, which makes it exactly the environment the fallback contract exists for:
// the login screen must mount cleanly on machines whose GPU stack refuses a context.
describe('startAurora fallback contract', () => {
  it('returns a working cleanup for a null canvas', () => {
    const stop = startAurora(null);
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('bails out without scheduling frames when WebGL2 does not exist', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const stop = startAurora(document.createElement('canvas'));
    expect(raf).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
  });
});
