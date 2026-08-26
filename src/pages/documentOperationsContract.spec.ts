import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { NAV_SECTIONS } from '../components/Layout';
import {
  attemptStatusMeta,
  recoveryInvokeErrorMessage,
  selectPrimaryOperationalIssue,
} from './documentOperationsModel';

const runtime = vi.hoisted(() => ({
  invoke: vi.fn(),
  refetch: vi.fn(async () => true),
  operationsMetrics: {
    window_days: 30,
    documents_waiting: 0,
    documents_processing: 1,
    documents_stuck: 1,
    documents_review_required: 0,
    documents_failed: 0,
    documents_completed: 0,
    retry_count: 1,
    average_processing_duration_ms: null,
    last_processing_at: null,
  },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    organizationAccess: { canWrite: true },
    profile: { role: 'owner' },
  }),
}));

vi.mock('../lib/supabase', () => ({
  supabase: {
    functions: { invoke: runtime.invoke },
    rpc: vi.fn(),
  },
}));

vi.mock('../lib/useDocumentProcessing', () => ({
  DOCUMENT_PROCESSING_CHANGED_EVENT: 'supplyflow:document-processing-changed',
  useDocumentProcessing: () => ({
    snapshots: {
      'document-stuck': {
        job: {
          id: 'job-stuck',
          document_id: 'document-stuck',
          status: 'leased',
          attempt_count: 2,
          created_at: '2026-08-12T00:00:00.000Z',
          updated_at: '2026-08-12T00:15:00.000Z',
          lease_until: '2026-08-12T00:30:00.000Z',
          queue_age_seconds: 28_800,
          last_error_code: 'lease_expired',
          is_stuck: true,
          stuck_reason: 'active_over_two_hours',
        },
      },
    },
    refetch: runtime.refetch,
  }),
}));

vi.mock('../lib/useQuery', () => ({
  unwrap: (result: { data: unknown; error: unknown }) => {
    if (result.error) throw result.error;
    return result.data;
  },
  useQuery: (query: () => Promise<unknown>) => {
    const data = String(query).includes('get_document_operations_metrics')
      ? runtime.operationsMetrics
      : [];
    return {
      data,
      loading: false,
      fetching: false,
      error: null,
      refetch: runtime.refetch,
    };
  },
}));

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentOperations.tsx'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');

const attempt = (status: string, price_list_outcome: string | null = null) => ({
  status,
  price_list_outcome,
});

