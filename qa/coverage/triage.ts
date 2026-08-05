import path from 'node:path';
import { QA_ROLES, type QaRole } from '../config/roles.ts';
import { REPO_ROOT } from './build-manifest.ts';
import { extractNavigation, extractRoutes } from './extract.ts';
import type { RoleAggregate } from './aggregate.ts';
import type { CoverageObservation } from './record-store.ts';
import { TriagedObservationSchema, type TriagedObservation } from './types.ts';

/**
 * Triage.
 *
 * An observation is a thing the walk noticed; a defect is a claim about the product. Turning one
 * into the other requires a reason that survives being questioned, so every classification here
 * names the rule that produced it, and anything no rule covers becomes INCONCLUSIVE rather than
 * being rounded up to a defect or quietly dropped. The authorization rules do not trust the
 * browser alone: they re-read App.tsx and Layout.tsx and confirm the contradiction in source
 * before calling it confirmed.
 */

interface TriageRule {
  readonly name: string;
  readonly matches: (observation: GroupedObservation) => boolean;
  readonly classify: (observation: GroupedObservation) => Pick<TriagedObservation, 'classification' | 'rationale'>;
}

export interface GroupedObservation {
  readonly key: string;
  readonly title: string;
  readonly category: CoverageObservation['category'];
  readonly severityHint: CoverageObservation['severityHint'];
  readonly occurrences: readonly { role: QaRole; route: string; detail: string; evidence: readonly string[] }[];
}

/** Two roles hitting the same wall is the same wall. Grouping is by what happened, not by who. */
export function groupObservations(aggregates: readonly RoleAggregate[]): GroupedObservation[] {
  const groups = new Map<string, GroupedObservation & { occurrences: { role: QaRole; route: string; detail: string; evidence: readonly string[] }[] }>();
  for (const aggregate of aggregates) {
    for (const record of aggregate.records) {
      for (const observation of record.observations) {
        const key = `${observation.category}|${observation.title}`;
        const existing = groups.get(key);
        const occurrence = {
          role: aggregate.role,
          route: record.route,
          detail: observation.detail,
          evidence: observation.evidence,
        };
        if (existing) {
          existing.occurrences.push(occurrence);
          continue;
        }
        groups.set(key, {
          key,
          title: observation.title,
          category: observation.category,
          severityHint: observation.severityHint,
          occurrences: [occurrence],
        });
      }
    }
  }
  return [...groups.values()];
}

/** Roles a nav item is shown to but App.tsx will not let in. Read from source, not from a run. */
function navigationContradictions(): Map<string, QaRole[]> {
  const routes = extractRoutes(path.join(REPO_ROOT, 'src', 'App.tsx'), REPO_ROOT);
  const navigation = extractNavigation(path.join(REPO_ROOT, 'src', 'components', 'Layout.tsx'));
  const guardByRoute = new Map(routes.map((route) => [route.route, route.expectedRoles]));
  const contradictions = new Map<string, QaRole[]>();
  for (const item of navigation) {
    const guarded = guardByRoute.get(item.to);
    if (!guarded) continue;
    const offenders = item.roles.filter((role) => !guarded.includes(role));
    if (offenders.length) contradictions.set(item.to, [...offenders]);
  }
  return contradictions;
}

const KNOWN_LOCAL_STACK_FLAKE =
  /p2_(above_average_offer_count|payment_due_counts)|HTTP 502|password authentication failed for user "authenticator"/;

