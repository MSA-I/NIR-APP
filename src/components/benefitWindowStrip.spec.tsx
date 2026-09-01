// The launch-benefit strip.
//
// `#204` forbids a manufactured countdown. The owner's ruling of 31.08.2026 says what that means —
// a clock over an INVENTED date is banned, a window the server enforces is not — and every
// assertion here is about staying on the right side of that line. The strip can cross it in four
// ways: by ticking seconds, by inventing a moment the server does not enforce, by following a
// clock the reader controls, or by shouting at a screen reader. Each one is pinned.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BenefitWindowStrip, remaining, type BenefitWindowResponse } from './BenefitWindowStrip';
import { LocaleProvider } from '../lib/i18n/LocaleProvider';

const ENDS = '2027-02-01T00:00:00+00:00';

function response(over: Partial<BenefitWindowResponse> = {}): BenefitWindowResponse {
  return {
    server_now: '2027-01-29T09:30:00+00:00',
    has_paid: false,
    eligible: true,
    window: {
      kind: 'prelaunch_grant', starts_at: null, ends_at: ENDS,
      plan_key: 'premium', reverts_to_plan_key: 'free',
    },
    ...over,
  };
}

function show(data: BenefitWindowResponse | null, over: Partial<Parameters<typeof BenefitWindowStrip>[0]> = {}) {
  return render(
    <LocaleProvider>
      <BenefitWindowStrip data={data} enabled isOwner {...over} />
    </LocaleProvider>,
  );
}

afterEach(() => { vi.useRealTimers(); });

describe('the strip renders only when every condition holds', () => {
  it.each([
    ['the flag is off', { enabled: false }],
    ['the reader is not the owner', { isOwner: false }],
  ])('renders nothing when %s', (_label, over) => {
    const { container } = show(response(), over);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['the tenant has paid', { has_paid: true }],
    ['there is no window', { window: null }],
    // 0269: this window was already answered. A LATER window is a different window and is
    // offered again, which is why the server keys the intent on the boundary.
    ['the window was already answered', { intent_recorded: true }],
    ['the reader is refused by the server', { status: 'not_permitted' as const }],
  ])('renders nothing when %s', (_label, over) => {
    const { container } = show(response(over));
    expect(container).toBeEmptyDOMElement();
  });

  /** And an intent against a DIFFERENT window does not silence this one. */
  it('keeps offering a window that has not been answered', () => {
    show(response({ intent_recorded: false }));
    expect(screen.getByRole('region')).toBeInTheDocument();
  });

  /** No skeleton. A placeholder for a commercial strip is noise on every screen in the product. */
  it('renders nothing at all before there is an answer', () => {
    const { container } = show(null);
    expect(container).toBeEmptyDOMElement();
  });

  /** A window that has passed is nothing — never `00:00`, never a negative number. */
  it('renders nothing once the boundary is behind us', () => {
    const { container } = show(response({ server_now: '2027-02-02T00:00:00+00:00' }));
    expect(container).toBeEmptyDOMElement();
    expect(remaining(ENDS, new Date('2027-02-02T00:00:00Z'))).toBeNull();
    expect(remaining(ENDS, new Date(ENDS))).toBeNull();
  });
});

