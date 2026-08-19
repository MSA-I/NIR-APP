/**
 * Defect 15 — the role dictionaries after the three personas retired (`0133`).
 *
 * The `user_role` enum is frozen (77 RLS policies), so "retired" can only ever be a statement
 * about the *labels*: which roles a tenant may still name, and how a role that is no longer
 * assignable reads when a historical row renders it. Both halves are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { ACTIVE_ROLE_LABEL, HISTORICAL_ROLE_LABEL, ROLE_LABEL, resolveRoleLabels } from './status';
import { ACTIVE_ROLES } from './types';

const RETIRED = ['kitchen', 'payer', 'supplier'] as const;

describe('role label dictionaries', () => {
  it('holds exactly the three roles the product can still assign', () => {
    expect(Object.keys(ACTIVE_ROLE_LABEL).sort()).toEqual(['accountant', 'office', 'owner']);
    // Same three the routing, guards and invitations already agree on — one product contract.
    expect(Object.keys(ACTIVE_ROLE_LABEL).sort()).toEqual([...ACTIVE_ROLES].sort());
    for (const retired of RETIRED) expect(ACTIVE_ROLE_LABEL).not.toHaveProperty(retired);
  });

  it('names every retired persona as history', () => {
    expect(Object.keys(HISTORICAL_ROLE_LABEL).sort()).toEqual([...RETIRED].sort());
    for (const label of Object.values(HISTORICAL_ROLE_LABEL)) expect(label).toContain('היסטורי');
  });

  it('unions the two so an archive row still renders a name', () => {
    expect(ROLE_LABEL.payer).toBe(HISTORICAL_ROLE_LABEL.payer);
    expect(ROLE_LABEL.kitchen).toBe(HISTORICAL_ROLE_LABEL.kitchen);
    expect(ROLE_LABEL.supplier).toBe(HISTORICAL_ROLE_LABEL.supplier);
    expect(ROLE_LABEL.owner).toBe(ACTIVE_ROLE_LABEL.owner);
    expect(Object.keys(ROLE_LABEL)).toHaveLength(6);
  });
});

describe('resolveRoleLabels', () => {
  it('accepts a tenant override only for a role the tenant can actually assign', () => {
    const resolved = resolveRoleLabels({ role_labels: { office: 'מנהל הזמנות', payer: 'x' } });
    expect(resolved.office).toBe('מנהל הזמנות');
    // A retired role keeps its historical label: renaming it would put a current job title on a
    // closed account, and there is no live account left to name.
    expect(resolved.payer).toBe(HISTORICAL_ROLE_LABEL.payer);
    expect(resolved.kitchen).toBe(HISTORICAL_ROLE_LABEL.kitchen);
    expect(resolved.supplier).toBe(HISTORICAL_ROLE_LABEL.supplier);
  });

  it('keeps treating the jsonb blob as untrusted', () => {
    expect(resolveRoleLabels({ role_labels: { chef: 'שף' } })).not.toHaveProperty('chef');
    expect(resolveRoleLabels({ role_labels: { office: '   ' } }).office).toBe(ACTIVE_ROLE_LABEL.office);
    expect(resolveRoleLabels({ role_labels: { office: 7 } }).office).toBe(ACTIVE_ROLE_LABEL.office);
    expect(resolveRoleLabels({ role_labels: 'nope' })).toBe(ROLE_LABEL);
    expect(resolveRoleLabels(null)).toBe(ROLE_LABEL);
    expect(resolveRoleLabels(undefined)).toBe(ROLE_LABEL);
  });

  it('trims a real override and leaves the roles the tenant did not touch alone', () => {
    const resolved = resolveRoleLabels({ role_labels: { accountant: '  רו״ח חיצוני  ' } });
    expect(resolved.accountant).toBe('רו״ח חיצוני');
    expect(resolved.owner).toBe(ACTIVE_ROLE_LABEL.owner);
    expect(resolved.office).toBe(ACTIVE_ROLE_LABEL.office);
  });
});
