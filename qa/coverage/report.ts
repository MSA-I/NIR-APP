import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { QA_ROLES, type QaRole } from '../config/roles.ts';
import { aggregateAll, applyRuntimeToActionMatrix, loadActionMatrix, METRIC_DEFINITIONS, type RoleAggregate } from './aggregate.ts';
import { COVERAGE_DIR, REPO_ROOT } from './build-manifest.ts';
import { triage, triageTotals } from './triage.ts';
import {
  CoverageSummarySchema,
  type CoverageStatus,
  type CoverageSummary,
  type TriagedObservation,
} from './types.ts';

/**
 * Report generation.
 *
 * The reports are written from the records and nothing else. Where a record is missing the report
 * says the item was not inspected — it never fills the hole with an assumption, and it never
 * prints a single headline percentage, because the eleven categories genuinely differ and one
 * average would hide exactly the weak one a reader needs to find.
 */

const ROLE_LABELS: Readonly<Record<QaRole, string>> = {
  owner: 'בעלים',
  office: 'משרד',
  kitchen: 'מטבח',
  payer: 'מבצע תשלומים',
  accountant: 'הנהלת חשבונות',
  supplier: 'ספק',
};

const CLASSIFICATION_LABELS: Readonly<Record<TriagedObservation['classification'], string>> = {
  CONFIRMED_DEFECT: 'פגם מאומת',
  EXPECTED_BEHAVIOR: 'התנהגות צפויה',
  FALSE_POSITIVE: 'התרעת שווא',
  BUSINESS_DECISION_REQUIRED: 'דורש הכרעה עסקית',
  INCONCLUSIVE: 'לא חד-משמעי',
};

const GLOBAL_LIMITATIONS = [
  'הענף נבנה על codex/qa-multi-agent, שהוא 43 קומיטים מאחורי main. הכיסוי מתאר את האפליקציה בענף הזה בלבד — ולא את DataTable, הרשימות בצד שרת, ReauthModal/step-up, org scope ו-feature flags שקיימים ב-main.',
  'הילוך הכיסוי קורא ומנווט. הוא אינו יוצר, מאשר, משלם או מוחק: פעולות אלה שייכות ל-qa/deterministic/critical-workflows.spec.ts עם verifiers עצמאיים, וחזרה עליהן כאן הייתה משנה את אותם fixtures.',
  'בקרה כספית או הרסנית תועדה כ"אותרה ולא הופעלה". זהו כיסוי מלאי, לא כיסוי ביצוע.',
  'Axe מכסה כללים אוטומטיים בלבד. היעדר הפרה אינו הוכחת תאימות WCAG 2.1 AA, ונדרשת בדיקת קורא-מסך אנושית בעברית ו-RTL.',
  'מצב שלא הופק בבטחה סומן NOT_OBSERVED ולא נספר ככיסוי. אין כאן טענה לכיסוי מצבים מלא.',
  'סריקת בקרות מוגבלת ל-400 בקרות למסך. מסך שחצה את התקרה מסומן במפורש.',
  'הנתונים סינתטיים וקטנים; אין כאן מבחן עומס, ביצועים או נפח אמיתי.',
];

function fmt(value: number): string {
  return `${value.toFixed(1)}%`;
}

function statusLabel(status: CoverageStatus): string {
  return {
    COVERAGE_COMPLETED: 'כיסוי הושלם',
    COVERAGE_PARTIAL: 'כיסוי חלקי',
    COVERAGE_BLOCKED: 'כיסוי חסום',
    INFRASTRUCTURE_FAILED: 'כשל תשתית',
  }[status];
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(' | ')} |`;
  const rule = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
  return `${head}\n${rule}\n${body}`;
}

function metricsTable(aggregate: RoleAggregate): string {
  return table(
    ['קטגוריה', 'כיסוי', 'הגדרה'],
    METRIC_DEFINITIONS.map((metric) => [
      metric.label,
      fmt(aggregate.summary.percentages[metric.key]),
      metric.definition,
    ]),
  );
}

function roleReport(aggregate: RoleAggregate, triaged: readonly TriagedObservation[]): string {
  const { role, summary, records, components, states } = aggregate;
  const accessible = records.filter((record) => record.routeResult.expectedVerdict === 'EXPECTED_ACCESS');
  const denied = records.filter((record) => record.routeResult.expectedVerdict === 'EXPECTED_DENIAL');
  const observations = records.flatMap((record) =>
    record.observations.map((observation) => ({ ...observation, route: record.route })),
  );
  const roleTriaged = triaged.filter((entry) => entry.role === role || entry.role === null);

  const stateRows = [...new Set(states.map((state) => state.state))].map((state) => {
    const relevant = states.filter((entry) => entry.state === state);
    const observed = relevant.filter((entry) => entry.status === 'OBSERVED').length;
    return [
      state,
      String(observed),
      String(relevant.filter((entry) => entry.status === 'NOT_OBSERVED').length),
      String(relevant.filter((entry) => entry.status === 'NOT_APPLICABLE').length),
      String(relevant.filter((entry) => entry.status === 'BLOCKED' || entry.status === 'UNSAFE_TO_PRODUCE').length),
    ];
  });

  const inaccessibleControls = components.filter(
    (component) => component.interactionResult === 'NOT_RENDERED' && component.expectedAvailability,
  );
  const runtimeOnly = components.filter((component) => component.section === 'runtime-only');

  return `# דוח כיסוי מלא — ${ROLE_LABELS[role]} (\`${role}\`)

