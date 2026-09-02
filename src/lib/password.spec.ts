import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, passwordPendingOf, passwordProblemOf } from './password';

describe('passwordProblemOf', () => {
  it('judges the PAIR, and names the minimum once', () => {
    expect(passwordProblemOf('x'.repeat(MIN_PASSWORD_LENGTH - 1), 'x'.repeat(MIN_PASSWORD_LENGTH - 1)))
      .toEqual({ key: 'password.tooShort', vars: { min: MIN_PASSWORD_LENGTH } });
    expect(passwordProblemOf('Aa123456789!', 'Aa123456789?')).toEqual({ key: 'password.mismatch' });
    expect(passwordProblemOf('Aa123456789!', 'Aa123456789!')).toBeNull();
  });
});

/**
 * Owner ruling #332's flag, read strictly.
 *
 * Strictly on purpose: this decides which SCREEN a person is offered, and `user_metadata` is
 * self-asserted — anyone holding a session can write anything into it. A truthy-ish reading would
 * turn a stray string into a redirect loop for a customer, while the thing that actually protects
 * the account (GoTrue holding a random password nobody was given) is unaffected either way.
 */
describe('passwordPendingOf', () => {
  it('is true only for the literal flag the server wrote', () => {
    expect(passwordPendingOf({ user_metadata: { password_pending: true } })).toBe(true);
  });

  it('is false for everything else, including the shapes that look true', () => {
    expect(passwordPendingOf({ user_metadata: { password_pending: false } })).toBe(false);
    expect(passwordPendingOf({ user_metadata: { password_pending: 'true' } })).toBe(false);
    expect(passwordPendingOf({ user_metadata: { password_pending: 1 } })).toBe(false);
    expect(passwordPendingOf({ user_metadata: {} })).toBe(false);
    expect(passwordPendingOf({ user_metadata: null })).toBe(false);
    expect(passwordPendingOf({})).toBe(false);
    expect(passwordPendingOf(null)).toBe(false);
    expect(passwordPendingOf(undefined)).toBe(false);
  });
});
