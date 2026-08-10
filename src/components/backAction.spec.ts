import { describe, expect, it } from 'vitest';
import { backTarget } from './BackAction';

/**
 * The whole value of a shared back action is that it is right in the cases a per-screen one gets
 * wrong. Each test below is one of those cases.
 */
describe('backTarget', () => {
  it('uses history only when this navigation stack created the entry', () => {
    expect(backTarget('a1b2c3', '/documents', '')).toEqual({ kind: 'history' });
  });

  it('refuses history on a fresh tab, a reload or a pasted URL', () => {
    // react-router labels an entry it did not create 'default'. navigate(-1) from there walks the
    // person OUT of the application — to their email, or to a blank tab.
    expect(backTarget('default', '/documents', '')).toEqual({ kind: 'link', to: '/documents' });
    expect(backTarget('', '/documents', '')).toEqual({ kind: 'link', to: '/documents' });
  });

  it('carries the filters back to the parent list', () => {
    // Reviewing one row of a filtered list and landing on an unfiltered one costs the same three
    // clicks every single time, which is how people learn to distrust the button.
    expect(backTarget('default', '/orders', '?status=sent&page=2'))
      .toEqual({ kind: 'link', to: '/orders?status=sent&page=2' });
  });

  it('does not append an empty query string', () => {
    expect(backTarget('default', '/orders', '')).toEqual({ kind: 'link', to: '/orders' });
  });
});
