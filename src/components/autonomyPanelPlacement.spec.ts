// Where the autonomy switch lives, pinned to source.
//
// The owner looked for it and did not find it: it had been mounted on /admin, which is behind
// PlatformGuard and is not where anyone reaches for a business setting. "הוא אמור להיות בהגדרות."
// This file is the pin, because the failure it catches is placement — a rendering test of the
// panel in isolation stays green while the panel sits on a screen nobody opens.
//
// The idiom (source scan rather than render) is the one serverListScreens.spec.tsx already uses
// for exactly this class of invariant.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const srcDir = join(process.cwd(), 'src');
const read = (...parts: string[]) => readFileSync(join(srcDir, ...parts), 'utf8');

describe('the autonomy switch is reachable from הגדרות, and only by someone who can use it', () => {
  const settings = read('pages', 'Settings.tsx');

  it('is mounted on the settings screen', () => {
    expect(settings).toContain("import { AutonomyPolicyPanel } from '../components/AutonomyPolicyPanel'");
    expect(settings).toContain('<AutonomyPolicyPanel');
  });

  it('is gated on isPlatformAdmin, not on the owner role alone', () => {
    // platform_set_autonomy_policy raises not_platform_admin for anyone else (0076:270-272), so an
    // ungated panel would be a control that refuses on submit. App.tsx already restricts /settings
    // to owner; this gate is the second half, and it is the one that matters.
    expect(settings).toMatch(/isPlatformAdmin && org && <AutonomyPolicyPanel/);
    expect(settings).toMatch(/const \{[^}]*isPlatformAdmin[^}]*\} = useAuth\(\)/);
  });

  it('is mounted in exactly one place', () => {
    // Two copies of a switch that writes financial authority is two places to read a stale state.
    const admin = read('pages', 'Admin.tsx');
    expect(admin).not.toContain('AutonomyPolicyPanel');
  });

  it('names the uncalibrated floor on the panel itself', () => {
    // OPEN-DECISIONS #109 / DEBT-REGISTER §16. The number that permits a machine to write money is
    // a documented guess; the screen that moves it must say so where it cannot be missed.
    const panel = read('components', 'AutonomyPolicyPanel.tsx');
    expect(panel).toContain('0.900');
    expect(panel).toMatch(/לא כוילה|לא כויל/);
    // The reason is structural, not optional: the command refuses without one.
    expect(panel).toContain('requireReason');
    expect(panel).toContain("key: 'document.interpretation'");
    expect(panel).toContain("key: 'price_list.intake'");
    expect(panel).toContain('autonomy-policy-');
  });
});