> **סטטוס כיסוי: ${statusLabel(summary.coverageStatus)}.** זהו מדד שלמות הבדיקה בלבד. איכות המוצר מדווחת בנפרד בסעיף הממצאים — תפקיד יכול להגיע לכיסוי מלא ועדיין למצוא פגמים.

## היקף

- מסלולים שהוקצו: **${summary.assignedRoutes}**
- מסלולים שנבדקו: **${summary.inspectedRoutes}**
- מסלולים שלא נבדקו: **${summary.notInspectedRoutes.length}**${summary.notInspectedRoutes.length ? ` — ${summary.notInspectedRoutes.join(', ')}` : ''}
- מסלולים נגישים לתפקיד: **${accessible.length}**
- מסלולים שנבדקה בהם חסימה: **${denied.length}**
- בקרות שהתגלו: **${summary.discoveredControls}** (מהן ${runtimeOnly.length} התגלו רק בזמן ריצה ואינן בניתוח הסטטי)
- רשומות כיסוי רכיבים שנכתבו: **${summary.testedControls}**

## כיסוי לפי קטגוריה

${metricsTable(aggregate)}

## מסלולים

${table(
  ['מסלול', 'ציפייה', 'תוצאה', 'נחת על', 'ניווט', 'רענון יציב', 'נימוק'],
  records.map((record) => [
    `\`${record.route}\``,
    record.routeResult.expectedVerdict,
    record.routeResult.status,
    record.routeResult.landedPath ?? '—',
    record.routeResult.navigationVisible === null ? '—' : record.routeResult.navigationVisible ? 'מוצג' : 'מוסתר',
    record.routeResult.refreshStable === null ? '—' : record.routeResult.refreshStable ? 'כן' : 'לא',
    record.routeResult.rationale.replace(/\|/g, '/'),
  ]),
)}

## בדיקות הרשאה

- חיוביות (מסלול מותר שנפתח בפועל): **${accessible.filter((record) => record.routeResult.directAccessOutcome === 'RENDERED').length} מתוך ${accessible.length}**
- שליליות (מסלול חסום שהופנה בפועל): **${denied.filter((record) => record.routeResult.directAccessOutcome === 'REDIRECTED').length} מתוך ${denied.length}**
- דליפת תוכן לפני הפניה: **${denied.filter((record) => record.routeResult.informationLeakBeforeRedirect === true).length}**
- גישה בלתי צפויה: **${records.filter((record) => record.routeResult.expectedVerdict === 'EXPECTED_DENIAL' && record.routeResult.protectedContentRendered === true).length}**
- חסימה בלתי צפויה: **${records.filter((record) => record.routeResult.expectedVerdict === 'EXPECTED_ACCESS' && record.routeResult.protectedContentRendered === false).length}**

## מצבים

${stateRows.length ? table(['מצב', 'נצפה', 'לא נצפה', 'לא ישים', 'חסום'], stateRows) : 'לא נרשמו מצבים.'}

## בקרות שלא אותרו במסך

${
  inaccessibleControls.length
    ? table(
        ['מסלול', 'מזהה בקרה', 'שם נגיש', 'הערה'],
        inaccessibleControls
          .slice(0, 60)
          .map((component) => [
            `\`${component.route}\``,
            component.controlId,
            component.accessibleName ?? '—',
            component.note ?? '—',
          ]),
      ) + (inaccessibleControls.length > 60 ? `\n\n(מוצגות 60 מתוך ${inaccessibleControls.length}.)` : '')
    : 'כל הבקרות שבמניפסט אותרו במסך.'
}

