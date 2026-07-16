import { useState } from 'react';
import { Settings as SettingsIcon, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useQuery, unwrap } from '../lib/useQuery';
import { useAuth } from '../auth/AuthContext';
import { PageLoader, useToast, ErrorNote } from '../components/ui';
import { ROLE_LABEL } from '../lib/status';
import type { Profile } from '../lib/types';

export default function Settings() {
  const { profile, org } = useAuth();
  const toast = useToast();
  const [vatRate, setVatRate] = useState(org?.vat_rate?.toString() ?? '18');
  const [matchDays, setMatchDays] = useState(org?.settings?.bank_match_days?.toString() ?? '7');
  const [tolerance, setTolerance] = useState(org?.settings?.bank_match_amount_tolerance?.toString() ?? '1');
  const [busy, setBusy] = useState(false);

  const { data: users, loading, error, refetch } = useQuery<Profile[]>(async () =>
    unwrap(await supabase.from('profiles').select('*').order('full_name')));

  async function saveOrg() {
    setBusy(true);
    const res = await supabase.from('organizations').update({
      vat_rate: Number(vatRate),
      settings: { bank_match_days: Number(matchDays), bank_match_amount_tolerance: Number(tolerance) },
    }).eq('id', profile!.org_id);
    setBusy(false);
    if (res.error) { toast(res.error.message, 'error'); return; }
    toast('ההגדרות נשמרו — ייכנסו לתוקף בכניסה הבאה');
  }

  async function toggleActive(u: Profile) {
    const res = await supabase.from('profiles').update({ active: u.active! }).eq('id', u.id);
    if (res.error) { toast(res.error.message, 'error'); return; }
    toast(u.active ? 'המשתמש הושבת' : 'המשתמש הופעל');
    void refetch();
  }

  if (loading) return <PageLoader />;
  if (error) return <ErrorNote message={error} />;

  return (
    <div className="space-y-5 max-w-3xl">
      <h1 className="page-title flex items-center gap-2"><SettingsIcon size={22} /> הגדרות מערכת</h1>

      <div className="card card-pad space-y-4">
        <h2 className="section-title">הגדרות עסק</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div><label className="label">שיעור מע״מ (%)</label><input type="number" step="0.5" className="input num" value={vatRate} onChange={(e) => setVatRate(e.target.value)} /></div>
          <div><label className="label">טווח ימים להתאמת בנק</label><input type="number" className="input num" value={matchDays} onChange={(e) => setMatchDays(e.target.value)} /></div>
          <div><label className="label">סטיית סכום מותרת (₪)</label><input type="number" step="0.5" className="input num" value={tolerance} onChange={(e) => setTolerance(e.target.value)} /></div>
        </div>
        <div className="flex justify-end"><button className="btn-primary" disabled={busy} onClick={() => void saveOrg()}>שמירה</button></div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 section-title flex items-center gap-2"><Users size={17} /> משתמשים והרשאות</div>
        <table className="w-full">
          <thead className="bg-slate-50"><tr><th className="th">שם</th><th className="th">תפקיד</th><th className="th">טלפון</th><th className="th">סטטוס</th><th className="th"></th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {users?.map((u) => (
              <tr key={u.id}>
                <td className="td font-medium">{u.full_name}{u.id === profile?.id && <span className="text-xs text-slate-400 ms-2">(אתה)</span>}</td>
                <td className="td">{ROLE_LABEL[u.role]}</td>
                <td className="td" dir="ltr">{u.phone ?? '—'}</td>
                <td className="td">{u.active ? <span className="badge-green">פעיל</span> : <span className="badge-slate">מושבת</span>}</td>
                <td className="td">
                  {u.id !== profile?.id && (
                    <button className="btn-ghost py-1! text-xs" onClick={() => void toggleActive(u)}>{u.active ? 'השבתה' : 'הפעלה'}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-4 py-3 text-xs text-slate-400 border-t border-slate-100">
          הוספת משתמש צוות: דרך לוח Supabase (Authentication) + שורת פרופיל. סוכן ספק (גישה למחירון שלו בלבד):
          <code className="mx-1" dir="ltr">scripts\create-supplier-user.ps1</code>
        </div>
      </div>
    </div>
  );
}
