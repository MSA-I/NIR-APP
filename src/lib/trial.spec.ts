import { describe, expect, it } from 'vitest';
import { organizationAccessFromServer } from './trial';

describe('organizationAccess', () => {
  it('uses the server lifecycle result and never the device clock', () => {
    expect(organizationAccessFromServer({ access_mode: 'trial', grace_days_remaining: null }))
      .toEqual({ mode: 'trial', graceDaysRemaining: null, canWrite: true });
    expect(organizationAccessFromServer({ access_mode: 'grace', grace_days_remaining: 5 }))
      .toEqual({ mode: 'grace', graceDaysRemaining: 5, canWrite: true });
    expect(organizationAccessFromServer({ access_mode: 'read_only', grace_days_remaining: null }))
      .toEqual({ mode: 'read_only', graceDaysRemaining: null, canWrite: false });
    expect(organizationAccessFromServer({ access_mode: 'offboarding', grace_days_remaining: null }))
      .toEqual({ mode: 'offboarding', graceDaysRemaining: null, canWrite: false });
  });

  it('fails closed for missing, malformed or forged writable evidence', () => {
    expect(organizationAccessFromServer(null).canWrite).toBe(false);
    expect(organizationAccessFromServer({ access_mode: 'unknown', grace_days_remaining: 7 }).canWrite)
      .toBe(false);
    expect(organizationAccessFromServer({ access_mode: 'grace', grace_days_remaining: -1 }))
      .toEqual({ mode: 'grace', graceDaysRemaining: null, canWrite: true });
  });
});
