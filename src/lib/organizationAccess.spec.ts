import { describe, expect, it } from 'vitest';
import { organizationAccessFromServer } from './organizationAccess';

describe('organizationAccess', () => {
  it('allows writes only for the active server lifecycle state', () => {
    expect(organizationAccessFromServer({ access_mode: 'active' }))
      .toEqual({ mode: 'active', canWrite: true });
    expect(organizationAccessFromServer({ access_mode: 'offboarding' }))
      .toEqual({ mode: 'offboarding', canWrite: false });
    expect(organizationAccessFromServer({ access_mode: 'suspended' }))
      .toEqual({ mode: 'suspended', canWrite: false });
  });

  it('fails closed for missing, malformed, or retired lifecycle evidence', () => {
    expect(organizationAccessFromServer(null))
      .toEqual({ mode: 'read_only', canWrite: false });
    expect(organizationAccessFromServer({ access_mode: 'unknown' }))
      .toEqual({ mode: 'read_only', canWrite: false });
    expect(organizationAccessFromServer({ access_mode: 'trial' }))
      .toEqual({ mode: 'read_only', canWrite: false });
    expect(organizationAccessFromServer({ access_mode: 'grace' }))
      .toEqual({ mode: 'read_only', canWrite: false });
  });
});
