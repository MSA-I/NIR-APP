import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
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
    documents_completed: 0,
    documents_review_required: 0,
    documents_failed: 0,
    oldest_queue_age_seconds: null,
    retry_count: 1,
    average_processing_duration_ms: null,
    last_failure: null,
    last_interpretation: null,
    usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, cost: null },
    automatically_classified: 0,
    automatically_applied_documents: 0,
    reprocessed_documents: 0,
    price_list_results: { automatically_applied: 0, partially_applied: 0, review_required: 0, reverted: 0 },
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
    from: vi.fn(),
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
    const contract = String(query);
    const data = contract.includes('get_document_operations_metrics')
      ? runtime.operationsMetrics
      : contract.includes('get_price_list_calibration_metrics') || contract.includes('get_price_list_drift_metrics')
        ? null
        : [];
    return {
      data,
      loading: data === null,
      fetching: false,
      error: null,
      refetch: runtime.refetch,
    };
  },
}));

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentOperations.tsx'), 'utf8');
const model = readFileSync(join(process.cwd(), 'src', 'pages', 'documentOperationsModel.ts'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const layout = readFileSync(join(process.cwd(), 'src', 'components', 'Layout.tsx'), 'utf8');
const ui = readFileSync(join(process.cwd(), 'src', 'components', 'ui.tsx'), 'utf8');

const attempt = (status: string, price_list_outcome: string | null = null, reverted: boolean | null = false) => ({
  status,
  price_list_outcome,
  reversal_known: true,
  reverted,
});

describe('document operations capability and UX contract', () => {
  it('is owner-only in the real router and navigation', () => {
    expect(app).toContain('path="/documents/operations" element={<Guard roles={[\'owner\']}><DocumentOperations /></Guard>}');
    expect(layout).toContain("{ to: '/documents/operations', label: 'תפעול מסמכים', icon: Activity, roles: ['owner'] }");
    expect(app).not.toContain('roles={[\'office\']}><DocumentOperations');
    expect(app).not.toContain('roles={[\'accountant\']}><DocumentOperations');
  });

  it('uses owner operations/calibration contracts and never exposes service/platform automation commands', () => {
    expect(source).toContain("supabase.rpc('get_document_operations_metrics'");
    expect(source).toContain("supabase.rpc('get_document_processing_attempts'");
    expect(source).toContain("supabase.rpc('get_price_list_calibration_metrics'");
    expect(source).toContain("supabase.rpc('get_price_list_calibration_queue'");
    expect(model).toContain("'record_price_list_calibration_review'");
    expect(model).toContain("'record_price_list_empty_run_review'");
    expect(source).toContain("supabase.rpc('get_price_list_drift_metrics'");
    expect(source).not.toContain("supabase.rpc('run_price_list_shadow'");
    expect(source).not.toContain("supabase.rpc('platform_set_price_list_automation_scope'");
  });

  it('maps operational states to clear Hebrew meanings', () => {
    expect(source).toContain('title="עיבוד תקוע" value={fmtNum(metrics.documents_stuck)}');
    expect(attemptStatusMeta(attempt('queued')).label).toBe('ממתין לעיבוד');
    expect(attemptStatusMeta(attempt('interpreting')).label).toBe('בעיבוד');
    expect(attemptStatusMeta(attempt('completed')).label).toBe('הושלם');
    expect(attemptStatusMeta(attempt('review')).label).toBe('נדרשת בדיקה');
    expect(attemptStatusMeta(attempt('failed')).label).toBe('העיבוד נכשל');
    expect(attemptStatusMeta(attempt('completed', 'partially_applied')).label).toBe('הוחל חלקית');
    expect(attemptStatusMeta(attempt('completed', 'auto_applied')).label).toBe('הוחל אוטומטית');
    expect(attemptStatusMeta(attempt('completed', 'auto_applied', true)).label).toBe('בוטל');
  });

  it('shows an owner-only recovery action for the canonical stuck issue without hiding it on mobile', () => {
    expect(source).toContain("const canRecoverStuck = canWrite && profile?.role === 'owner'");
    expect(source).toContain('onRecoverIssue={canRecoverStuck ? (attempt) => setRecoveryTarget(attempt) : null}');
    expect(source).toContain("onRecoverIssue && attemptUiStatus(currentIssue).state === 'stuck'");
    expect(source).toContain('className="btn-primary min-h-11 w-full sm:w-auto"');
    expect(source).toContain('שחזור עיבוד');
    expect(source).not.toContain('group-hover:');
  });

  it('renders the real operations route at 428px and announces recovery while the request is pending', async () => {
    const viewport = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(428);
    window.dispatchEvent(new Event('resize'));
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
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/documents/operations',
            element: createElement(DocumentOperations),
          }),
        ),
      ),
    ));

    expect(window.innerWidth).toBe(428);
    const recoverAction = screen.getByRole('button', { name: 'שחזור עיבוד' });
    expect(recoverAction).toBeVisible();
    fireEvent.click(recoverAction);

    const dialog = screen.getByRole('dialog', { name: 'שחזור עיבוד תקוע' });
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'העיבוד תקוע מעל שמונה שעות' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'שחזור עיבוד' }));

    await waitFor(() => expect(runtime.invoke).toHaveBeenCalledWith(
      'recover-document-processing',
      {
        body: {
          job_id: 'job-stuck',
          request_id: expect.any(String),
          reason: 'העיבוד תקוע מעל שמונה שעות',
        },
      },
    ));
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByText('מעבד…')).toBeVisible();

    await act(async () => {
      settleRecovery({ data: { outcome: 'requeued', job_id: 'job-successor', idempotent: false }, error: null });
    });
    expect(await screen.findByText('נפתח ניסיון עיבוד חדש.')).toHaveAttribute('role', 'status');
    expect(screen.queryByRole('dialog', { name: 'שחזור עיבוד תקוע' })).not.toBeInTheDocument();
    // Three explicit refreshes plus the same three listeners notified by the processing event.
    expect(runtime.refetch).toHaveBeenCalledTimes(6);
    viewport.mockRestore();
  });

  it('derives the visible alert from the current attempt instead of the historical last-failure metric', () => {
    expect(source).toContain('const currentProcessing = useDocumentProcessing()');
    expect(source).toContain('const currentStatusAttempts = useMemo<CurrentIssueRow[]>');
    expect(source).toContain('selectPrimaryOperationalIssue(currentStatusAttempts)');
    expect(source).not.toContain('selectPrimaryOperationalIssue(listedCurrentAttempts)');
    expect(source).toContain('<OperationsOverview query={operations} currentIssue={currentIssue}');
    expect(source).not.toContain('metrics.last_failure.message');
    const failed = { ...attempt('failed'), updated_at: '2026-08-13T08:00:00Z' };
    const stuck = {
      ...attempt('leased'), updated_at: '2026-08-13T01:00:00Z', is_stuck: true,
      stuck_reason: 'active_over_two_hours',
    };
    expect(selectPrimaryOperationalIssue([failed, stuck])).toBe(stuck);
    expect(selectPrimaryOperationalIssue([failed])).toBe(failed);
  });

  it('reads the stable Hebrew message from a non-2xx function Response', async () => {
    const response = new Response(JSON.stringify({
      error: { code: 'recovery_in_progress', message: 'העיבוד עדיין מחזיק הרשאה פעילה.' },
    }), { status: 409, headers: { 'content-type': 'application/json' } });
    await expect(recoveryInvokeErrorMessage({
      data: null,
      error: { message: 'Edge Function returned a non-2xx status code' },
      response,
    })).resolves.toBe('העיבוד עדיין מחזיק הרשאה פעילה.');
  });

  it('also reads FunctionsHttpError.context and rejects malformed/internal payloads', async () => {
    const context = new Response(JSON.stringify({ error: { message: 'יש לרענן את הרשימה.' } }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
    await expect(recoveryInvokeErrorMessage({ error: { context } })).resolves.toBe('יש לרענן את הרשימה.');
    await expect(recoveryInvokeErrorMessage({
      error: { context: new Response(JSON.stringify({ internal: 'postgres secret' }), { status: 500 }) },
    })).resolves.toBeNull();
  });

  it('uses the exact snake-case recovery request and response contract', () => {
    expect(source).toContain('job_id: recoveryTarget.job_id');
    expect(source).toContain('request_id: crypto.randomUUID()');
    expect(source).toContain("job_id?: string; idempotent?: boolean");
    expect(source).not.toContain('jobId: recoveryTarget.job_id');
  });

  it('keeps recovery progress announced while its spinner is decorative', () => {
    expect(source).toContain('requireReason busy={recovering}');
    expect(source).toContain('confirmLabel="שחזור עיבוד"');
    expect(ui).toContain('aria-busy={busy || undefined}');
    expect(ui).toContain('className="animate-spin" aria-hidden="true"');
    expect(ui).toContain('<span>מעבד…</span>');
  });

  it('requires a reason for reprocessing and keeps unknown measures as a dash', () => {
    expect(source).toContain("supabase.rpc('reprocess_document'");
    expect(source).toContain('onConfirm={(reason) => void reprocess(reason)} requireReason');
    expect(source).toContain("value == null ? '—'");
    expect(source).toContain('עלות מוצגת רק כשהספק מדווח אותה');
    expect(source).toContain('אין בסיס להשוואה');
  });

  it('routes structural drift to shadow while keeping numeric drift as telemetry only', () => {
    expect(source).toContain('מבטל זכאות קודמת ומעביר אוטומטית את המבנה החדש למצב צל');
    expect(source).toContain('הם אינם מייצרים סף drift אוטומטי ואינם משנים לבדם את זכאות המבנה');
    expect(source).toContain('סף הביטחון המפורש של מדיניות הקליטה ממשיך להיבדק לכל מסמך');
    expect(source).toContain('קורפוס 50 המחירונים');
    expect(source).toContain('אין למידה עצמית או שינוי ספים אוטומטי');
  });

  it('provides named regions and logical RTL styling', () => {
    expect(source).toContain('aria-labelledby="document-operations-overview-title"');
    expect(source).toContain('aria-labelledby="document-attempts-title"');
    expect(source).toContain('aria-labelledby="price-list-calibration-title"');
    expect(source).toContain('aria-labelledby="calibration-queue-title"');
    expect(source).toContain('aria-labelledby="price-list-drift-title"');
    expect(source).toContain('aria-label="טווח מדדי תפעול"');
    expect(source).toContain('aria-label="סינון מסמכים לפי מצב תפעולי"');
    expect(source).not.toMatch(/\b(?:left|right|ml|mr|pl|pr)-\d/);
  });
});
