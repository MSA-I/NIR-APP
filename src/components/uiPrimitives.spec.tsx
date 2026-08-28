import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { AttentionZone, Breadcrumbs, EmptyState, KpiCard, LifecycleStrip, PageHeader, RecordHeader, type AttentionItem } from './ui';

const inRouter = (content: ReactNode) => <MemoryRouter>{content}</MemoryRouter>;
const atRoute = (path: string, content: ReactNode) =>
  <MemoryRouter initialEntries={[path]}>{content}</MemoryRouter>;

describe('פרימיטיבי היררכיית עמוד', () => {
  // The catalogue in `routePresentation.ts` hands back a KEY, and `description` is a `ReactNode`,
  // so rendering the key straight out typechecked cleanly and printed `nav.routeDesc_inventory`
  // under the title of every catalogued screen, in both languages. Every existing test here
  // rendered at `/`, which is not in the catalogue, so none of them could see it. This one is
  // pinned to a catalogued route on purpose.
  it('מתרגם את תיאור המסלול מהקטלוג, ואינו מדפיס מפתח', () => {
    const view = render(atRoute('/inventory', <PageHeader title="מלאי" />));
    expect(screen.getByText('מעקב אחר היתרות שנספרו ואחר תנועות המלאי, וזיהוי מוצרים שירדו מתחת למינימום.')).toBeInTheDocument();
    expect(view.container.textContent).not.toMatch(/nav.routeDesc/);
    view.unmount();

    // `description={null}` still opts out entirely, and a page that passes its own sentence
    // still shows that sentence rather than the catalogue's.
    const explicit = render(atRoute('/inventory', <PageHeader title="מלאי" description={null} />));
    expect(explicit.container.textContent).not.toMatch(/מעקב אחר היתרות/);
  });

  it('שומר על כותרות, הקשר, שלב נוכחי ופעולת המשך נגישים', () => {
    const view = render(inRouter(
      <PageHeader
        title="ספקים"
        meta="24 ספקים פעילים"
        breadcrumbs={<Breadcrumbs items={[{ label: 'מרכז הבקרה', to: '/dashboard' }, { label: 'ספקים' }]} />}
        actions={<button type="button">ספק חדש</button>}
      />,
    ));

    expect(screen.getByRole('heading', { level: 1, name: 'ספקים' })).toBeInTheDocument();
    const breadcrumbs = screen.getByRole('navigation', { name: 'פירורי לחם' });
    expect(breadcrumbs).toBeInTheDocument();
    expect(breadcrumbs.querySelector('[aria-current="page"]')).toHaveTextContent('ספקים');
    expect(screen.getByRole('button', { name: 'ספק חדש' })).toBeInTheDocument();

    view.rerender(inRouter(
      <RecordHeader
        title="הזמנה #1048"
        status={<span>מאושרת</span>}
        meta={<span>משק ירוק · ₪8,420</span>}
        primaryAction={<button type="button">קבלת סחורה</button>}
        lifecycle={(
          <LifecycleStrip
            steps={[
              { key: 'draft', label: 'טיוטה' },
              { key: 'approved', label: 'מאושרת' },
              { key: 'received', label: 'התקבלה' },
            ]}
            current="approved"
            nextAction="קבלת סחורה"
          />
        )}
      />,
    ));

    expect(screen.getByRole('heading', { level: 1, name: 'הזמנה #1048' })).toBeInTheDocument();
    const lifecycle = screen.getByRole('list', { name: 'שלבי התהליך' });
    expect(lifecycle).toBeInTheDocument();
    expect(lifecycle.querySelector('[aria-current="step"]')).toHaveTextContent('מאושרת — השלב הנוכחי');
    expect(screen.getByText('הפעולה הבאה:').parentElement).toHaveTextContent('הפעולה הבאה: קבלת סחורה');
    expect(screen.getByRole('button', { name: 'קבלת סחורה' })).toBeInTheDocument();

    view.rerender(inRouter(
      <EmptyState
        title="עדיין אין ספקים"
        subtitle="הוסף את הספק הראשון כדי להתחיל."
        action={<button type="button">ספק חדש</button>}
      />,
    ));

    expect(screen.getByText('עדיין אין ספקים')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ספק חדש' })).toBeInTheDocument();
  });

  it('רצועת השלבים מציגה מד התקדמות רק כשיש done/total אמיתיים', () => {
    // The restyle is allowed to move the bar and thin it; it is NOT allowed to invent one. A strip
    // without a page count must stay silent about "how far", and the step itself must still be
    // announced. Both halves are pinned here so a future styling pass cannot quietly add a
    // zero-width or indeterminate bar to fill the space.
    const steps = [
      { key: 'received', label: 'התקבל' },
      { key: 'reading', label: 'קריאה' },
      { key: 'interpreting', label: 'פירוש' },
    ];
    const view = render(<LifecycleStrip steps={steps} current="reading" detail="מספר העמודים עדיין לא ידוע." />);

    expect(screen.queryByRole('progressbar')).toBeNull();
    const marked = view.container.querySelector('li[aria-current="step"]');
    expect(marked).toHaveTextContent('קריאה — השלב הנוכחי');

    view.rerender(
      <LifecycleStrip
        steps={steps}
        current="reading"
        progress={{ done: 7, total: 27, label: 'עמוד 7 מתוך 27' }}
      />,
    );

    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '7');
    expect(bar).toHaveAttribute('aria-valuemax', '27');
    expect(bar).toHaveAttribute('aria-valuetext', 'עמוד 7 מתוך 27');
    expect(view.container.querySelector('li[aria-current="step"]')).not.toBeNull();
  });

  it('מציג מדד לא פעולה כמידע ולא ככפתור מושבת', () => {
    render(<KpiCard title="יתרה פתוחה" value="₪8,420" />);
    expect(screen.queryByRole('button', { name: /יתרה פתוחה/ })).not.toBeInTheDocument();
    expect(screen.getByText('₪8,420')).toBeInTheDocument();
  });
});

