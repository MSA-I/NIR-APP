import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { supabase } from './supabase';
import type { TKey } from './i18n/t';

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

/** How many delivered notifications `/alerts` reads before grouping. Recent, not complete. */
export const NOTIFICATION_FEED_LIMIT = 50;

/**
 * What the bell knows.
 *
 * `count` is `null` for "not known", and `failed` says WHICH kind of not-known it is. Until
 * 26.08.2026 the hook returned a bare `number | null` and swallowed the error branch entirely
 * (`if (!error) setCount(...)`), so a failed read left the bell sitting on `null` forever — and a
 * bell with no badge is a positive claim that nothing is waiting. Loading is allowed to look like
 * silence, because it lasts a moment and nobody asked the chrome a question; a failure is not,
 * because it lasts until the next focus and it is the exact state in which unseen work is most
 * likely to exist.
 */
export interface UnreadNotifications {
  count: number | null;
  failed: boolean;
}

export function useUnreadNotifications(enabled = true): UnreadNotifications {
  const { profile } = useAuth();
  const [state, setState] = useState<UnreadNotifications>({ count: null, failed: false });

  const load = useCallback(async () => {
    if (!enabled || !profile) { setState({ count: null, failed: false }); return; }
    const { count: next, error } = await supabase.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', profile.id).is('read_at', null);
    // A later success clears the failure — this is one live reading, not a sticky banner.
    setState(error ? { count: null, failed: true } : { count: next ?? 0, failed: false });
  }, [enabled, profile]);

  useEffect(() => {
    if (!enabled || !profile) { setState({ count: null, failed: false }); return; }
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

  return state;
}

/**
 * The delivered notifications themselves — the rows the bell has been counting since 0017 and
 * that nothing in the product ever rendered (26.08.2026 audit; `NotificationRow` was an exported
 * interface with no consumer).
 *
 * WHY THIS EXISTS AT ALL. The bell counts rows in `notifications`. `/alerts` renders
 * `buildSummary()`, a LIVE scan of standing conditions (`alerts.ts`). They are two different
 * catalogues that merely overlap: `document_processing_stalled` — the one operational event, and
 * the only code present in the demo tenant — has no scan at all, so a bell reading "23" opened a
 * page that never mentioned document processing, and then silently marked all 23 read. That is
 * the owner's "נראה שיש מלא דברים שחסרים", and it is a reporting gap, not a missing feature.
 *
 * RECENT, NOT COMPLETE, AND THE SCREEN SAYS SO. `0142` writes one row per hour for as long as
 * processing is stuck (`dedupe_key` carries the hour), so an unbounded list is the same sentence
 * printed twenty times. The cap is honest only because the screen prints it.
 */
export async function readNotifications(userId: string): Promise<NotificationRow[]> {
  const { data, error } = await supabase.from('notifications')
    .select('id, org_id, user_id, event_code, entity_key, severity, title, body, target_url, created_at, read_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(NOTIFICATION_FEED_LIMIT);
  if (error) throw new Error(error.message);
  return (data ?? []) as NotificationRow[];
}

/** One standing condition, and every time it was announced inside the window. */
export interface NotificationGroup {
  key: string;
  /** The newest announcement — its wording carries the current figures. */
  latest: NotificationRow;
  /** How many times this same condition was sent inside the window. Never fewer than 1. */
  occurrences: number;
  /** How many of those were still unread when the window was read. */
  unread: number;
}

/**
 * Collapse repeat announcements of the SAME condition.
 *
 * A standing condition is re-announced on a schedule — `0142` writes one row per hour for as long
 * as document processing is stuck, its `dedupe_key` carrying the hour — so a raw feed prints the
 * same sentence twenty times and buries every other event under it. The demo tenant is the proof:
 * 23 rows, one condition. `event_code` + `entity_key` IS the identity of the condition (the pair
 * every producer since 0017 writes), so grouping on it summarises rather than interprets, and the
 * count is printed on screen so nothing is hidden — the reader is told it happened 23 times.
 *
 * Order is preserved: groups come back ranked by their newest member, which is the order the rows
 * arrived in.
 */
export function groupNotifications(rows: readonly NotificationRow[]): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  for (const row of rows) {
    const key = `${row.event_code}::${row.entity_key}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { key, latest: row, occurrences: 1, unread: row.read_at === null ? 1 : 0 });
      continue;
    }
    existing.occurrences += 1;
    if (row.read_at === null) existing.unread += 1;
    // The caller reads newest-first, but a group must not depend on that to name its own latest.
    if (row.created_at > existing.latest.created_at) existing.latest = row;
  }
  return [...groups.values()];
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
export const NOTIFICATION_EVENT_LABELS: Record<string, { labelKey: TKey; detailKey: TKey }> = {
  duplicate_invoice: {
    labelKey: 'notificationEvents.duplicateInvoice',
    detailKey: 'notificationEvents.duplicateInvoiceDetail',
  },
  payment_due: {
    labelKey: 'notificationEvents.paymentDue',
    detailKey: 'notificationEvents.paymentDueDetail',
  },
  price_increase: {
    labelKey: 'notificationEvents.priceIncrease',
    detailKey: 'notificationEvents.priceIncreaseDetail',
  },
  document_processing_stalled: {
    labelKey: 'notificationEvents.documentStalled',
    detailKey: 'notificationEvents.documentStalledDetail',
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
