/**
 * Defect 15 — the role dictionaries after the three personas retired (`0133`).
 *
 * The `user_role` enum is frozen (77 RLS policies), so "retired" can only ever be a statement
 * about the *labels*: which roles a tenant may still name, and how a role that is no longer
 * assignable reads when a historical row renders it. Both halves are pinned here.
 *
 * The dictionaries now hold KEYS rather than Hebrew, so the assertions resolve through `he` — and
 * still pin the literal text, which is what keeps them able to catch a key that changed meaning.
 */
import { describe, expect, it } from 'vitest';
import { ACTIVE_ROLE_LABEL, HISTORICAL_ROLE_LABEL, ROLE_LABEL, resolveRoleLabels } from './status';
import { ACTIVE_ROLES } from './types';
import { he } from './i18n/dictionaries/he';

const RETIRED = ['kitchen', 'payer', 'supplier'] as const;

/** What the app passes in: a resolver that turns a status key into text in the active language. */
const inHebrew = (key: string) => (he.status as Record<string, string>)[key] ?? '';
const HE = Object.fromEntries(Object.entries(ROLE_LABEL).map(([role, key]) => [role, inHebrew(key)]));

describe('role label dictionaries', () => {
  it('holds exactly the three roles the product can still assign', () => {
    expect(Object.keys(ACTIVE_ROLE_LABEL).sort()).toEqual(['accountant', 'office', 'owner']);
    // Same three the routing, guards and invitations already agree on — one product contract.
    expect(Object.keys(ACTIVE_ROLE_LABEL).sort()).toEqual([...ACTIVE_ROLES].sort());
    for (const retired of RETIRED) expect(ACTIVE_ROLE_LABEL).not.toHaveProperty(retired);
  });

  it('names every retired persona as history, in both languages', () => {
    expect(Object.keys(HISTORICAL_ROLE_LABEL).sort()).toEqual([...RETIRED].sort());
    for (const key of Object.values(HISTORICAL_ROLE_LABEL)) {
      expect(inHebrew(key)).toContain('היסטורי');
    }
  });

  it('unions the two so an archive row still renders a name', () => {
    expect(ROLE_LABEL.payer).toBe(HISTORICAL_ROLE_LABEL.payer);
    expect(ROLE_LABEL.kitchen).toBe(HISTORICAL_ROLE_LABEL.kitchen);
    expect(ROLE_LABEL.supplier).toBe(HISTORICAL_ROLE_LABEL.supplier);
    expect(ROLE_LABEL.owner).toBe(ACTIVE_ROLE_LABEL.owner);
    expect(Object.keys(ROLE_LABEL)).toHaveLength(6);
  });

  it('gives every role a real label rather than leaking its key', () => {
    for (const [role, key] of Object.entries(ROLE_LABEL)) {
      expect(inHebrew(key), role).toBeTruthy();
      expect(inHebrew(key), role).not.toBe(key);
    }
  });
});

describe('resolveRoleLabels', () => {
  it('accepts a tenant override only for a role the tenant can actually assign', () => {
    const resolved = resolveRoleLabels({ role_labels: { office: 'מנהל הזמנות', payer: 'x' } }, inHebrew);
    expect(resolved.office).toBe('מנהל הזמנות');
    // A retired role keeps its historical label: renaming it would put a current job title on a
    // closed account, and there is no live account left to name.
    expect(resolved.payer).toBe(HE.payer);
    expect(resolved.kitchen).toBe(HE.kitchen);
    expect(resolved.supplier).toBe(HE.supplier);
  });

  it('keeps treating the jsonb blob as untrusted', () => {
    expect(resolveRoleLabels({ role_labels: { chef: 'שף' } }, inHebrew)).not.toHaveProperty('chef');
    expect(resolveRoleLabels({ role_labels: { office: '   ' } }, inHebrew).office).toBe(HE.office);
    expect(resolveRoleLabels({ role_labels: { office: 7 } }, inHebrew).office).toBe(HE.office);
    expect(resolveRoleLabels({ role_labels: 'nope' }, inHebrew)).toEqual(HE);
    expect(resolveRoleLabels(null, inHebrew)).toEqual(HE);
    expect(resolveRoleLabels(undefined, inHebrew)).toEqual(HE);
  });

  it('trims a real override and leaves the roles the tenant did not touch alone', () => {
    const resolved = resolveRoleLabels({ role_labels: { accountant: '  רו״ח חיצוני  ' } }, inHebrew);
    expect(resolved.accountant).toBe('רו״ח חיצוני');
    expect(resolved.owner).toBe(HE.owner);
    expect(resolved.office).toBe(HE.office);
  });

  it("keeps a tenant's own word for a role in EVERY language — they already answered that question", () => {
    const inEnglish = (key: string) => `EN:${key}`;
    const resolved = resolveRoleLabels({ role_labels: { office: 'מנהל הזמנות' } }, inEnglish);
    expect(resolved.office).toBe('מנהל הזמנות');
    expect(resolved.owner).toBe('EN:role_owner');
  });
});
