import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { useQuery as useTanstackQuery } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthContext';
import { useFeatureFlags } from '../lib/flags';
import { DOMAIN, key } from '../lib/query/keys';
import { useOrgScope } from '../lib/query/orgScope';
import { BenefitWindowStrip, type BenefitWindowResponse } from './BenefitWindowStrip';

/**
 * The strip's one fetch, kept out of `Layout` so the shell does not grow a commercial concern.
 *
 * IT ASKS FOR NOTHING IT IS NOT GOING TO SHOW. The query is disabled unless the flag is on and the
 * reader is the owner — a non-owner never calls `my_benefit_window()` at all, rather than calling
 * it and discarding the answer. That is one fewer round trip on every screen for everybody else,
 * and it means the strip cannot leak the existence of an offer through network timing.
 *
 * `staleTime` is the resync interval: the clock re-anchors on the same cadence it refetches on, so
 * there is one freshness rule rather than two that can disagree.
 */
export function BenefitWindowMount() {
  const { profile } = useAuth();
  const org = useOrgScope();
  const { isEnabled } = useFeatureFlags();
  const navigate = useNavigate();

  const enabled = isEnabled('commerce.benefit_countdown');
  const isOwner = profile?.role === 'owner';

  const query = useTanstackQuery({
    queryKey: key(org, DOMAIN.organization, 'benefit-window'),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('my_benefit_window');
      if (error) throw error;
      return data as BenefitWindowResponse;
    },
    staleTime: 15 * 60_000,
    enabled: org !== null && enabled && isOwner,
  });

  const resync = useCallback(() => { void query.refetch(); }, [query]);

  // Fail closed, the same way `useFeatureFlags` does: a fetch that failed is not a window that is
  // open, and a commercial strip is the last thing that should render on stale belief.
  const data = query.error ? null : query.data ?? null;

  /**
   * The call to action RECORDS AN INTENTION and then goes on to the subscription screen, where
   * the same four facts live. It changes no plan, opens no billing period and charges nothing —
   * `record_launch_offer_intent` refuses to do any of those — so there is no confirmation step
   * and no step-up between the press and the row.
   *
   * A SECOND PRESS IS NOT AN ERROR. The command is idempotent per window: it reports
   * `already_recorded` and writes nothing at all, not even a log line. And a failure is not worth
   * blocking the navigation over: the person asked to talk to somebody, and taking them to the
   * screen where they can is the useful half.
   */
  const recordIntent = useCallback(async () => {
    await supabase.rpc('record_launch_offer_intent', { p_reason: null });
    void query.refetch();
    navigate('/settings/subscription');
  }, [navigate, query]);

  /**
   * The three things worth counting, and nothing else. `offer_redeemed` is a row in
   * `launch_offer_intents` and `offer_expired` is written by the grant sweep — neither is a thing
   * a browser can witness, so neither is reported from here.
   *
   * FAILURES ARE SWALLOWED ON PURPOSE. Telemetry that can break a screen is worse than telemetry
   * that is missing: the server caps these at one per day and refuses anything it does not
   * recognise, so a rejection here is either the ceiling working or a caller that should not have
   * asked. Neither is the reader's problem.
   */
  const report = useCallback((event: string, properties?: Record<string, string>) => {
    void supabase.rpc('record_my_countdown_event', {
      p_event_name: event, p_properties: properties ?? {},
    }).then(() => undefined, () => undefined);
  }, []);

  return (
    <BenefitWindowStrip data={data} enabled={enabled} isOwner={isOwner} onResync={resync}
      onImpression={() => report('countdown.impression')}
      onDismiss={(mode) => report('countdown.dismissed', { mode })}
      onCta={() => { report('countdown.cta_clicked'); void recordIntent(); }} />
  );
}
