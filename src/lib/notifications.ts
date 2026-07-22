import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { supabase } from './supabase';

export interface NotificationRow {
  id: string;
  org_id: string;
  user_id: string;
  event_code: string;
  entity_key: string;
  severity: 'warning' | 'critical';
  title: string;
  body: string;
  target_url: string;
  created_at: string;
  read_at: string | null;
}

export const NOTIFICATIONS_READ_EVENT = 'sf:notifications-read';

export function useUnreadNotifications(enabled = true): number | null {
  const { profile } = useAuth();
  const [count, setCount] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!enabled || !profile) { setCount(null); return; }
    const { count: next, error } = await supabase.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', profile.id).is('read_at', null);
    if (!error) setCount(next ?? 0);
  }, [enabled, profile]);

  useEffect(() => {
    if (!enabled || !profile) { setCount(null); return; }
    void load();
    // Layout renders separate mobile and desktop bells; each subscription needs its own
    // channel instance. Reusing one topic makes the second hook add callbacks after the
    // first instance has already subscribed, which Realtime rejects at runtime.
    const channel = supabase.channel(`notification-bell:${profile.id}:${crypto.randomUUID()}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'notifications',
        filter: `user_id=eq.${profile.id}`,
      }, () => { void load(); })
      .subscribe();
    const refresh = () => { void load(); };
    window.addEventListener(NOTIFICATIONS_READ_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener(NOTIFICATIONS_READ_EVENT, refresh);
      window.removeEventListener('focus', refresh);
      void supabase.removeChannel(channel);
    };
  }, [enabled, profile, load]);

  return count;
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  const { error } = await supabase.from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId).is('read_at', null);
  if (!error) window.dispatchEvent(new Event(NOTIFICATIONS_READ_EVENT));
}
