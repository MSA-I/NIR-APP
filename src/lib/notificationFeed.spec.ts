import { describe, expect, it } from 'vitest';
import { groupNotifications, type NotificationRow } from './notifications';

/**
 * The repeat-announcement collapse (26.08.2026 audit).
 *
 * The bell counted rows the product never rendered. Rendering them raw is not the fix on its own:
 * `0142` re-announces a stuck processing queue every hour with an hour-stamped `dedupe_key`, so
 * the demo tenant's feed is 23 rows of one sentence. The screen must show the condition once and
 * SAY how many times it was sent — summarising, never hiding.
 */
function row(over: Partial<NotificationRow> & { id: string }): NotificationRow {
  return {
    org_id: 'org-1',
    user_id: 'u-1',
    event_code: 'document_processing_stalled',
    entity_key: 'org-1',
    severity: 'critical',
    title: 'עיבוד המסמכים אינו מתקדם',
    body: '1 ממתינים בתור',
    target_url: '/documents',
    created_at: '2026-08-26T08:00:00.000Z',
    read_at: null,
    ...over,
  };
}

describe('קיבוץ הודעות שנשלחו', () => {
  it('מאחד חזרות של אותו תנאי ומונה אותן', () => {
    const groups = groupNotifications([
      row({ id: 'c', created_at: '2026-08-26T11:00:00.000Z' }),
      row({ id: 'b', created_at: '2026-08-26T10:00:00.000Z' }),
      row({ id: 'a', created_at: '2026-08-26T09:00:00.000Z' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].occurrences).toBe(3);
    // The newest announcement carries the current figures, so it is the one shown.
    expect(groups[0].latest.id).toBe('c');
  });

  /** Identity is the pair every producer since 0017 writes, not the wording. */
  it('אינו מאחד תנאים שונים או ישויות שונות', () => {
    const groups = groupNotifications([
      row({ id: 'a', event_code: 'duplicate_invoice', entity_key: 'inv-1' }),
      row({ id: 'b', event_code: 'duplicate_invoice', entity_key: 'inv-2' }),
      row({ id: 'c', event_code: 'price_increase', entity_key: 'inv-1' }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.occurrences === 1)).toBe(true);
  });

  /** A group is "new" if ANY of its announcements was unread — one seen repeat cannot mute it. */
  it('סופר את מה שטרם נקרא בתוך הקבוצה', () => {
    const groups = groupNotifications([
      row({ id: 'c', created_at: '2026-08-26T11:00:00.000Z', read_at: null }),
      row({ id: 'b', created_at: '2026-08-26T10:00:00.000Z', read_at: '2026-08-26T10:30:00.000Z' }),
      row({ id: 'a', created_at: '2026-08-26T09:00:00.000Z', read_at: '2026-08-26T10:30:00.000Z' }),
    ]);
    expect(groups[0].unread).toBe(1);
    expect(groups[0].occurrences).toBe(3);
  });

  /** The caller reads newest-first; the group must not depend on that to name its own latest. */
  it('בוחר את החדש ביותר גם כשהקלט אינו ממוין', () => {
    const groups = groupNotifications([
      row({ id: 'old', created_at: '2026-08-26T09:00:00.000Z' }),
      row({ id: 'new', created_at: '2026-08-26T12:00:00.000Z' }),
    ]);
    expect(groups[0].latest.id).toBe('new');
  });

  it('קלט ריק מחזיר רשימה ריקה, לא קבוצה מומצאת', () => {
    expect(groupNotifications([])).toEqual([]);
  });
});
