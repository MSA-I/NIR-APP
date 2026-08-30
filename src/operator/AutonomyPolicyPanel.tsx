import { useT } from '../lib/i18n/LocaleProvider';
import { useId, useState } from 'react';
import { BrainCircuit, ListChecks, Loader2, PackageCheck, Scissors } from 'lucide-react';
import {
  AUTOMATIC_SPLIT_PAGE_CEILING, PAID_OCR_PAGE_CAP,
} from '../components/document-review/serverLimits';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { Card, ConfirmDialog, ErrorNote, ICON, Note, useToast } from '../components/ui';

/**
 * The organization's autonomy switches, in the order a file meets them: a mixed PDF is split
 * first, and only then is each part interpreted, matched to a price list or turned into a
 * receiving draft.
 *
 * `document.packet_split` (migration 0140) was live for weeks with no row in this list, so an
 * owner who read "everything is enabled in my settings" was reading a true sentence about three
 * policies and an invisible fourth. A switch that exists in the database and not in the product is
 * a setting nobody chose.
 */
const POLICIES = [
  {
    key: 'document.packet_split',
    title: 'פיצול קובץ שיש בו כמה מסמכים',
    description: 'מעל הסף, קובץ PDF שהמודל קרא בו כמה מסמכים נחתך למסמכי בת נפרדים, וכל אחד מהם נכנס לעיבוד בפני עצמו.',
    // What it does NOT do is the load-bearing half: this switch moves paper, never money. The
    // remaining conditions are named because a switch that looks like it will work and then does
    // not is worse than no switch — and the last sentence is the case the owner will actually hit.
    // Both numbers come from `serverLimits.ts`, where they are declared side by side: they are
    // different limits that happened to be the same number until migration 0144.
    warning: <>
      הפיצול אינו כותב שום דבר כספי: כל מסמך בת עובר קריאה, בדיקה ואישור בנפרד, בדיוק כמו מסמך
      שצולם לבדו. גם כשהמתג פועל הפיצול נשאר ידני כשלא כל הקובץ נקרא, כשהקובץ ארוך
      מ־<span className="num">{AUTOMATIC_SPLIT_PAGE_CEILING}</span> עמודים, או כשחלק כלשהו בקובץ
      נקרא מתחת לסף. בפועל: קובץ <strong>סרוק</strong> נקרא עד
      <span className="num"> {PAID_OCR_PAGE_CAP} </span>עמודים בלבד, ולכן סריקה ארוכה מכך תמיד
      נשארת לאישור אדם — תקרת ה־<span className="num">{AUTOMATIC_SPLIT_PAGE_CEILING}</span> נוגעת
      לקובץ PDF שנושא שכבת טקסט משלו.
    </>,
    icon: Scissors,
  },
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
  {
    key: 'delivery_note.receiving',
    title: 'טיוטת קבלת סחורה אוטומטית',
    description: 'מעל הסף, תעודת משלוח פותחת טיוטת קליטה מקושרת להזמנה, עם הכמויות שנקראו.',
    warning: 'הטיוטה אינה מזיזה מלאי, אינה מעדכנת כמויות שהתקבלו ואינה פותחת בקשות זיכוי — אדם עדיין משלים אותה. כשאין מספר הזמנה מודפס, ההזמנה נבחרת לפי הפריטים שסופקו, ורק אם נותרה אפשרות אחת.',
    icon: PackageCheck,
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
  const { errorText } = useT();
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
      toast(errorText(result.error.message), 'error');
      return;
    }
    setPendingEnable(null);
    toast(enable ? 'המדיניות הופעלה ונרשמה ביומן הביקורת' : 'המדיניות כובתה');
    void refetch();
  }

  return (
    <Card className="space-y-4" as="article" data-testid={`autonomy-policy-${definition.key}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="section-title flex items-center gap-2">
          <Icon size={ICON.md} aria-hidden="true" /> {definition.title}
        </h3>
        <span className={policy.autonomy_enabled ? 'badge-alert' : 'badge-idle'}>
          {policy.autonomy_enabled ? 'מופעלת' : 'כבויה'}
        </span>
      </div>

      <p className="text-sm text-ink-body">{definition.description}</p>
      <Note tone={policy.autonomy_enabled ? 'await' : 'info'}>
        <span className="min-w-0 flex-1">
          סף <span className="num">0.900</span> הוא ברירת מחדל שלא כוילה מול 50 מסמכים אמיתיים.
          אפשר רק להחמיר אותו. {definition.warning}
        </span>
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
          {busy && <Loader2 className="animate-spin" size={ICON.md} aria-hidden="true" />}
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
    </Card>
  );
}

export function AutonomyPolicyPanel({ orgId, orgName }: { orgId: string; orgName: string }) {
  // One platform-scoped read (platform_get_autonomy_policies, 0147), not four tenant-scoped
  // evaluate_autonomy_policy calls: the evaluator resolves auth_org(), which is the CALLER's
  // organization — for an operator that is either null (no profile) or their own tenant, never
  // the organization they are administering. This door takes the organization explicitly and is
  // gated by the same not_platform_admin check as the write beside it.
  const { data, loading, error, refetch } = useQuery(async () => {
    const rows = unwrap(
      await supabase.rpc('platform_get_autonomy_policies', { p_org_id: orgId }),
    ) as AutonomyPolicy[];
    return POLICIES.map(({ key }) => rows.find((row) => row.policy_key === key) ?? null);
  }, [orgId]);

  if (loading) return <Card className="text-sm text-ink-muted">טוען את מדיניות האוטונומיה…</Card>;
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