describe('document control capability and UX contract', () => {
  it('keeps the stable owner-only route while naming it בקרת מסמכים everywhere', () => {
    expect(app).toContain('path="/documents/operations" element={<Guard roles={[\'owner\']}><DocumentOperations /></Guard>}');
    const navigation = NAV_SECTIONS.flatMap((section) => section.items)
      .find((item) => item.to === '/documents/operations');
    expect(navigation).toMatchObject({ label: 'בקרת מסמכים', roles: ['owner'] });
    expect(app).not.toContain('roles={[\'office\']}><DocumentOperations');
    expect(app).not.toContain('roles={[\'accountant\']}><DocumentOperations');
  });

  it('uses only the customer-safe read models and excludes laboratory telemetry', () => {
    expect(source).toContain("supabase.rpc('get_document_operations_metrics'");
    expect(source).toContain("supabase.rpc('get_document_control_attempts'");
    expect(source).toContain("supabase.rpc('get_document_control_price_review_queue'");
    for (const retired of [
      'get_document_processing_attempts',
      'get_price_list_calibration_metrics',
      'get_price_list_calibration_queue',
      'get_price_list_drift_metrics',
      'input_tokens',
      'prompt_version',
      'schema_version',
      'document_type_confidence',
      'extraction_engine',
      'provider',
    ]) expect(source).not.toContain(retired);
  });

  it('presents the quiet summary-to-tasks-to-details hierarchy with 44px actions', () => {
    for (const label of ['דורש טיפול', 'בעיבוד', 'תקלות', 'הושלם']) {
      expect(source).toContain(`title="${label}"`);
    }
    expect(source.indexOf('מה קורה עכשיו')).toBeLessThan(source.indexOf('הפריט הדחוף ביותר'));
    expect(source.indexOf('הפריט הדחוף ביותר')).toBeLessThan(source.indexOf('מסמכים אחרונים'));
    expect(source).toContain('grid grid-cols-2 gap-3 lg:grid-cols-4');
    // The 44px floor used to be pinned here as a literal `min-h-11` repeated on every control.
    // It moved to where it belongs: `@utility btn` in index.css sets `min-h-11`, and every
    // variant applies it — so a control that wears `btn-primary` or `btn-secondary` cannot be
    // under the floor, and a control that wears neither is the actual risk. That is what this
    // now measures: every <button> and <Link> on the screen goes through the shared base.
    const controls = source.match(/<(?:button|Link)\s[^>]*?className="[^"]*"/g) ?? [];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) expect(control).toMatch(/className="[^"]*\bbtn-/);
    expect(source).not.toMatch(/overflow-x-(?:auto|scroll)/);
  });

  it('maps processing states to clear Hebrew meanings', () => {
    expect(attemptStatusMeta(attempt('queued')).label).toBe('ממתין לעיבוד');
    expect(attemptStatusMeta(attempt('interpreting')).label).toBe('בעיבוד');
    expect(attemptStatusMeta(attempt('completed')).label).toBe('הושלם');
    expect(attemptStatusMeta(attempt('review')).label).toBe('נדרשת בדיקה');
    expect(attemptStatusMeta(attempt('failed')).label).toBe('העיבוד נכשל');
    expect(attemptStatusMeta(attempt('completed', 'partially_applied')).label).toBe('הוחל חלקית');
  });

  it('renders the recovery task at mobile width and announces its result', async () => {
    const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(390);
    runtime.refetch.mockClear();
    runtime.invoke.mockReset();
    let settleRecovery!: (value: { data: unknown; error: null }) => void;
    runtime.invoke.mockReturnValue(new Promise((resolve) => { settleRecovery = resolve; }));

    const { default: DocumentOperations } = await import('./DocumentOperations');
    render(createElement(
      ToastProvider,
      null,
      createElement(
        MemoryRouter,
        { initialEntries: ['/documents/operations'] },
        createElement(Routes, null, createElement(Route, {
          path: '/documents/operations',
          element: createElement(DocumentOperations),
        })),
      ),
    ));

    expect(window.innerWidth).toBe(390);
    fireEvent.click(screen.getByRole('button', { name: 'שחזור עיבוד' }));
    const dialog = screen.getByRole('dialog', { name: 'שחזור עיבוד תקוע' });
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'העיבוד תקוע מעל שמונה שעות' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'שחזור עיבוד' }));

    await waitFor(() => expect(runtime.invoke).toHaveBeenCalledWith(
      'recover-document-processing',
      { body: { job_id: 'job-stuck', request_id: expect.any(String), reason: 'העיבוד תקוע מעל שמונה שעות' } },
    ));
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    await act(async () => {
      settleRecovery({ data: { outcome: 'requeued', job_id: 'job-successor', idempotent: false }, error: null });
    });
    expect(await screen.findByText('נפתח ניסיון עיבוד חדש.')).toHaveAttribute('role', 'status');
    viewport.mockRestore();
  });

  it('chooses current recoverable work and reads stable Edge error messages', async () => {
    const failed = { ...attempt('failed'), updated_at: '2026-08-13T08:00:00Z' };
    const stuck = {
      ...attempt('leased'), updated_at: '2026-08-13T01:00:00Z', is_stuck: true,
      stuck_reason: 'active_over_two_hours',
    };
    expect(selectPrimaryOperationalIssue([failed, stuck])).toBe(stuck);

    const response = new Response(JSON.stringify({
      error: { code: 'recovery_in_progress', message: 'העיבוד עדיין מחזיק הרשאה פעילה.' },
    }), { status: 409, headers: { 'content-type': 'application/json' } });
    await expect(recoveryInvokeErrorMessage({ error: { context: response } }))
      .resolves.toBe('העיבוד עדיין מחזיק הרשאה פעילה.');
  });
});