describe('סמן האזור בכותרות העמוד', () => {
  // The paper half of the section identity. It takes NO prop on purpose: the accent resolves from
  // `--section-accent`, which only Layout's `<main data-section>` sets and only from the URL, so a
  // screen cannot make this mark say "approved" or "overdue". The assertions therefore pin the
  // absence of an API as much as the presence of an element.
  const mark = (container: HTMLElement) => container.querySelector('.section-mark');

  it('מופיע בשתי הכותרות, ללא טקסט, ומוסתר מקוראי מסך', () => {
    const view = render(inRouter(<PageHeader title="חשבוניות" meta="24 פתוחות" />));
    const pageMark = mark(view.container);
    expect(pageMark).toBeInTheDocument();
    expect(pageMark).toHaveAttribute('aria-hidden', 'true');
    // No text on it and none in it: a tone is a fill behind text, and this must never become one.
    expect(pageMark?.textContent).toBe('');
    expect(pageMark?.className).toBe('section-mark');

    view.rerender(inRouter(<RecordHeader title="חשבונית 1048" status={<span>מאושרת</span>} />));
    expect(mark(view.container)).toBeInTheDocument();
  });

  it('אינו נגזר משום prop — אותו סימן בדיוק ללא קשר לתוכן הכותרת', () => {
    const first = render(inRouter(<PageHeader title="ספקים" />));
    const bare = mark(first.container)?.outerHTML;
    first.unmount();
    const second = render(inRouter(
      <PageHeader title="תשלומים" meta="חריגה" actions={<button type="button">פעולה</button>} />,
    ));
    expect(mark(second.container)?.outerHTML).toBe(bare);
  });
});

describe('כותרת "דורש טיפול היום"', () => {
  const row = (key: string, tone: AttentionItem['tone'], count: number | null): AttentionItem =>
    ({ key, label: key, tone, count, to: `/${key}` });
  const bell = () => screen.getByRole('heading', { level: 2 }).querySelector('svg');

  it('סופר סוגי טיפול פעם אחת בלבד, ושומר את היחידה לקורא המסך', () => {
    // Two action rows carrying 5 and 7, so the header's own "2" cannot be confused with a row
    // count. Before this round the same 2 was rendered twice here and a third time by Dashboard.
    render(inRouter(<AttentionZone items={[row('a', 'await', 5), row('b', 'alert', 7)]} />));
    expect(screen.getAllByText((_, node) => node?.textContent === '2 סוגי טיפול')
      .filter((node) => node.className.includes('badge'))).toHaveLength(1);
    expect(screen.queryByText(/^\s*2 סוגי טיפול\s*$/)).not.toBeInTheDocument();
  });

  it('לוקח את הטון מהשורות שהוא סופר — alert גובר על await', () => {
    render(inRouter(<AttentionZone items={[row('a', 'await', 5), row('b', 'alert', 7)]} />));
    expect(bell()).toHaveClass('text-alert-fg');
    expect(screen.getByRole('heading', { level: 2 }).querySelector('.badge-alert')).not.toBeNull();
  });

  it('כשאין מה לטפל בו הפעמון כבה ואין תג', () => {
    // A permanently amber bell above "אין משימות דחופות כרגע" is colour asserting the opposite of
    // the sentence beside it — the exact failure mode this campaign is about.
    render(inRouter(<AttentionZone items={[row('a', 'info', 0)]} />));
    expect(bell()).toHaveClass('text-ink-ghost');
    expect(bell()).not.toHaveClass('text-await-fg');
    expect(screen.getByRole('heading', { level: 2 }).querySelector('[class*="badge"]')).toBeNull();
  });

  it('כשהכל נמדד ואין דחוף — המשפט הירוק', () => {
    render(inRouter(<AttentionZone items={[row('a', 'info', 0), row('b', 'idle', 3)]} />));
    expect(screen.getByText('אין משימות דחופות כרגע')).toBeInTheDocument();
  });

  it('כשמדד אחד אינו ניתן למדידה — משפט ניטרלי, ולא all-clear כוזב', () => {
    // A brand-new organization is exactly this shape: measured zeros plus the two payment rows
    // the snapshot returns as null. Before this fix the card body rendered nothing at all.
    render(inRouter(<AttentionZone items={[row('a', 'info', 0), row('b', 'alert', null)]} />));
    expect(screen.getByText(/אין משימות דחופות מבין המדדים שנמדדו/)).toBeInTheDocument();
    expect(screen.queryByText('אין משימות דחופות כרגע')).not.toBeInTheDocument();
  });
});
