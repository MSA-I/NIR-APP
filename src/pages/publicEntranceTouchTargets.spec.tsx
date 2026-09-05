import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

/**
 * THE 44px FLOOR ON THE PUBLIC ENTRANCE — `ENTRY-12`.
 *
 * Measured 04.09.2026 at 390x844: `/login` «שכחתי סיסמה» 20px and «להרשמה» 20px, its two footer
 * links 16px, `/signup` «התחברות» 20px, `/forgot-password` «חזרה למסך הכניסה» 19px. WCAG 2.1 AA
 * carries no target-size criterion, which is why the finding is low — it is measured against THIS
 * PRODUCT'S own standard. `src/styles/plan-card.css` calls 2.75rem «the 44px touch target the rest
 * of the product holds to», and `Entrance.tsx` writes beside the consent control that `min-h-11`
 * «is not decoration». Six controls on the one screen every visitor must pass through were the
 * exception nobody had decided to make.
 *
 * WHY A CLASS AND NOT A HEIGHT HERE. jsdom lays nothing out and loads no Tailwind, so a height
 * measured in this file would be a number about nothing. The rendered heights are measured in a
 * real browser by `scripts/measure-public-entrance.mjs`, which is the oracle of record for the
 * finding; this spec pins the utility that produces them, in the product's own vocabulary, so the
 * floor cannot be removed by an edit that never opens a browser.
 */
const signIn = vi.hoisted(() => vi.fn());

vi.mock('../lib/authProviders', () => ({
  FEDERATED_PROVIDERS: ['google', 'apple'],
  FEDERATED_PROVIDER_LABEL: { google: 'Google', apple: 'Apple' },
  enabledFederatedProviders: () => [] as ('google' | 'apple')[],
  startFederatedSignup: vi.fn(async () => ({ error: null })),
  backupEmailRequirementEnforced: () => false,
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      signInWithOAuth: vi.fn(async () => ({ error: null })),
      resend: vi.fn(async () => ({ data: {}, error: null })),
      resetPasswordForEmail: vi.fn(async () => ({ error: null })),
    },
  },
}));

vi.mock('../auth/AuthContext', () => ({
  homeFor: () => '/dashboard',
  useAuth: () => ({ signIn, session: null, profile: null, loading: false }),
}));

import ForgotPassword from './ForgotPassword';
import Login from './Login';
import Signup from './Signup';

/**
 * The floor, expressed the way the product expresses it. `min-h-11` is 2.75rem = 44px; anything
 * taller obviously satisfies it, and a `btn-*` class carries the floor in the stylesheet itself.
 */
const FLOOR = /(^|\s)(min-h-(1[1-9]|[2-9]\d)|h-(1[1-9]|[2-9]\d)|btn-(primary|secondary))(\s|$)/;

const holdsTheFloor = (el: Element | null, name: string) => {
  expect(el, `${name} was not found — the selector drifted`).not.toBeNull();
  expect(
    el!.className,
    `${name} carries no 44px floor: class="${el!.className}". On a phone it renders 16-20px `
    + 'tall, against the floor plan-card.css and Entrance.tsx both cite (ENTRY-12).',
  ).toMatch(FLOOR);
};

/** The switch between «I have an account» and «I am opening a business» — a button, not a link. */
const switchControl = () =>
  screen.getByRole('main').querySelector('form ~ p button');

describe('גובה הפקדים בכניסה הציבורית', () => {
  it('/login — שכחתי סיסמה, המעבר להרשמה ושתי שורות הכותרת התחתונה', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    const main = screen.getByRole('main');
    holdsTheFloor(main.querySelector('a[href="/forgot-password"]'), '«שכחתי סיסמה»');
    holdsTheFloor(switchControl(), '«להרשמה»');
    holdsTheFloor(main.querySelector('a[href="/terms"]'), '«תנאי שימוש»');
    holdsTheFloor(main.querySelector('a[href="/privacy"]'), '«מדיניות פרטיות»');
  });

  it('/signup — המעבר חזרה להתחברות', () => {
    render(<MemoryRouter><Signup /></MemoryRouter>);
    holdsTheFloor(switchControl(), '«התחברות»');
  });

  it('/forgot-password — חזרה למסך הכניסה', () => {
    const { container } = render(<MemoryRouter><ForgotPassword /></MemoryRouter>);
    holdsTheFloor(container.querySelector('a[href="/login"]'), '«חזרה למסך הכניסה»');
  });

  /**
   * The positive control. These are the strings the finding measured; if the screen stops
   * rendering them the assertions above would pass by measuring nothing.
   */
  it('הפקדים שנמדדו הם באמת אלה שעל המסך', () => {
    render(<MemoryRouter><Login /></MemoryRouter>);
    const main = screen.getByRole('main');
    expect(main.querySelector('a[href="/forgot-password"]')?.textContent).toContain('שכחתי סיסמה');
    expect(switchControl()?.textContent).toContain('להרשמה');
    expect(main.querySelector('a[href="/terms"]')?.textContent).toContain('תנאי שימוש');
    expect(main.querySelector('a[href="/privacy"]')?.textContent).toContain('מדיניות פרטיות');
  });
});
