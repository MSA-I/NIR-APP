import { describe, expect, it } from 'vitest';
import {
  APPLE_PRIVATE_RELAY_DOMAIN,
  backupEmailProblem,
  backupEmailRequired,
  isPrivateRelayAddress,
} from './backupEmail';

const relay = `owner@${APPLE_PRIVATE_RELAY_DOMAIN}`;

describe('private relay detection', () => {
  it('recognises the relay domain whatever case or padding it arrives in', () => {
    expect(isPrivateRelayAddress(relay)).toBe(true);
    expect(isPrivateRelayAddress('  Owner@PrivateRelay.AppleID.com  ')).toBe(true);
  });

  it('leaves a real mailbox alone — the requirement is about the address, not the provider', () => {
    // Owner ruling 1: a Google signup, or an Apple signup by somebody who chose to share their
    // real address, is asked for nothing at all.
    expect(isPrivateRelayAddress('owner@gmail.com')).toBe(false);
    expect(isPrivateRelayAddress('owner@icloud.com')).toBe(false);
    expect(isPrivateRelayAddress('owner@example.co.il')).toBe(false);
  });

  it('compares the domain exactly, so a lookalike is not a relay', () => {
    // A suffix check would call both of these Apple's relay. The second one is a domain an
    // attacker can register today.
    expect(isPrivateRelayAddress('owner@evil-privaterelay.appleid.com')).toBe(false);
    expect(isPrivateRelayAddress('owner@privaterelay.appleid.com.attacker.test')).toBe(false);
  });

  it('answers false rather than throwing for what is not an address at all', () => {
    expect(isPrivateRelayAddress('')).toBe(false);
    expect(isPrivateRelayAddress(null)).toBe(false);
    expect(isPrivateRelayAddress(undefined)).toBe(false);
    expect(isPrivateRelayAddress('no-at-sign')).toBe(false);
  });
});

describe('when a backup address is required', () => {
  it('is not required while enforcement is off, even for a relay address', () => {
    // Owner ruling 2, and the property DEBT §25 makes non-negotiable: the domain is not verified
    // and Resend is in sandbox, so a verification mail to a customer never arrives. A requirement
    // that shipped ON would make signup unreachable for every real customer.
    expect(backupEmailRequired(relay, { enforced: false })).toBe(false);
  });

  it('is required for a relay address once enforcement is switched on with Apple', () => {
    expect(backupEmailRequired(relay, { enforced: true })).toBe(true);
  });

  it('is never required for an address nobody else can switch off', () => {
    expect(backupEmailRequired('owner@gmail.com', { enforced: true })).toBe(false);
    expect(backupEmailRequired('', { enforced: true })).toBe(false);
  });
});

describe('what makes a nominated backup address usable', () => {
  it('accepts a real second mailbox', () => {
    expect(backupEmailProblem('owner@example.co.il', relay)).toBeNull();
  });

  it('names an empty nomination as missing rather than as malformed', () => {
    // The screen leans on this: an untouched field is not a mistake yet, so it must be
    // distinguishable from one that was filled in wrongly.
    expect(backupEmailProblem('', relay)).toBe('missing');
    expect(backupEmailProblem('   ', relay)).toBe('missing');
  });

  it('refuses the primary address itself, however it was capitalised', () => {
    expect(backupEmailProblem(relay, relay)).toBe('same_as_primary');
    expect(backupEmailProblem('OWNER@GMAIL.COM', 'owner@gmail.com')).toBe('same_as_primary');
  });

  it('refuses a second relay address — the same failure mode is not a backup', () => {
    expect(backupEmailProblem(`else@${APPLE_PRIVATE_RELAY_DOMAIN}`, relay)).toBe('still_a_relay');
  });

  it('refuses a malformed address and one past the RFC ceiling', () => {
    expect(backupEmailProblem('not-an-address', relay)).toBe('malformed');
    expect(backupEmailProblem(`${'a'.repeat(320)}@example.test`, relay)).toBe('too_long');
  });
});
