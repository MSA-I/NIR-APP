import { useId, useState } from 'react';
import { BrainCircuit, ListChecks, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { toHebrewError } from '../lib/errors';
import { ConfirmDialog, ErrorNote, Note, useToast } from './ui';

const POLICIES = [
  {
    key: 'document.interpretation',
    title: 'יצירת חשבוניות אוטומטית',
    description: 'מעל הסף, חשבונית מזוהה נוצרת ומקושרת בלי אישור אדם.',
    warning: 'כל מסמך ממשיך להיקרא ולהתפרש גם כשהמתג כבוי; רק הכתיבה הכספית נעצרת.',
    icon: BrainCircuit,
  },
  {
    key: 'price_list.intake',
    title: 'קליטת מחירונים אוטומטית',
    description: 'מעל הסף, שורות עם מק״ט או ברקוד חד־משמעיים נקלטות; השאר ממתינות.',
    warning: 'שם מוצר לעולם אינו מפתח התאמה. שורה שלא הותאמה יוצרת מוצר חדש רק כשיש בה שם וגם מק״ט או ברקוד; אחרת היא ממתינה.',
    icon: ListChecks,
  },
] as const;

interface AutonomyPolicy {
  policy_key: string;
  configured: boolean;
  autonomy_enabled: boolean;
  min_confidence: number | null;
  kill_switch: boolean;
}

function PolicyCard({
  policy,
  definition,
  orgId,
  refetch,
}: {
  policy: AutonomyPolicy;
  definition: typeof POLICIES[number];
  orgId: string;
  refetch: () => Promise<unknown>;
}) {
  const toast = useToast();
  const thresholdId = useId();
  const [threshold, setThreshold] = useState('');
  const [pendingEnable, setPendingEnable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveThreshold = threshold || String(policy.min_confidence ?? '0.900');
  const Icon = definition.icon;

  async function apply(enable: boolean, reason: string) {
    setBusy(true);
    const result = await supabase.rpc('platform_set_autonomy_policy', {
      p_org_id: orgId,
      p_policy_key: definition.key,
      p_autonomy_enabled: enable,
      p_min_confidence: Number(effectiveThreshold),
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (result.error) {
      toast(toHebrewError(result.error.message), 'error');
      return;
    }
    setPendingEnable(null);
    toast(enable ? 'המדיניות הופעלה ונרשמה ביומן הביקורת' : 'המדיניות כובתה');
    void refetch();
  }

  return (
    <article className="card card-pad space-y-4" data-testid={`autonomy-policy-${definition.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="section-title flex items-center gap-2">
          <Icon size={18} aria-hidden="true" /> {definition.title}
        </h3>
        <span className={policy.autonomy_enabled ? 'badge-alert' : 'badge-idle'}>
          {policy.autonomy_enabled ? 'מופעלת' : 'כבויה'}
        </span>
      </div>

      <p className="text-sm text-ink-body">{definition.description}</p>
      <Note tone={policy.autonomy_enabled ? 'await' : 'info'}>
        סף <span className="num">0.900</span> הוא ברירת מחדל שלא כוילה מול 50 מסמכים אמיתיים.
        אפשר רק להחמיר אותו. {definition.warning}
      </Note>

      <label>
        <span className="label">סף ביטחון מזערי</span>
        <input
          id={thresholdId}
          className="input num"
          type="number"
          min="0.9"
          max="1"
          step="0.005"
          dir="ltr"
          value={effectiveThreshold}
          onChange={(event) => setThreshold(event.target.value)}
        />
      </label>

      {policy.kill_switch && (
        <Note tone="alert" role="alert">
          מתג החירום הכללי פעיל; שינוי כאן לא יפעיל את המדיניות.
        </Note>
      )}

      <div className="flex justify-end">
        <button
          className={policy.autonomy_enabled ? 'btn-secondary' : 'btn-danger'}
          disabled={busy || (!policy.autonomy_enabled && policy.kill_switch)}
          onClick={() => setPendingEnable(!policy.autonomy_enabled)}
        >
          {busy && <Loader2 className="animate-spin motion-reduce:animate-none" size={17} aria-hidden="true" />}
          {policy.autonomy_enabled ? 'כיבוי' : 'הפעלה'}
        </button>
      </div>

      <ConfirmDialog
        open={pendingEnable !== null}
        busy={busy}
        danger={pendingEnable === true}
        requireReason
        title={pendingEnable ? `הפעלת ${definition.title}` : `כיבוי ${definition.title}`}
        message={pendingEnable
          ? `מעל סף ${effectiveThreshold} המערכת תפעל בלי אישור אדם. הסף טרם כויל; כל פעולה נרשמת וניתנת לביטול מנומק.`
          : 'המערכת תמשיך לקרוא ולהציע, אך לא תכתוב פעולה חדשה. פעולות קודמות אינן מתבטלות.'}
        confirmLabel={pendingEnable ? 'הפעלה' : 'כיבוי'}
        onClose={() => setPendingEnable(null)}
        onConfirm={(reason) => {
          if (pendingEnable !== null) void apply(pendingEnable, reason ?? '');
        }}
      />
    </article>
  );
}

export function AutonomyPolicyPanel({ orgId, orgName }: { orgId: string; orgName: string }) {
  const { data, loading, error, refetch } = useQuery(async () => {
    const rows = await Promise.all(POLICIES.map(async ({ key }) => {
      const result = await supabase.rpc('evaluate_autonomy_policy', { p_policy_key: key });
      return (unwrap(result) as AutonomyPolicy[])[0] ?? null;
    }));
    return rows;
  });

  if (loading) return <div className="card card-pad text-sm text-ink-muted">טוען את מדיניות האוטונומיה…</div>;
  if (error) return <ErrorNote message={error} />;
  if (!data || data.some((policy) => !policy)) {
    return <ErrorNote message="מדיניות האוטונומיה אינה זמינה." />;
  }

  return (
    <section className="space-y-4" data-testid="autonomy-policy-panel">
      <div>
        <h2 className="section-title">אוטונומיית מסמכים</h2>
        <p className="mt-1 text-sm text-ink-muted">{orgName}</p>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {POLICIES.map((definition, index) => (
          <PolicyCard
            key={definition.key}
            policy={data[index]!}
            definition={definition}
            orgId={orgId}
            refetch={refetch}
          />
        ))}
      </div>
    </section>
  );
}
