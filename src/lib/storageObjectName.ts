/**
 * The last segment of a storage object key: the uploaded file's name, made safe for a bucket path.
 *
 * WHY THIS FILE EXISTS (`DOC-10`, 04.09.2026). Both upload paths used to write
 * `file.name.replace(/[^\w.\-]+/g, '_')`, which reads as script-neutral and is not: JavaScript's
 * `\w` outside a Unicode-property class is `[A-Za-z0-9_]`. Every Hebrew character therefore fell
 * into the negated class, and a whole RUN of them collapsed into a single underscore. Measured in
 * the sweep, `א.ע עלים ירוקים — חשבונית 2026-08.jpeg` landed as
 * `…/inbox/<uuid>__._2026-08.jpeg` — the Hebrew half of the name simply gone — while a Latin
 * name kept every character of its own. Nothing is LOST (the display name lives on the row, and
 * `RTL-A11Y-08` is about how that name is drawn, not stored); what is lost is the ability to
 * recognise anything in the bucket without a database lookup, which is the only reason the name is
 * in the key at all.
 *
 * WHY TRANSLITERATION AND NOT THE RAW NAME. The key has to stay ASCII: the bucket policy reads the
 * leading `{org_id}/` segment out of this string, the tus upload puts it on the wire in a header,
 * and every tool that lists the bucket is happier for it. Transliteration keeps the key
 * recognisable — the finding's own acceptance criterion, "a transliterated or at least partially
 * recognisable object key, as Latin names get".
 *
 * WHAT THIS IS NOT. It is not reversible and it is not a display name — it never reaches a screen.
 * Hebrew has no one-to-one Latin inverse (`ט` and `ת` both give `t`, vowels are not written), so
 * two different names can produce the same key. That is harmless here because the key is already
 * prefixed by a uuid that makes it unique; the transliteration only has to be readable.
 */

/**
 * One conventional Latin form per Hebrew letter, finals folded onto their base letter. `ch` for
 * `ח`, `sh` for `ש` and `tz` for `צ` are digraphs, so a transliterated name can be longer than the
 * original — which is why the length cap below exists.
 */
const HEBREW_TO_LATIN: Readonly<Record<string, string>> = {
  א: 'a', ב: 'b', ג: 'g', ד: 'd', ה: 'h', ו: 'v', ז: 'z', ח: 'ch', ט: 't', י: 'y',
  כ: 'k', ך: 'k', ל: 'l', מ: 'm', ם: 'm', נ: 'n', ן: 'n', ס: 's', ע: 'a', פ: 'p',
  ף: 'p', צ: 'tz', ץ: 'tz', ק: 'q', ר: 'r', ש: 'sh', ת: 't',
};

/**
 * Niqqud, cantillation and the two Hebrew punctuation marks that are not letters. Written as
 * escapes on purpose: these are invisible characters, and a literal in the source is a thing no
 * reviewer can check and no editor renders honestly.
 */
const HEBREW_DROPPED = /[\u0591-\u05BD\u05BF\u05C1-\u05C7\u05F3\u05F4]/g;
/** Combining marks, so a Latin diacritic folds onto its base letter instead of being deleted. */
const COMBINING_MARKS = /[\u0300-\u036F]/g;
/** The Hebrew alphabet, finals included. */
const HEBREW_LETTERS = /[\u05D0-\u05EA]/g;

/**
 * A bucket path segment is not the place to discover that a file name was 900 characters long.
 * The cap keeps the extension, because the extension is what storage serves the object as.
 */
const MAX_STEM = 96;

export function storageObjectName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  // A leading dot is not an extension — `.gitignore` is a name, not an empty stem.
  const hasExtension = dot > 0;
  const stem = hasExtension ? fileName.slice(0, dot) : fileName;
  const extension = hasExtension ? fileName.slice(dot) : '';

  const asciiOf = (part: string) => part
    .normalize('NFD')
    .replace(HEBREW_DROPPED, '')
    // Latin diacritics fold to their base letter rather than being deleted with the rest.
    .replace(COMBINING_MARKS, '')
    .replace(HEBREW_LETTERS, (letter) => HEBREW_TO_LATIN[letter] ?? '')
    .replace(/[^\w.\-]+/g, '_');

  const safeStem = asciiOf(stem).slice(0, MAX_STEM);
  const safeExtension = asciiOf(extension);
  // A name that transliterates to nothing at all — an emoji, say — still needs a segment.
  return (safeStem.replace(/^_+|_+$/g, '') || 'file') + safeExtension;
}
