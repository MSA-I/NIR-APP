import { toHebrewError } from './errors';
import { supabase } from './supabase';
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

  /*
   * The id is ours, and the picture goes first (0124).
   *
   * The obvious order — insert, upload, then update the row with the path — needs an UPDATE grant
   * on this table, and `p0_client_dml_acl.sql:188` asserts by name that the browser has none: the
   * row is a record, not a draft. Generating the id here lets the upload address its destination
   * before the row exists, so the insert carries the path and nothing is ever updated.
   *
   * The guarantee this was built around is untouched. Everything above the insert can fail and the
   * note still arrives, carrying nulls instead of a path.
   *
   * created_at, sent_at and send_error stay absent on purpose: the browser holds no grant on them
   * (0091), so "נשלח" cannot originate here.
   */
  const noteId = crypto.randomUUID();
  const attachment = screenshot ? await uploadScreenshot(noteId, orgId, screenshot) : null;
  const inserted = await supabase.from('feedback_notes')
    .insert({
      id: noteId,
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
      ...attachment,
    })
    .select('id')
    .single();

  if (inserted.error || !inserted.data) {
    return { saved: false, delivered: false, screenshotAttached: false,
             message: toHebrewError(inserted.error) };
  }

  const attached = Boolean(attachment);
  const pictureNote = screenshot && !attached ? ' · הצילום לא צורף' : '';

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
 * Upload the capture, and hand back the columns the insert should carry.
 *
 * The path is `{org_id}/{note_id}.png`: the tenant prefix that 0122's storage policy READS out of
 * the name and compares against `auth_org()`, then the note id, so one note can hold exactly one
 * picture and a retry overwrites rather than accumulates.
 *
 * Returns null on any failure, quietly. The note is written next either way, and somebody who took
 * the trouble to write a sentence should not be handed a storage error about a courtesy.
 *
 * If the INSERT then fails, this leaves an orphaned object: a PNG under 4 MB, in the tenant's own
 * folder, in a bucket with no read policy at all. That is a cheaper thing to own than the standing
 * UPDATE grant the other ordering would need (0124).
 */
async function uploadScreenshot(
  noteId: string,
  orgId: string,
  screenshot: ScreenshotCapture,
): Promise<Record<string, string | number> | null> {
  const path = orgId + '/' + noteId + '.png';
  const uploaded = await supabase.storage.from('feedback')
    .upload(path, screenshot.blob, { contentType: 'image/png', upsert: true });
  if (uploaded.error) return null;
  return {
    screenshot_path: path,
    screenshot_bytes: screenshot.bytes,
    screenshot_checksum: screenshot.checksum,
    screenshot_mime: 'image/png',
  };
}
