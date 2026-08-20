import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import CustomerHealth from './CustomerHealth';
import CustomerOnboarding from './CustomerOnboarding';
import type { CustomerHealth as Health, OnboardingStep, PlatformCapability } from '../lib/platform';

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));

const health = (over: Partial<Health> = {}): Health => ({
  org_id: '53000000-0000-4000-8000-000000000001',
  status: 'needs_attention',
  evaluated_at: '2026-08-19T18:00:00.000Z',
  last_activity_at: '2026-08-05T10:00:00.000Z',
  signals: [{ code: 'activity_slowing', severity: 'warn', detail: 'הפעילות האחרונה הייתה לפני יותר משבועיים' }],
  ...over,
});

const step = (over: Partial<OnboardingStep> = {}): OnboardingStep => ({
  step_key: 'team_invited',
  label: 'הצוות הוזמן',
  sort_order: 50,
  state: 'not_started',
  source: 'none',
  achieved_at: null,
  reason: null,
  recorded_by_email: null,
  recorded_at: null,
  ...over,
});

const renderOnboarding = (steps: OnboardingStep[], capabilities: PlatformCapability[]) => render(
  <ToastProvider>
    <CustomerOnboarding
      orgId="53000000-0000-4000-8000-000000000001"
      steps={steps}
      may={(capability) => capabilities.includes(capability)}
      busy={false}
      run={() => {}}
    />
  </ToastProvider>,
);

describe('מצב הלקוח', () => {
  it('מציג את הסיבות שהובילו לסטטוס, לא ציון', () => {
    render(<CustomerHealth health={health()} />);
    expect(screen.getByText('דורש תשומת לב')).toBeInTheDocument();
    expect(screen.getByText(/לפני יותר משבועיים/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('«אין מספיק נתונים» אינו ירוק ואינו מתחזה לבדיקה שעברה', () => {
    render(<CustomerHealth health={health({ status: 'unknown', signals: [], last_activity_at: null })} />);
    expect(screen.getByText('אין מספיק נתונים')).toBeInTheDocument();
    expect(screen.getByText(/לא מבדיקה שעברה/)).toBeInTheDocument();
  });

  it('אינו מציג דבר כשאין הרשאה — הפונקציה מחזירה null', () => {
    const { container } = render(<CustomerHealth health={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('הקמה והפעלה', () => {
  it('שלב שהושלם בפעולה במוצר אינו מציע רישום ידני כלל', () => {
    // Not a permission decision: there is nothing to record. Offering the control would invite an
    // operator to write a note the server correctly ignores.
    renderOnboarding(
      [step({ step_key: 'suppliers_imported', label: 'ספקים הוזנו', state: 'completed', source: 'product_event', achieved_at: '2026-08-01T00:00:00.000Z' })],
      ['onboarding.edit'],
    );
    expect(screen.getByText('לפי פעולה במוצר')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /רישום/ })).not.toBeInTheDocument();
  });

  it('שלב ללא ראיה במוצר מציע רישום למי שיש לו הרשאה, ולא לאחרים', () => {
    renderOnboarding([step()], ['onboarding.edit']);
    expect(screen.getByRole('button', { name: /רישום/ })).toBeInTheDocument();
  });

  it('מסתיר את הרישום ממפעיל ללא הרשאת עריכת הקמה', () => {
    renderOnboarding([step()], ['customer.view']);
    expect(screen.queryByRole('button', { name: /רישום/ })).not.toBeInTheDocument();
  });

  it('מציג את הסיבה ואת מי שרשם אותה', () => {
    renderOnboarding(
      [step({ state: 'skipped', source: 'operator_manual', reason: 'הבעלים עובד לבד', recorded_by_email: 'ops@inplace.test' })],
      ['customer.view'],
    );
    expect(screen.getByText(/הבעלים עובד לבד/)).toBeInTheDocument();
    expect(screen.getByText(/ops@inplace.test/)).toBeInTheDocument();
    expect(screen.getByText('נרשם בידי מפעיל')).toBeInTheDocument();
  });
});
