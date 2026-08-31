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

  return (
    <BenefitWindowStrip data={data} enabled={enabled} isOwner={isOwner} onResync={resync}
      onCta={() => navigate('/settings/subscription')} />
  );
}
