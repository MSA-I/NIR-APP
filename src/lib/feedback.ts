import { supabase } from './supabase';
import { toHebrewError } from './errors';
import type { Role } from './types';

/**
 * Design-partner feedback notes (package 0).
 *
 * Two steps, in this order, and the order is the point: the row is written first and the Discord
 * message is sent second. A note somebody took the trouble to write must survive a failed send, so
 * the outcome below distinguishes three states — not saved, saved but not delivered, delivered.
 * The UI says which one happened; it never reports delivery it did not observe (PRODUCT.md:62).
 *
 * The webhook URL lives only in the `send-feedback` Edge Function. The browser sends an id, never
 * a message: see the function header for why.
 */

/** The flag that shows the surface. Gates UI only — never permission (the 0059 flag law). */
export const FEEDBACK_FLAG = 'feedback.notes';

/** Matches the feedback_notes_note_length check in 0090. */
export const NOTE_MAX_LENGTH = 1500;

export interface FeedbackContext {
  /** The screen the person was on. This is what makes a note actionable without asking. */
  route: string;
  role: Role;
  viewportWidth: number | null;
  /** VITE_RELEASE — the same build identifier the app reports to Sentry. */
  appRelease: string | null;
}

export interface FeedbackOutcome {
  saved: boolean;
  delivered: boolean;
  /** Hebrew, ready to show. Always says what actually happened. */
  message: string;
}

interface EdgeError { code?: string; message?: string }

/** supabase-js swallows the response body on non-2xx; dig out the Hebrew reason. */
async function edgeMessage(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try {
      const parsed = await ctx.json() as { error?: EdgeError };
      if (parsed?.error?.message) return parsed.error.message;
    } catch { /* fall through */ }
  }
  return null;
}

export async function submitFeedbackNote(
  note: string,
  orgId: string,
  userId: string,
  context: FeedbackContext,
): Promise<FeedbackOutcome> {
  const trimmed = note.trim();
  if (!trimmed) return { saved: false, delivered: false, message: 'אין מה לשלוח — ההערה ריקה' };

  // created_at, sent_at and send_error are absent on purpose: the browser holds no grant on them
  // (0090), so "נשלח" cannot originate here.
  const inserted = await supabase.from('feedback_notes')
    .insert({
      org_id: orgId,
      user_id: userId,
      note: trimmed,
      route: context.route,
      role: context.role,
      viewport_width: context.viewportWidth,
      app_release: context.appRelease,
    })
    .select('id')
    .single();

  if (inserted.error || !inserted.data) {
    return { saved: false, delivered: false, message: toHebrewError(inserted.error) };
  }

  const { data, error } = await supabase.functions.invoke('send-feedback', {
    body: { noteId: inserted.data.id },
  });

  if (error) {
    const message = await edgeMessage(error);
    return { saved: true, delivered: false, message: message ?? 'ההערה נשמרה, אך השליחה נכשלה' };
  }
  const failed = (data as { error?: EdgeError } | null)?.error;
  if (failed) {
    return { saved: true, delivered: false, message: failed.message ?? 'ההערה נשמרה, אך השליחה נכשלה' };
  }

  return { saved: true, delivered: true, message: 'ההערה נשלחה. תודה — היא מגיעה אליי מיד.' };
}
