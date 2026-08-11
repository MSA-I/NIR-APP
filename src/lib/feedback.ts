import { supabase } from './supabase';
import { toHebrewError } from './errors';
import type { ScreenshotCapture } from './screenshot';
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

/** Matches the feedback_notes_note_length check in 0091. */
export const NOTE_MAX_LENGTH = 1500;

export interface FeedbackContext {
  /** The screen the person was on. This is what makes a note actionable without asking. */
  route: string;
  role: Role;
  viewportWidth: number | null;
  /** VITE_RELEASE — the same build identifier the app reports to Sentry. */
  appRelease: string | null;
  /**
   * The tab title, the query string and the hash, separately from `route` (0122).
   *
   * `route` is capped at 200 characters by 0091, and a filtered list can spend more than that on
   * its query string alone — while the filters ARE the state the report is about. The title names
   * the screen in the words the customer uses rather than the words the router uses.
   */
  pageTitle: string | null;
  routeQuery: string | null;
  routeHash: string | null;
}

export interface FeedbackOutcome {
  saved: boolean;
  delivered: boolean;
  /**
   * Whether the picture made it. A THIRD truth, kept apart from the other two for the same reason
   * they are kept apart from each other: "saved" and "delivered" are different facts, and so is
   * "the screenshot you were shown is the one they got".
   */
  screenshotAttached: boolean;
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
  screenshot?: ScreenshotCapture | null,
): Promise<FeedbackOutcome> {
  const trimmed = note.trim();
  if (!trimmed) {
    return { saved: false, delivered: false, screenshotAttached: false,
             message: 'אין מה לשלוח — ההערה ריקה' };
  }

  // created_at, sent_at and send_error are absent on purpose: the browser holds no grant on them
  // (0091), so "נשלח" cannot originate here.
  const inserted = await supabase.from('feedback_notes')
    .insert({
      org_id: orgId,
      user_id: userId,
      note: trimmed,
      route: context.route,
      role: context.role,
      viewport_width: context.viewportWidth,
      app_release: context.appRelease,
      page_title: context.pageTitle,
      route_query: context.routeQuery,
      route_hash: context.routeHash,
    })
    .select('id')
    .single();

  if (inserted.error || !inserted.data) {
    return { saved: false, delivered: false, screenshotAttached: false,
             message: toHebrewError(inserted.error) };
  }

  // The picture, after the words and never before them. Everything below this line can fail without
  // costing the note: the row already exists, and a failed upload leaves it a note with no
  // screenshot — which is why every column 0122 adds is nullable.
  const noteId = inserted.data.id as string;
  const attached = screenshot ? await attachScreenshot(noteId, orgId, screenshot) : false;
  const pictureNote = screenshot && !attached ? ' (הצילום לא נשמר — ההערה נשלחה בלעדיו)' : '';

  const { data, error } = await supabase.functions.invoke('send-feedback', {
    body: { noteId },
  });

  if (error) {
    const message = await edgeMessage(error);
    return { saved: true, delivered: false, screenshotAttached: attached,
             message: (message ?? 'ההערה נשמרה, אך השליחה נכשלה') + pictureNote };
  }
  const failed = (data as { error?: EdgeError } | null)?.error;
  if (failed) {
    return { saved: true, delivered: false, screenshotAttached: attached,
             message: (failed.message ?? 'ההערה נשמרה, אך השליחה נכשלה') + pictureNote };
  }

  return { saved: true, delivered: true, screenshotAttached: attached,
           message: 'ההערה נשלחה. תודה — היא מגיעה אליי מיד.' + pictureNote };
}

/**
 * Upload the capture and point the note at it.
 *
 * The path is `{org_id}/{note_id}.png`: the tenant prefix that 0122's storage policy READS out of
 * the name and compares against `auth_org()`, then the note id, so one note can hold exactly one
 * picture and a retry overwrites rather than accumulates.
 *
 * Returns false on any failure, quietly. The caller has already saved the note, and somebody who
 * wrote a sentence should not be handed a storage error about a courtesy.
 */
async function attachScreenshot(
  noteId: string,
  orgId: string,
  screenshot: ScreenshotCapture,
): Promise<boolean> {
  const uploaded = await supabase.storage.from('feedback')
    .upload(orgId + '/' + noteId + '.png', screenshot.blob,
            { contentType: 'image/png', upsert: true });
  if (uploaded.error) return false;

  const updated = await supabase.from('feedback_notes')
    .update({
      screenshot_path: orgId + '/' + noteId + '.png',
      screenshot_bytes: screenshot.bytes,
      screenshot_checksum: screenshot.checksum,
      screenshot_mime: 'image/png',
    })
    .eq('id', noteId);
  return !updated.error;
}