export function triage(aggregates: readonly RoleAggregate[]): TriagedObservation[] {
  const contradictions = navigationContradictions();
  const groups = groupObservations(aggregates);

  const rules: TriageRule[] = [
    {
      name: 'authorization/nav-contradicts-guard',
      matches: (observation) => observation.title === 'פריט ניווט מוצג לתפקיד חסום',
      classify: (observation) => {
        const routes = [...new Set(observation.occurrences.map((occurrence) => occurrence.route))];
        const confirmedInSource = routes.filter((route) => contradictions.has(route));
        return confirmedInSource.length
          ? {
              classification: 'CONFIRMED_DEFECT',
              rationale: `אומת מול המקור: NAV ב-Layout.tsx מציג את ${confirmedInSource.join(', ')} לתפקיד ש-Guard ב-App.tsx חוסם.`,
            }
          : {
              classification: 'FALSE_POSITIVE',
              rationale: 'הצלבה מול Layout.tsx ו-App.tsx לא מצאה סתירה. פריט הניווט אינו מוצג לתפקיד החסום במקור.',
            };
      },
    },
    {
      name: 'authorization/server-allows-hidden-screen',
      matches: (observation) => observation.title === 'המסך חסום אך השרת מחזיר נתונים',
      classify: () => ({
        classification: 'CONFIRMED_DEFECT',
        rationale:
          'בקשה עם הטוקן של התפקיד עצמו החזירה שורות ל-endpoint שהמסך חוסם. הסתרה בצד לקוח ללא דחייה בשרת היא פגם הרשאה מאומת.',
      }),
    },
    {
      name: 'authorization/allowed-route-redirected',
      matches: (observation) =>
        observation.title === 'מסלול מותר הפנה את המשתמש' || observation.title === 'פריט ניווט שאינו מוביל ליעדו',
      classify: (observation) => ({
        classification: observation.occurrences.length >= 2 ? 'CONFIRMED_DEFECT' : 'INCONCLUSIVE',
        rationale:
          observation.occurrences.length >= 2
            ? `נצפה ב-${observation.occurrences.length} מקרים: המסלול מותר ב-App.tsx אך המשתמש הופנה.`
            : 'מקרה יחיד. ייתכן מרוץ טעינה ולא חסימה; נדרש שחזור נוסף לפני קביעה.',
      }),
    },
    {
      name: 'authorization/tenant-reached-platform-route',
      matches: (observation) => observation.title === 'תפקיד דייר הגיע למסלול פלטפורמה',
      classify: () => ({
        classification: 'CONFIRMED_DEFECT',
        rationale: 'PlatformGuard נועד להפנות כל מי שאינו מפעיל פלטפורמה. רינדור לתפקיד דייר סותר את החוזה הזה.',
      }),
    },
    {
      name: 'accessibility/objective-violation',
      matches: (observation) =>
        observation.category === 'accessibility' &&
        ['הפרות Axe חוסמות', 'שדות ללא שם נגיש', 'שדות טופס ללא שם נגיש', 'בקרה ללא שם נגיש'].includes(observation.title),
      classify: (observation) => ({
        classification: 'CONFIRMED_DEFECT',
        rationale: `כלל נגישות אובייקטיבי שנמדד ישירות ב-DOM, ללא פרשנות. נצפה ב-${observation.occurrences.length} מקומות.`,
      }),
    },
    {
      name: 'accessibility/needs-judgement',
      matches: (observation) => observation.category === 'accessibility',
      classify: (observation) => ({
        classification: observation.severityHint === 'high' ? 'CONFIRMED_DEFECT' : 'BUSINESS_DECISION_REQUIRED',
        rationale:
          observation.severityHint === 'high'
            ? 'הפרה חמורה של חוזה מקלדת/מיקוד שנמדדה ישירות.'
            : 'ממצא נגישות שדורש הכרעה עיצובית: הוא אינו כשל חד-משמעי של כלל WCAG אוטומטי.',
      }),
    },
    {
      name: 'visual/kitchen-mobile-contract',
      matches: (observation) =>
        observation.category === 'visual' && observation.occurrences.some((occurrence) => occurrence.role === 'kitchen'),
      classify: (observation) => ({
        classification: 'CONFIRMED_DEFECT',
        rationale: `למטבח יש חוזה מובייל מפורש בסוויטה הקיימת (390x844, ללא גלישה, יעדי מגע 44px). הפרה בתפקיד הזה אינה העדפה. נצפה ב-${observation.occurrences.length} מקומות.`,
      }),
    },
    {
      name: 'visual/preference',
      matches: (observation) => observation.category === 'visual',
      classify: () => ({
        classification: 'BUSINESS_DECISION_REQUIRED',
        rationale: 'ממצא ויזואלי מחוץ לחוזה המובייל של המטבח. אינו מסווג כפגם ללא הכרעה על מידת הפגיעה בשימושיות.',
      }),
    },
    {
      name: 'network/known-local-stack-flake',
      matches: (observation) =>
        (observation.category === 'network' || observation.category === 'console') &&
        observation.occurrences.some((occurrence) => KNOWN_LOCAL_STACK_FLAKE.test(occurrence.detail)),
      classify: () => ({
        classification: 'FALSE_POSITIVE',
        rationale:
          'חתימת ה-502 המוכרת של הסטאק המקומי (PostgREST עולה בזמן ש-Kong כבר מעביר אליו), מתועדת ב-docs/PROGRESS.md. אינה פגם מוצר.',
      }),
    },
    {
      name: 'network/unclassified',
      matches: (observation) => observation.category === 'network' || observation.category === 'console',
      classify: (observation) => ({
        classification: 'INCONCLUSIVE',
        rationale: `${observation.occurrences.length} מופעים ללא חתימה מוכרת. נדרשת חקירה נפרדת לפני שיוך לפגם מוצר.`,
      }),
    },
    {
      name: 'coverage/declared-limit',
      matches: (observation) => observation.category === 'coverage_gap',
      classify: () => ({
        classification: 'EXPECTED_BEHAVIOR',
        rationale: 'מגבלת סריקה מוצהרת של מערכת הכיסוי עצמה, לא התנהגות של המוצר. מדווחת בפער הכיסוי.',
      }),
    },
    {
      name: 'discoverability/product-decision',
      matches: (observation) => observation.category === 'discoverability',
      classify: () => ({
        classification: 'BUSINESS_DECISION_REQUIRED',
        rationale:
          'מסלול נגיש שאינו בניווט אינו באג בהכרח — ייתכן שהכניסה אליו היא קישור הקשרי מכוון. ההכרעה היא של בעל המוצר.',
      }),
    },
    {
      name: 'functional/reproduced',
      matches: (observation) => observation.category === 'functional' && observation.severityHint === 'high',
      classify: (observation) => ({
        classification: observation.occurrences.length >= 2 ? 'CONFIRMED_DEFECT' : 'INCONCLUSIVE',
        rationale:
          observation.occurrences.length >= 2
            ? `שוחזר ב-${observation.occurrences.length} מופעים בהילוך אחד.`
            : 'מופע יחיד בהילוך אחד. לא שוחזר פעמיים ולכן אינו מסווג כפגם מאומת.',
      }),
    },
    {
      name: 'usability/product-decision',
      matches: (observation) => observation.category === 'usability' || observation.category === 'functional',
      classify: () => ({
        classification: 'BUSINESS_DECISION_REQUIRED',
        rationale: 'ממצא שימושיות/התנהגות שאינו חוצה סף אובייקטיבי. דורש הכרעת בעל מוצר.',
      }),
    },
  ];

  return groups.map((group, index) => {
    const rule = rules.find((candidate) => candidate.matches(group));
    const outcome = rule?.classify(group) ?? {
      classification: 'INCONCLUSIVE' as const,
      rationale: 'לא נמצא כלל טריאז׳ תואם. לא סווג כפגם ולא נדחה.',
    };
    return TriagedObservationSchema.parse({
      id: `TRIAGE-${String(index + 1).padStart(3, '0')}`,
      title: group.title,
      role: group.occurrences.length === 1 ? group.occurrences[0]!.role : null,
      route: new Set(group.occurrences.map((occurrence) => occurrence.route)).size === 1
        ? group.occurrences[0]!.route
        : null,
      classification: outcome.classification,
      rationale: `${outcome.rationale} [כלל: ${rule?.name ?? 'none'}]`,
      reproducedTimes: group.occurrences.length,
      sourceReference: rule?.name.startsWith('authorization') ? 'src/App.tsx, src/components/Layout.tsx' : undefined,
      evidence: [...new Set(group.occurrences.flatMap((occurrence) => occurrence.evidence))].slice(0, 6),
      duplicateOf: null,
    });
  });
}

export function triageTotals(results: readonly TriagedObservation[]): Record<string, number> {
  const totals: Record<string, number> = {
    CONFIRMED_DEFECT: 0,
    EXPECTED_BEHAVIOR: 0,
    FALSE_POSITIVE: 0,
    BUSINESS_DECISION_REQUIRED: 0,
    INCONCLUSIVE: 0,
  };
  for (const result of results) totals[result.classification] = (totals[result.classification] ?? 0) + 1;
  return totals;
}

export { QA_ROLES };