## תצפיות

${
  observations.length
    ? table(
        ['מסלול', 'קטגוריה', 'חומרה', 'תצפית', 'פירוט'],
        observations
          .slice(0, 80)
          .map((observation) => [
            `\`${observation.route}\``,
            observation.category,
            observation.severityHint,
            observation.title,
            observation.detail.replace(/\|/g, '/').slice(0, 220),
          ]),
      ) + (observations.length > 80 ? `\n\n(מוצגות 80 מתוך ${observations.length}.)` : '')
    : 'לא נרשמו תצפיות.'
}

## סיווג לאחר טריאז׳

${
  roleTriaged.length
    ? table(
        ['מזהה', 'סיווג', 'תצפית', 'מופעים', 'נימוק'],
        roleTriaged.map((entry) => [
          entry.id,
          CLASSIFICATION_LABELS[entry.classification],
          entry.title,
          String(entry.reproducedTimes),
          entry.rationale.replace(/\|/g, '/'),
        ]),
      )
    : 'אין תצפיות שסווגו לתפקיד זה.'
}

## פערים וחסימות

${summary.blockedItems.length ? summary.blockedItems.map((item) => `- חסום: ${item}`).join('\n') : '- אין פריטים חסומים.'}
${summary.unexplainedGaps.length ? summary.unexplainedGaps.map((gap) => `- פער: ${gap}`).join('\n') : '- אין פערים בלתי מוסברים.'}

## ראיות

הראיות נמצאות תחת \`.qa-runs/<runId>/coverage/\` ו-\`coverage-playwright/\`: צילומי מסך לשלושה viewports לכל מסלול נגיש, סיכומי Axe כקבצים מצורפים, ולוגי console ו-network מצונזרים.

## מגבלות

${GLOBAL_LIMITATIONS.map((limitation) => `- ${limitation}`).join('\n')}
`;
}

function overallReport(
  summary: CoverageSummary,
  aggregates: readonly RoleAggregate[],
  triaged: readonly TriagedObservation[],
): string {
  const totals = triageTotals(triaged);
  return `# דוח כיסוי מלא לפי תפקיד — SupplyFlow

**ריצה:** \`${summary.runId}\` · **ענף:** \`${summary.branch}\` · **קומיט:** \`${summary.commit}\` · **נוצר:** ${summary.generatedAt}

> **סטטוס כיסוי: ${statusLabel(summary.coverageStatus)}. איכות מוצר: ${summary.productQualityStatus}.**
> שני המדדים נפרדים בכוונה: הראשון אומר האם בדקנו את מה שהתחייבנו לבדוק, השני אומר מה מצאנו.

## מלאי האפליקציה

${table(
  ['פריט', 'כמות'],
  [
    ['מסלולים', String(summary.totals.routes)],
    ['אזורים (sections)', String(summary.totals.sections)],
    ['בקרות', String(summary.totals.controls)],
    ['פעולות', String(summary.totals.actions)],
    ['רשומות כיסוי רכיבים', String(summary.totals.componentCoverageRecords)],
    ['רשומות כיסוי מצבים', String(summary.totals.stateCoverageRecords)],
  ],
)}

## כיסוי לפי תפקיד

${table(
  ['תפקיד', 'סטטוס', 'מסלולים', 'רכיבים', 'פעולות', 'טפסים', 'טבלאות', 'דיאלוגים', 'הרשאות', 'נגישות', 'מצבים', 'רספונסיבי', 'שרידות'],
  aggregates.map((aggregate) => {
    const p = aggregate.summary.percentages;
    return [
      `${ROLE_LABELS[aggregate.role]} (\`${aggregate.role}\`)`,
      statusLabel(aggregate.summary.coverageStatus),
      fmt(p.routes),
      fmt(p.components),
      fmt(p.actions),
      fmt(p.forms),
      fmt(p.tables),
      fmt(p.dialogs),
      fmt(p.permissions),
      fmt(p.accessibility),
      fmt(p.states),
      fmt(p.responsiveViewports),
      fmt(p.dataPersistence),
    ];
  }),
)}

הגדרת כל עמודה:

${table(['קטגוריה', 'הגדרה'], METRIC_DEFINITIONS.map((metric) => [metric.label, metric.definition]))}