describe('the resolution never becomes a ticking clock', () => {
  it('says whole days and whole hours while there is more than a day', () => {
    // HALF PAST, not on the hour. 10:00 leaves exactly 62 hours, so a single millisecond of
    // elapsed time floors it to 61 and the assertion flips to thirteen — a test that passes on a
    // fast machine and fails on a slow one. A browser screenshot found this before CI did.
    show(response({ server_now: '2027-01-29T09:30:00+00:00' }));
    // 62.5 hours: two days and fourteen, with half an hour of slack on either side.
    expect(screen.getByText(/2 days and 14 hours/)).toBeInTheDocument();
  });

  /**
   * THE ONE THE PLAN SPELLS OUT. Inside the last day the counter is replaced by the real moment,
   * in the BUSINESS timezone — because "today at 23:59" would name an instant the server does not
   * enforce, and that is a manufactured deadline whatever it is dressed as.
   */
  it('shows the real ending moment inside the last day, not a smaller counter', () => {
    show(response({ server_now: '2027-01-31T18:00:00+00:00' }));
    expect(screen.queryByText(/hours/)).toBeNull();
    // 2027-02-01T00:00Z is 02:00 on the 1st in Asia/Jerusalem — not 23:59 on the 31st. The date
    // appears twice on purpose (the headline and the line that says what happens next), so this
    // reads the headline rather than asking for a unique match.
    expect(screen.getByText(/ends 01\.02\.2027, 02:00/)).toBeInTheDocument();
  });

  it('never renders a seconds counter at any range', () => {
    for (const at of ['2027-01-01T00:00:00+00:00', '2027-01-31T18:00:00+00:00',
                      '2027-01-31T23:59:00+00:00']) {
      const { container, unmount } = show(response({ server_now: at }));
      expect(container.textContent).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
      unmount();
    }
  });

  it('counts in whole units and never rounds a partial hour up into existence', () => {
    expect(remaining(ENDS, new Date('2027-01-30T00:59:00Z'))).toEqual({ days: 1, hours: 23 });
    expect(remaining(ENDS, new Date('2027-01-31T23:01:00Z'))).toEqual({ days: 0, hours: 0 });
  });
});

describe('the clock is the server’s, not the device’s', () => {
  /**
   * THE ASSERTION THIS FEATURE EXISTS FOR. The anchor is `performance.now()`, which no clock
   * change touches. An implementation storing `serverNow - Date.now()` passes a naive test and
   * then follows the reader's clock the moment it moves — an NTP correction, a manual change, a
   * laptop waking from suspend.
   */
  it('reads the elapsed time from a monotonic source, never from Date.now()', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/serverClock.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(source).toContain('performance.now()');
    expect(source).not.toContain('Date.now()');
  });

  it('does not move when the device clock jumps an hour after the fetch', async () => {
    vi.useFakeTimers({ now: new Date('2027-01-29T10:00:00Z'), toFake: ['Date'] });
    const { container } = show(response({ server_now: '2027-01-29T10:00:00+00:00' }));
    const before = container.textContent;
    // The device clock lurches forward. `performance.now()` is untouched, and so is the strip.
    vi.setSystemTime(new Date('2027-01-29T11:00:00Z'));
    expect(container.textContent).toBe(before);
  });

  it('re-anchors and refetches on the events that mean the tab may have slept', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/lib/serverClock.ts'), 'utf8');
    for (const event of ['focus', 'pageshow', 'visibilitychange']) {
      expect(source).toContain(event);
    }
    expect(source).toContain('RESYNC_INTERVAL_MS = 15 * 60_000');
    // Once a minute, never once a second.
    expect(source).toContain('TICK_INTERVAL_MS = 60_000');
  });
});

