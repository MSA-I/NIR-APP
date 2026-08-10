import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRouteAllowed } from '../../qa/config/roles';
import { attemptStatusMeta } from './documentOperationsModel';

const source = readFileSync(join(process.cwd(), 'src', 'pages', 'DocumentOperations.tsx'), 'utf8');
const model = readFileSync(join(process.cwd(), 'src', 'pages', 'documentOperationsModel.ts'), 'utf8');
const app = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
const layout = readFileSync(join(process.cwd(), 'src', 'components', 'Layout.tsx'), 'utf8');

const attempt = (status: string, price_list_outcome: string | null = null, reverted: boolean | null = false) => ({
  status,
  price_list_outcome,
  reversal_known: true,
  reverted,
});

describe('document operations capability and UX contract', () => {
  it('is owner-only in the real router, QA mirror and navigation', () => {
    expect(isRouteAllowed('owner', '/documents/operations')).toBe(true);
    for (const role of ['office', 'kitchen', 'payer', 'accountant', 'supplier'] as const) {
      expect(isRouteAllowed(role, '/documents/operations')).toBe(false);
    }
    expect(app).toContain('path="/documents/operations" element={<Guard roles={[\'owner\']}><DocumentOperations /></Guard>}');
    expect(layout).toContain("{ to: '/documents/operations', label: 'תפעול מסמכים', icon: Activity, roles: ['owner'] }");
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
    expect(attemptStatusMeta(attempt('queued')).label).toBe('ממתין');
    expect(attemptStatusMeta(attempt('interpreting')).label).toBe('בעיבוד');
    expect(attemptStatusMeta(attempt('completed')).label).toBe('הושלם');
    expect(attemptStatusMeta(attempt('review')).label).toBe('נדרשת בדיקה');
    expect(attemptStatusMeta(attempt('failed')).label).toBe('נכשל');
    expect(attemptStatusMeta(attempt('completed', 'partially_applied')).label).toBe('הוחל חלקית');
    expect(attemptStatusMeta(attempt('completed', 'auto_applied')).label).toBe('הוחל אוטומטית');
    expect(attemptStatusMeta(attempt('completed', 'auto_applied', true)).label).toBe('בוטל');
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
