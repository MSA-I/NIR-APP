import { describe, expect, it } from 'vitest';
import { confirmDestination, confirmTypeOf, otpTypeOf, sameOriginNext } from './authConfirm';

const ORIGIN = 'https://app.example.test';

describe('confirmTypeOf', () => {
  it('accepts the five link types we mail and refuses everything else', () => {
    for (const type of ['signup', 'invite', 'magiclink', 'recovery', 'email_change'] as const) {
      expect(confirmTypeOf(type)).toBe(type);
      expect(otpTypeOf(confirmTypeOf(type)!)).toBe(type);
    }
    // A type we do not send is refused rather than handed to verifyOtp, so the reader gets
    // "this link is not one of ours" instead of a provider error in English.
    expect(confirmTypeOf('sms')).toBeNull();
    expect(confirmTypeOf('')).toBeNull();
    expect(confirmTypeOf(null)).toBeNull();
    expect(confirmTypeOf(undefined)).toBeNull();
  });
});

describe('sameOriginNext', () => {
  it('keeps a path on this origin, in both the absolute and the relative spelling', () => {
    expect(sameOriginNext('/accept-invite?token=abc', ORIGIN)).toBe('/accept-invite?token=abc');
    expect(sameOriginNext(`${ORIGIN}/accept-invite?token=abc`, ORIGIN))
      .toBe('/accept-invite?token=abc');
    expect(sameOriginNext(`${ORIGIN}/operator-invite?token=zz#top`, ORIGIN))
      .toBe('/operator-invite?token=zz#top');
  });

  /**
   * The open redirect this exists to close. A destination read out of a URL, followed by a session
   * that was just established, is how "we mailed you a login link" becomes "we mailed you a link
   * to somebody else's site, signed in".
   */
  it('refuses every destination that is not this origin', () => {
    expect(sameOriginNext('https://evil.example/steal', ORIGIN)).toBeNull();
    // Protocol-relative: it LOOKS like a path and resolves to another host.
    expect(sameOriginNext('//evil.example/steal', ORIGIN)).toBeNull();
    expect(sameOriginNext('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(sameOriginNext('http://app.example.test/x', ORIGIN)).toBeNull(); // scheme is part of origin
    expect(sameOriginNext('not a url at all', ORIGIN)).toBe('/not%20a%20url%20at%20all');
  });

  /**
   * GoTrue substitutes the project's Site URL into `{{ .RedirectTo }}` whenever the caller passed
   * no redirect_to — which is exactly the sign-up confirmation, the one link that most needs to
   * land somewhere specific. Reading a bare root as a destination would walk a brand-new owner
   * into the product holding a session and a password only GoTrue generated.
   */
  it('reads a bare site root, and an empty value, as no destination at all', () => {
    expect(sameOriginNext(ORIGIN, ORIGIN)).toBeNull();
    expect(sameOriginNext(`${ORIGIN}/`, ORIGIN)).toBeNull();
    expect(sameOriginNext('/', ORIGIN)).toBeNull();
    expect(sameOriginNext('', ORIGIN)).toBeNull();
    expect(sameOriginNext('   ', ORIGIN)).toBeNull();
    expect(sameOriginNext(null, ORIGIN)).toBeNull();
  });
});

describe('confirmDestination', () => {
  it('sends a recovery link to the reset screen and ignores next entirely', () => {
    // A recovery link exists to change a password. Letting a query parameter steer that session
    // anywhere else would make the most sensitive link the most steerable one.
    expect(confirmDestination({
      type: 'recovery', next: '/settings', origin: ORIGIN, passwordPending: false,
    })).toBe('/reset-password');
    expect(confirmDestination({
      type: 'recovery', next: 'https://evil.example', origin: ORIGIN, passwordPending: true,
    })).toBe('/reset-password');
  });

  it('carries an invitation back to the screen it came from', () => {
    expect(confirmDestination({
      type: 'invite', next: `${ORIGIN}/accept-invite?token=abc`, origin: ORIGIN, passwordPending: false,
    })).toBe('/accept-invite?token=abc');
    expect(confirmDestination({
      type: 'signup', next: '/operator-invite?token=abc', origin: ORIGIN, passwordPending: true,
    })).toBe('/operator-invite?token=abc');
  });

  it('sends a fresh owner who owes a password to the screen that takes one', () => {
    expect(confirmDestination({
      type: 'signup', next: `${ORIGIN}/`, origin: ORIGIN, passwordPending: true,
    })).toBe('/set-password');
    expect(confirmDestination({
      type: 'signup', next: null, origin: ORIGIN, passwordPending: false,
    })).toBe('/');
    // A foreign destination is discarded, and the fallback still applies.
    expect(confirmDestination({
      type: 'magiclink', next: 'https://evil.example/x', origin: ORIGIN, passwordPending: true,
    })).toBe('/set-password');
  });
});
