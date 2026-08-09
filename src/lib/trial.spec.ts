/** #15 (decided 09.08.2026): the soft block fires only for a `trial` org whose end passed. */
import { describe, expect, it } from 'vitest';
import { isTrialExpired } from './trial';

const NOW = new Date('2026-08-09T12:00:00Z');

describe('isTrialExpired', () => {
  it('expired trial blocks', () => {
    expect(isTrialExpired({ status: 'trial', trial_ends_at: '2026-08-08T00:00:00Z' }, NOW)).toBe(true);
  });

  it('a trial that has not ended yet does not block', () => {
    expect(isTrialExpired({ status: 'trial', trial_ends_at: '2026-08-10T00:00:00Z' }, NOW)).toBe(false);
  });

  it('only trial status counts — an active org with a stale date is untouched', () => {
    expect(isTrialExpired({ status: 'active', trial_ends_at: '2020-01-01T00:00:00Z' }, NOW)).toBe(false);
    expect(isTrialExpired({ status: 'suspended', trial_ends_at: '2020-01-01T00:00:00Z' }, NOW)).toBe(false);
  });

  it('no date, no org — no block', () => {
    expect(isTrialExpired({ status: 'trial', trial_ends_at: null }, NOW)).toBe(false);
    expect(isTrialExpired(null, NOW)).toBe(false);
    expect(isTrialExpired({ status: 'trial', trial_ends_at: 'not-a-date' }, NOW)).toBe(false);
  });
});