## תוצאות טריאז׳

${table(
  ['סיווג', 'כמות'],
  Object.entries(totals).map(([key, value]) => [
    CLASSIFICATION_LABELS[key as TriagedObservation['classification']] ?? key,
    String(value),
  ]),
)}

### פגמים מאומתים

${
  triaged.filter((entry) => entry.classification === 'CONFIRMED_DEFECT').length
    ? table(
        ['מזהה', 'תצפית', 'תפקיד', 'מסלול', 'מופעים', 'נימוק'],
        triaged
          .filter((entry) => entry.classification === 'CONFIRMED_DEFECT')
          .map((entry) => [
            entry.id,
            entry.title,
            entry.role ?? 'מספר תפקידים',
            entry.route ?? 'מספר מסלולים',
            String(entry.reproducedTimes),
            entry.rationale.replace(/\|/g, '/'),
          ]),
      )
    : 'לא סווגו פגמים מאומתים בריצה זו.'
}

### דורש הכרעה עסקית

${
  triaged.filter((entry) => entry.classification === 'BUSINESS_DECISION_REQUIRED').length
    ? table(
        ['מזהה', 'תצפית', 'מופעים', 'נימוק'],
        triaged
          .filter((entry) => entry.classification === 'BUSINESS_DECISION_REQUIRED')
          .map((entry) => [entry.id, entry.title, String(entry.reproducedTimes), entry.rationale.replace(/\|/g, '/')]),
      )
    : 'אין פריטים הממתינים להכרעה עסקית.'
}

### התרעות שווא ולא חד-משמעיים

${
  triaged.filter((entry) => entry.classification === 'FALSE_POSITIVE' || entry.classification === 'INCONCLUSIVE').length
    ? table(
        ['מזהה', 'סיווג', 'תצפית', 'נימוק'],
        triaged
          .filter((entry) => entry.classification === 'FALSE_POSITIVE' || entry.classification === 'INCONCLUSIVE')
          .map((entry) => [
            entry.id,
            CLASSIFICATION_LABELS[entry.classification],
            entry.title,
            entry.rationale.replace(/\|/g, '/'),
          ]),
      )
    : 'אין.'
}

## דוחות לפי תפקיד

${QA_ROLES.map((role) => `- [\`${role}\`](./${role}-full-coverage.he.md) — ${ROLE_LABELS[role]}`).join('\n')}

## מגבלות

${GLOBAL_LIMITATIONS.map((limitation) => `- ${limitation}`).join('\n')}

## בדיקות אנושיות שנותרו

- קורא מסך אנושי בעברית ו-RTL: סדר קריאה, שמות נגישים והכרזת שגיאות.
- ביקורת תחום כספי על סכומים, הקצאות, idempotency ו-audit reason.
- עובד מטבח על מכשיר נייד אמיתי בזמן קבלת סחורה.
- חשבונאי על תוכן ופורמט export אמיתי.
- ספק על בהירות תהליך המחירון החודשי ללא הדרכה.
- רשת איטית/מקוטעת: התאוששות, כפילויות והודעות מצב.
- כל פעולה כספית או הרסנית שנרשמה כ"אותרה ולא הופעלה".
`;
}

function gapsReport(aggregates: readonly RoleAggregate[], triaged: readonly TriagedObservation[]): string {
  const rows = aggregates.flatMap((aggregate) => [
    ...aggregate.summary.notInspectedRoutes.map((route) => [aggregate.role, `מסלול ללא תוצאה: \`${route}\``]),
    ...aggregate.summary.blockedItems.map((item) => [aggregate.role, `חסום: ${item.replace(/\|/g, '/')}`]),
    ...aggregate.summary.unexplainedGaps.map((gap) => [aggregate.role, `פער: ${gap.replace(/\|/g, '/')}`]),
  ]);

  return `# פערי כיסוי

מסמך זה מרכז את כל מה ש**לא** כוסה, ולמה. הוא קיים כדי שאף מספר בדוח הראשי לא ייקרא כאילו הוא מכסה יותר ממה שנמדד.

## פערים לפי תפקיד

${rows.length ? table(['תפקיד', 'פער'], rows) : 'לא נרשמו פערים.'}

## מצבים שלא הופקו

מצבים סומנו \`NOT_OBSERVED\` כאשר הפקתם הייתה מחייבת שינוי מצב משותף (הגשת טופס שגוי, כפילות, נתון מיושן) או שלא ניתן היה ללכוד אותם בבטחה. הם אינם נספרים ככיסוי.

${table(
  ['תפקיד', 'מצבים שנצפו', 'מצבים שלא נצפו', 'לא ישימים'],
  aggregates.map((aggregate) => [
    aggregate.role,
    String(aggregate.states.filter((state) => state.status === 'OBSERVED').length),
    String(aggregate.states.filter((state) => state.status === 'NOT_OBSERVED').length),
    String(aggregate.states.filter((state) => state.status === 'NOT_APPLICABLE').length),
  ]),
)}

## תצפיות שנותרו לא חד-משמעיות

${
  triaged.filter((entry) => entry.classification === 'INCONCLUSIVE').length
    ? table(
        ['מזהה', 'תצפית', 'מופעים', 'נימוק'],
        triaged
          .filter((entry) => entry.classification === 'INCONCLUSIVE')
          .map((entry) => [entry.id, entry.title, String(entry.reproducedTimes), entry.rationale.replace(/\|/g, '/')]),
      )
    : 'אין.'
}

## מגבלות מבניות

${GLOBAL_LIMITATIONS.map((limitation) => `- ${limitation}`).join('\n')}
`;
}