describe('what the strip refuses to be', () => {
  /** Not an alert, not a live region. A benefit that ends is not an emergency. */
  it('carries no role="alert" and no aria-live anywhere', () => {
    const { container } = show(response());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
  });

  /**
   * The accessible name carries the DATE, not the counter. A name that changed every minute is a
   * name a screen reader would announce every minute.
   */
  it('names itself with the date, and hides the counter from the accessibility tree', () => {
    show(response());
    const strip = screen.getByRole('region');
    expect(strip).toHaveAccessibleName(/01\.02\.2027/);
    expect(strip).toHaveAccessibleName(/Premium/i);
    // The visual half is hidden, so the counter is never read out.
    expect(strip.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  /** No motion anywhere, which is why there is no reduced-motion branch to write. */
  it('has no animation, transition or colour change to reduce', () => {
    // Comments stripped first: the paragraph explaining why there is no reduced-motion branch
    // names the thing it is explaining, and matched itself on the first run of this test.
    const source = readFileSync(resolve(process.cwd(), 'src/components/BenefitWindowStrip.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    expect(source).not.toMatch(/animate-|transition-|motion-safe|prefers-reduced-motion/);
  });

  /** Nothing a person reads came from the server as text: the RPC returns plan KEYS. */
  it('translates the plan key rather than printing a server string', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/BenefitWindowStrip.tsx'), 'utf8');
    expect(source).toContain('planName(data.window.plan_key, null)');
    expect(source).not.toContain('plan_label');
  });
});

describe('the three events, and the two that are not events', () => {
  it('reports the impression once, no matter how often it re-renders', () => {
    const onImpression = vi.fn();
    const { rerender } = show(response(), { onImpression });
    rerender(
      <LocaleProvider>
        <BenefitWindowStrip data={response()} enabled isOwner onImpression={onImpression} />
      </LocaleProvider>,
    );
    expect(onImpression).toHaveBeenCalledTimes(1);
  });

  it('does not report an impression it never made', () => {
    const onImpression = vi.fn();
    show(response({ has_paid: true }), { onImpression });
    expect(onImpression).not.toHaveBeenCalled();
  });

  /** Minimising is the same decision as closing, at a different depth — not a fourth name. */
  it('reports minimising and closing as one event with two modes', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    const { unmount } = show(response(), { onDismiss });
    await user.click(screen.getByRole('button', { name: 'Minimise the strip' }));
    expect(onDismiss).toHaveBeenCalledWith('minimized');
    unmount();

    show(response(), { onDismiss });
    await user.click(screen.getByRole('button', { name: 'Close the strip' }));
    expect(onDismiss).toHaveBeenCalledWith('closed');
  });

  it('reports the press before it records the intention', async () => {
    const user = userEvent.setup();
    const onCta = vi.fn();
    show(response(), { onCta });
    await user.click(screen.getByRole('button', { name: 'Talk to me about continuing' }));
    expect(onCta).toHaveBeenCalled();

    const mount = readFileSync(resolve(process.cwd(), 'src/components/BenefitWindowMount.tsx'), 'utf8');
    expect(mount).toContain("report('countdown.cta_clicked'); void recordIntent();");
    // Three names and no more: the two server-observed facts are not reported from a browser.
    const code = mount.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    expect(code).not.toMatch(/offer_redeemed|offer_expired/);
  });

  /** Telemetry that can break a screen is worse than telemetry that is missing. */
  it('never lets a rejected report reach the reader', () => {
    const mount = readFileSync(resolve(process.cwd(), 'src/components/BenefitWindowMount.tsx'), 'utf8');
    expect(mount).toContain('.then(() => undefined, () => undefined)');
  });
});

describe('minimising and closing', () => {
  it('minimises to a single line that still names the benefit', async () => {
    const user = userEvent.setup();
    show(response());
    await user.click(screen.getByRole('button', { name: 'Minimise the strip' }));
    expect(screen.queryByRole('button', { name: /Talk to me/ })).toBeNull();
    expect(screen.getByRole('region')).toHaveAccessibleName(/01\.02\.2027/);
    expect(screen.getByRole('button', { name: 'Show the benefit details' })).toBeInTheDocument();
  });

  /** The press records an intention and nothing else: no plan change, no charge, no step-up. */
  it('records the intention through the command, then goes where the facts are', () => {
    const mount = readFileSync(resolve(process.cwd(), 'src/components/BenefitWindowMount.tsx'), 'utf8');
    expect(mount).toContain("supabase.rpc('record_launch_offer_intent'");
    expect(mount).toContain("navigate('/settings/subscription')");
    // Nothing here confirms, charges or asks for a password. Matched against CODE, not prose: the
    // comment explaining that it opens no billing period contains the word it forbids, and it
    // failed on this assertion's first run.
    const code = mount.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    expect(code).not.toMatch(/ConfirmDialog|Reauth|checkout|billing/i);
  });

  it('closes to nothing, and the offer survives elsewhere', async () => {
    const user = userEvent.setup();
    const { container } = show(response());
    await user.click(screen.getByRole('button', { name: 'Close the strip' }));
    expect(container).toBeEmptyDOMElement();
    // The four facts are still on /settings/subscription — this is the CTA's destination too.
    const mount = readFileSync(resolve(process.cwd(), 'src/components/BenefitWindowMount.tsx'), 'utf8');
    expect(mount).toContain("navigate('/settings/subscription')");
  });

  it('offers the call to action without a word of pressure', () => {
    const onCta = vi.fn();
    show(response(), { onCta });
    const cta = screen.getByRole('button', { name: 'Talk to me about continuing' });
    expect(cta).toBeInTheDocument();
    expect(cta.textContent).not.toMatch(/hurry|now|last|only|left/i);
  });
});
