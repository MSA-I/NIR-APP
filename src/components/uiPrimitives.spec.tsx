import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { Breadcrumbs, EmptyState, KpiCard, LifecycleStrip, PageHeader, RecordHeader } from './ui';

const inRouter = (content: ReactNode) => <MemoryRouter>{content}</MemoryRouter>;

describe('פרימיטיבי היררכיית עמוד', () => {
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

  it('מציג מדד לא פעולה כמידע ולא ככפתור מושבת', () => {
    render(<KpiCard title="יתרה פתוחה" value="₪8,420" />);
    expect(screen.queryByRole('button', { name: /יתרה פתוחה/ })).not.toBeInTheDocument();
    expect(screen.getByText('₪8,420')).toBeInTheDocument();
  });
});