/** Self-contained RTL HTML. No CDN, no external font, no script: it must open from a file share. */
function html(markdownSections: readonly { title: string; body: string }[], summary: CoverageSummary): string {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const renderMarkdownTable = (block: string): string => {
    const lines = block.trim().split('\n');
    const cells = (line: string): string[] =>
      line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    const header = cells(lines[0] ?? '');
    const body = lines.slice(2).map(cells);
    return `<table><thead><tr>${header.map((cell) => `<th>${escape(cell)}</th>`).join('')}</tr></thead><tbody>${body
      .map((row) => `<tr>${row.map((cell) => `<td>${escape(cell)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
  };

  const renderBody = (body: string): string =>
    body
      .split(/\n{2,}/)
      .map((block) => {
        const trimmed = block.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('|')) return renderMarkdownTable(trimmed);
        if (trimmed.startsWith('### ')) return `<h3>${escape(trimmed.slice(4))}</h3>`;
        if (trimmed.startsWith('## ')) return `<h2>${escape(trimmed.slice(3))}</h2>`;
        if (trimmed.startsWith('# ')) return `<h1>${escape(trimmed.slice(2))}</h1>`;
        if (trimmed.startsWith('> ')) return `<blockquote>${escape(trimmed.replace(/^> ?/gm, ''))}</blockquote>`;
        if (trimmed.startsWith('- ')) {
          return `<ul>${trimmed
            .split('\n')
            .map((line) => `<li>${escape(line.replace(/^- /, ''))}</li>`)
            .join('')}</ul>`;
        }
        return `<p>${escape(trimmed)}</p>`;
      })
      .join('\n');

  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>כיסוי מלא לפי תפקיד — ${escape(summary.runId)}</title>
<style>
:root { color-scheme: light dark; --ink:#101828; --soft:#475467; --line:#e4e7ec; --bg:#ffffff; --panel:#f9fafb; }
@media (prefers-color-scheme: dark) { :root { --ink:#e6e9ef; --soft:#98a2b3; --line:#2b3240; --bg:#0f1319; --panel:#151a22; } }
* { box-sizing: border-box; }
body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--ink);
  font-family: "Segoe UI", system-ui, -apple-system, Arial, sans-serif; line-height:1.65; }
main { max-width: 78rem; margin-inline: auto; }
h1 { font-size:1.7rem; margin:2rem 0 .75rem; }
h2 { font-size:1.25rem; margin:2rem 0 .5rem; border-block-end:1px solid var(--line); padding-block-end:.35rem; }
h3 { font-size:1.05rem; margin:1.5rem 0 .4rem; color:var(--soft); }
p, li { color:var(--ink); }
blockquote { margin:1rem 0; padding:.75rem 1rem; background:var(--panel);
  border-inline-start:3px solid var(--soft); border-radius:.4rem; color:var(--soft); }
table { width:100%; border-collapse:collapse; margin:1rem 0; font-size:.86rem; display:block; overflow-x:auto; }
th, td { border:1px solid var(--line); padding:.4rem .55rem; text-align:start; vertical-align:top; }
th { background:var(--panel); font-weight:600; white-space:nowrap; }
code { background:var(--panel); padding:.05rem .3rem; border-radius:.25rem; font-size:.85em; }
nav.toc { background:var(--panel); border:1px solid var(--line); border-radius:.5rem; padding:1rem 1.25rem; margin:1.5rem 0; }
nav.toc ul { margin:.35rem 0 0; padding-inline-start:1.2rem; }
</style>
</head>
<body>
<main>
<nav class="toc"><strong>תוכן</strong><ul>${markdownSections
    .map((section, index) => `<li><a href="#s${index}">${escape(section.title)}</a></li>`)
    .join('')}</ul></nav>
${markdownSections.map((section, index) => `<section id="s${index}">${renderBody(section.body)}</section>`).join('\n')}
</main>
</body>
</html>
`;
}

export interface GeneratedReports {
  readonly summary: CoverageSummary;
  readonly files: readonly string[];
  readonly triaged: readonly TriagedObservation[];
}

export function generateReports(artifactRoot: string, runId: string): GeneratedReports {
  const { manifest, matrix, roles } = aggregateAll(artifactRoot);
  const triaged = triage(roles);
  const actionMatrix = applyRuntimeToActionMatrix(loadActionMatrix(), roles);

  const confirmedDefects = triaged.filter((entry) => entry.classification === 'CONFIRMED_DEFECT').length;
  const anyRecords = roles.some((role) => role.records.length > 0);

  const coverageStatus: CoverageStatus = !anyRecords
    ? 'INFRASTRUCTURE_FAILED'
    : roles.every((role) => role.summary.coverageStatus === 'COVERAGE_COMPLETED')
      ? 'COVERAGE_COMPLETED'
      : roles.some((role) => role.summary.coverageStatus === 'INFRASTRUCTURE_FAILED')
        ? 'INFRASTRUCTURE_FAILED'
        : roles.some((role) => role.summary.coverageStatus === 'COVERAGE_BLOCKED')
          ? 'COVERAGE_BLOCKED'
          : 'COVERAGE_PARTIAL';

  const summary: CoverageSummary = CoverageSummarySchema.parse({
    runId,
    generatedAt: new Date().toISOString(),
    branch: matrix.generatedFrom.branch,
    commit: matrix.generatedFrom.commit,
    coverageStatus,
    productQualityStatus: !anyRecords ? 'NOT_ASSESSED' : confirmedDefects > 0 ? 'FAIL' : 'PASS_WITH_FINDINGS',
    totals: {
      routes: manifest.totals.routes,
      sections: manifest.totals.sections,
      controls: manifest.totals.controls,
      actions: manifest.totals.actions,
      componentCoverageRecords: roles.reduce((sum, role) => sum + role.components.length, 0),
      stateCoverageRecords: roles.reduce((sum, role) => sum + role.states.length, 0),
    },
    roles: roles.map((role) => role.summary),
    limitations: GLOBAL_LIMITATIONS,
  });

  mkdirSync(COVERAGE_DIR, { recursive: true });
  const files: string[] = [];
  const write = (name: string, content: string): void => {
    const target = path.join(COVERAGE_DIR, name);
    writeFileSync(target, content, 'utf8');
    files.push(path.relative(REPO_ROOT, target).replace(/\\/g, '/'));
  };

  write('coverage-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
  write(
    'component-coverage.json',
    `${JSON.stringify({ runId, records: roles.flatMap((role) => role.components) }, null, 2)}\n`,
  );
  write('state-coverage.json', `${JSON.stringify({ runId, records: roles.flatMap((role) => role.states) }, null, 2)}\n`);
  write('role-action-matrix.json', `${JSON.stringify(actionMatrix, null, 2)}\n`);
  write('triage-results.json', `${JSON.stringify({ runId, results: triaged }, null, 2)}\n`);

  const overall = overallReport(summary, roles, triaged);
  const gaps = gapsReport(roles, triaged);
  write('full-coverage-report.he.md', overall);
  write('coverage-gaps.he.md', gaps);
  for (const aggregate of roles) {
    write(`${aggregate.role}-full-coverage.he.md`, roleReport(aggregate, triaged));
  }
  write(
    'full-coverage-report.html',
    html(
      [
        { title: 'סיכום כללי', body: overall },
        { title: 'פערי כיסוי', body: gaps },
        ...roles.map((aggregate) => ({
          title: `תפקיד: ${ROLE_LABELS[aggregate.role]}`,
          body: roleReport(aggregate, triaged),
        })),
      ],
      summary,
    ),
  );

  return { summary, files, triaged };
}
