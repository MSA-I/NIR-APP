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

/* ---------- per-event delivery preferences (migration 0068) ---------- */

/**
 * One row per catalogued event code, always the full set.
 *
 * `configured` is the difference between "you chose this" and "this is the default", and it is
 * display information only — never a permission. The server hands back `push_enabled` and
 * `inapp_enabled` as `true` where the member stored nothing, so **an absent row reads as on** and
 * the screen must not write anything to say so: the default is opt-**in**, and today's behaviour
 * survives an installation where nobody ever opened this card (migration 0068).
 */
export interface NotificationPreference {
  event_code: string;
  push_enabled: boolean;
  inapp_enabled: boolean;
  configured: boolean;
}

/**
 * Hebrew copy for the three live event codes.
 *
 * The catalog is the server's (`private.notification_event_definitions`, 0068:48) — it ships
 * codes, not copy, exactly like every other vocabulary the client labels. A fourth code is a seed
 * row in a migration; the matrix below renders it under its raw code rather than dropping it,
 * because silently hiding a preference the server is honouring would be worse than an untranslated
 * label.
 */
export const NOTIFICATION_EVENT_LABELS: Record<string, { label: string; detail: string }> = {
  duplicate_invoice: {
    label: 'חשד לחשבונית כפולה',
    detail: 'אותו ספק ואותו מספר חשבונית נקלטו יותר מפעם אחת',
  },
  payment_due: {
    label: 'תשלום שמועד הפירעון שלו מתקרב או עבר',
    detail: 'נבדק פעם ביום, רק על דרישות תשלום שהוזן להן תאריך',
  },
  price_increase: {
    label: 'עליית מחיר במחירון של ספק',
    detail: 'לפי המחירון — לא לפי מה שנגבה בחשבונית',
  },
};

/** Reads the full preference set for the signed-in member. Throws the raw message for `toHebrewError`. */
export async function readNotificationPreferences(): Promise<NotificationPreference[]> {
  const { data, error } = await supabase.rpc('read_notification_preferences');
  if (error) throw new Error(error.message);
  return ((data ?? []) as NotificationPreference[]).map((row) => ({
    event_code: row.event_code,
    // Defensive coalescing, not a policy: the contract guarantees booleans, and a missing one
    // must read as "delivering" so a wire surprise can never silently mute a member.
    push_enabled: row.push_enabled !== false,
    inapp_enabled: row.inapp_enabled !== false,
    configured: row.configured === true,
  }));
}

/**
 * Stores one preference row for the caller, for one event code.
 *
 * Self only and reason-free by contract: the command writes its own systemic audit reason
 * (0068:110-112), so this must not prompt the user to justify muting their own phone. Both
 * booleans travel on every call because the row carries both — the caller passes what is on
 * screen for the channel it did not touch.
 */
export async function setNotificationPreference(
  eventCode: string,
  pushEnabled: boolean,
  inappEnabled: boolean,
): Promise<void> {
  const { error } = await supabase.rpc('set_notification_preference', {
    p_event_code: eventCode,
    p_push_enabled: pushEnabled,
    p_inapp_enabled: inappEnabled,
  });
  if (error) throw new Error(error.message);
}
