import { useT } from '../lib/i18n/LocaleProvider';
import { useId, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { Card, ErrorNote, PageHeader, SkeletonList } from '../components/ui';
import { ORG_STATUS } from '../lib/status';
import type { PlatformOrg } from '../lib/platform';
import { AutonomyPolicyPanel } from './AutonomyPolicyPanel';

/**
 * The org picker the panel needed to leave tenant Settings. Inside Settings the organization
 * was implicit — the signed-in tenant's own. An operator has no implicit organization, so the
 * choice is explicit here and the panel below reads through the platform door
 * (platform_get_autonomy_policies, 0147) instead of the tenant-scoped evaluator.
 */
export default function AutonomyPolicies() {
  const { statusLabel } = useT();
  const pickerId = useId();
  const [orgId, setOrgId] = useState('');
  const { data: orgs, loading, error } = useQuery(async () =>
    unwrap(await supabase.rpc('platform_orgs')) as PlatformOrg[]);
  const selected = orgs?.find((org) => org.id === orgId) ?? null;

  if (loading) return <SkeletonList rows={3} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <PageHeader title="אוטונומיית מסמכים" />
      <Card className="max-w-md">
        <label className="label" htmlFor={pickerId}>ארגון</label>
        <select
          id={pickerId}
          className="input"
          value={orgId}
          onChange={(event) => setOrgId(event.target.value)}
        >
          <option value="">בחירת ארגון…</option>
          {(orgs ?? []).map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}{org.status !== 'active' ? ` (${statusLabel(ORG_STATUS[org.status])})` : ''}
            </option>
          ))}
        </select>
      </Card>
      {selected
        ? <AutonomyPolicyPanel orgId={selected.id} orgName={selected.name} />
        : <p className="text-sm text-ink-muted">יש לבחור ארגון כדי לצפות במדיניות האוטונומיה שלו ולשנות אותה.</p>}
    </div>
  );
}
