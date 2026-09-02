import { supabase } from './supabase';

/**
 * The signed link a reviewer follows to see the original file — and the one place that decides
 * whether the browser is allowed to *render* what it finds there.
 *
 * An uploaded HTML file is a real supplier document, not an attack: migration `0045` allowlists
 * `text/html`, `worker/ocr/src/parsers.py` extracts from it, and `PriceListUpload` accepts it
 * because suppliers export price tables straight out of a mail client. Removing the type would
 * break a live intake path and would not disarm a single byte already in the bucket.
 *
 * What the file must not do is execute. Storage serves an object under the project's own origin,
 * so script inside one that the browser renders inline runs there. Asking for the object as a
 * download makes Storage answer `Content-Disposition: attachment`: the reviewer still gets the
 * file, the browser never parses it as a page. Everything else — PDFs, images — keeps opening
 * in the tab, which is the whole point of the popup.
 */
const ACTIVE_CONTENT_MIME_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  // Not in the document allowlist today. Listed anyway: an SVG is a script host, and the cost of
  // this line is one string against the cost of noticing the day the allowlist grows.
  'image/svg+xml',
]);

/** True when a browser would run script inside the object rather than just display it. */
export function rendersAsActiveContent(mimeType: string | null | undefined): boolean {
  return ACTIVE_CONTENT_MIME_TYPES.has((mimeType ?? '').trim().toLowerCase());
}

/**
 * A signed URL for a stored document, downloaded instead of rendered when it could execute.
 * Throws on failure so callers keep the one error path `openReservedPopup` already reports.
 */
export async function signedDocumentSourceUrl(
  storagePath: string,
  expiresIn: number,
  mimeType: string | null | undefined,
  bucket: string = 'documents',
): Promise<string> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(
    storagePath,
    expiresIn,
    rendersAsActiveContent(mimeType) ? { download: true } : undefined,
  );
  if (error || !data?.signedUrl) throw error ?? new Error('signed URL missing');
  return data.signedUrl;
}
