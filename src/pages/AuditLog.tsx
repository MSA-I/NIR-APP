import { useState } from 'react';
import { ScrollText } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { DataTable, Modal, ErrorNote, SkeletonTable, type Column } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import type { AuditLog as AuditRow } from '../lib/types';

const ENTITY_LABEL: Record<string, string> = {
  suppliers: 'ספק', supplier_products: 'מחירון', purchase_orders: 'הזמנה', goods_receipts: 'קבלת סחורה',
  invoices: 'חשבונית', credit_requests: 'זיכוי', payment_requests: 'דרישת תשלום', payments: 'תשלום',
  payment_allocations: 'הקצאת תשלום', bank_allocations: 'התאמת בנק', bank_transactions: 'תנועת בנק',
  exceptions: 'חריג', monthly_exports: 'דוח חודשי',
};

const ACTION_LABEL: Record<string, string> = {
  insert: 'יצירה', update: 'עדכון', delete: 'מחיקה',
  override_duplicate_warning: 'אישור חריגה — כפילות',
  bank_match_confirmed: 'אישור התאמת בנק', bank_match_manual: 'התאמת בנק ידנית',
  month_sent_to_accountant: 'העברת חודש לרו״ח',
};

const actionLabel = (a: string) => ACTION_LABEL[a] ?? a
  .replace('order_status:', 'סטטוס הזמנה: ').replace('invoice_review:', 'סטטוס חשבונית: ')
  .replace('payment_request:', 'סטטוס דרישה: ').replace('credit_status:', 'סטטוס זיכוי: ')
  .replace('exception:', 'סטטוס חריג: ');

type Row = AuditRow & { profile?: { full_name: string } | null };

export default function AuditLogPage() {
  const [selected, setSelected] = useState<Row | null>(null);
  const [entityFilter, setEntityFilter] = useState('');

  const { data, loading, error } = useQuery(async () => {
    const logs = unwrap(await supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(400)) as Row[];
    const profiles = unwrap(await supabase.from('profiles').select('id, full_name')) as { id: string; full_name: string }[];
    const pMap = new Map(profiles.map((p) => [p.id, p.full_name]));
    return logs.map((l) => ({ ...l, profile: l.user_id ? { full_name: pMap.get(l.user_id) ?? '—' } : null }));
  });

  const rows = (data ?? []).filter((r) => !entityFilter || r.entity_type === entityFilter);
  const entities = [...new Set((data ?? []).map((r) => r.entity_type))];

  const columns: Column<Row>[] = [
    { key: 'time', header: 'מועד', sortValue: (r) => r.created_at, render: (r) => <span className="text-slate-500">{fmtDateTime(r.created_at)}</span> },
    { key: 'user', header: 'משתמש', render: (r) => r.profile?.full_name ?? <span className="text-slate-500">מערכת</span> },
    { key: 'action', header: 'פעולה', render: (r) => <span className="font-medium">{actionLabel(r.action)}</span> },
    { key: 'entity', header: 'ישות', render: (r) => ENTITY_LABEL[r.entity_type] ?? r.entity_type },
    { key: 'reason', header: 'סיבה', render: (r) => <span className="text-slate-500 max-w-72 truncate inline-block">{r.reason ?? ''}</span> },
  ];

  if (loading) return <SkeletonTable rows={12} cols={5} />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-4">
      <h1 className="page-title flex items-center gap-2"><ScrollText size={22} /> יומן ביקורת</h1>
      <DataTable rows={rows} columns={columns} pageSize={25} searchable
        searchFn={(r, q) => r.action.includes(q) || (r.reason ?? '').toLowerCase().includes(q) || (r.profile?.full_name ?? '').includes(q)}
        onRowClick={(r) => setSelected(r)}
        toolbar={
          <select className="input w-auto!" value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}>
            <option value="">כל הישויות</option>
            {entities.map((e) => <option key={e} value={e}>{ENTITY_LABEL[e] ?? e}</option>)}
          </select>
        } />

      {selected && (
        <Modal open onClose={() => setSelected(null)} title={`${actionLabel(selected.action)} — ${ENTITY_LABEL[selected.entity_type] ?? selected.entity_type}`} wide>
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-slate-500">
              <span>{fmtDateTime(selected.created_at)}</span>
              <span>{selected.profile?.full_name ?? 'מערכת'}</span>
              {selected.entity_id && <span dir="ltr" className="text-xs">{selected.entity_id}</span>}
            </div>
            {selected.reason && <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 text-amber-800">סיבה: {selected.reason}</div>}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {selected.old_values && (
                <div>
                  <div className="font-medium text-slate-600 mb-1">ערכים קודמים</div>
                  <pre className="bg-slate-50 rounded-lg p-3 text-xs overflow-auto max-h-64" dir="ltr">{JSON.stringify(selected.old_values, null, 2)}</pre>
                </div>
              )}
              {selected.new_values && (
                <div>
                  <div className="font-medium text-slate-600 mb-1">ערכים חדשים</div>
                  <pre className="bg-slate-50 rounded-lg p-3 text-xs overflow-auto max-h-64" dir="ltr">{JSON.stringify(selected.new_values, null, 2)}</pre>
                </div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
