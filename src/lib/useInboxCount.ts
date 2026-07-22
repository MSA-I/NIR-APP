import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { supabase } from './supabase';
import { INBOX_CHANGED_EVENT } from '../components/QuickCapture';

/**
 * Live count of inbox documents (entity_type='inbox', not soft-deleted) for the NAV pill.
 * Head-only exact count — no rows travel — refetched on every route change so the pill
 * tracks captures and re-filings as the user moves around the app, and on the
 * INBOX_CHANGED_EVENT QuickCapture fires, so a FAB capture bumps the pill without navigation.
 *
 * Returns null until a count has loaded (the pill renders only for a known count > 0 —
 * never a fabricated 0, per CLAUDE.md); once known, the previous value is kept during a
 * refetch so the sidebar doesn't flicker. `enabled=false` skips the query entirely for
 * roles that cannot act on unfiled documents (payer/supplier/accountant).
 */
export function useInboxCount(enabled = true): number | null {
  const { pathname } = useLocation();
  const [count, setCount] = useState<number | null>(null);
  const [bump, setBump] = useState(0);

  // A capture anywhere (FAB, dashboard quick action) changes the inbox → refetch the count.
  useEffect(() => {
    const onChanged = () => setBump((b) => b + 1);
    window.addEventListener(INBOX_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(INBOX_CHANGED_EVENT, onChanged);
  }, []);

  useEffect(() => {
    if (!enabled) { setCount(null); return; }
    let cancelled = false;
    void supabase.from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('entity_type', 'inbox')
      .is('deleted_at', null)
      .then(({ count: c, error }) => {
        if (!cancelled && !error) setCount(c);
      });
    return () => { cancelled = true; };
  }, [pathname, enabled, bump]);

  return count;
}
