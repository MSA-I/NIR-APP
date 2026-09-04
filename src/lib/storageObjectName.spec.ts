import { describe, expect, it } from 'vitest';
import { storageObjectName } from './storageObjectName';

/**
 * DOC-10. The old rule was `file.name.replace(/[^\w.\-]+/g, '_')` and it looked script-neutral.
 * It was not: `\w` here is `[A-Za-z0-9_]`, so a RUN of Hebrew collapsed into one underscore and
 * the sweep measured `א.ע עלים ירוקים — חשבונית 2026-08.jpeg` landing in the bucket as
 * `<uuid>__._2026-08.jpeg`.
 */
describe('storageObjectName — a Hebrew file name reaches the bucket recognisable', () => {
  it('transliterates rather than deletes, on the name the sweep measured', () => {
    const key = storageObjectName('א.ע עלים ירוקים — חשבונית 2026-08.jpeg');
    expect(key).not.toBe('_._2026-08.jpeg'); // the shape of the defect
    expect(key).toBe('a.a_alym_yrvqym_chshbvnyt_2026-08.jpeg');
  });

  it('leaves a Latin name exactly as the old rule left it', () => {
    // The regression that matters: every object key already in the bucket was produced by the old
    // rule, and a Latin name must keep producing the same one.
    for (const name of [
      'invoice.pdf',
      'WhatsApp_Image_2026-08-02_at_16.59.59.jpeg',
      'ADTV Ltd receipt 7352.pdf',
      'price-list.v2.xlsx',
    ]) {
      expect(storageObjectName(name)).toBe(name.replace(/[^\w.\-]+/g, '_'));
    }
  });

  it('keeps the extension, and keeps it last', () => {
    expect(storageObjectName('חשבונית ספק.pdf').endsWith('.pdf')).toBe(true);
    expect(storageObjectName('דוח שנתי.xlsx')).toBe('dvch_shnty.xlsx');
  });

  it('produces an ASCII path segment and nothing else', () => {
    for (const name of ['תעודת משלוח №7.pdf', 'קבלה 12/2026.pdf', 'ﬂ ligature café.pdf']) {
      expect(storageObjectName(name)).toMatch(/^[\w.\-]+$/);
    }
  });

  it('never returns an empty segment', () => {
    // A name that transliterates to nothing still has to name something in the bucket.
    expect(storageObjectName('🧾.pdf')).toBe('file.pdf');
    expect(storageObjectName('')).toBe('file');
  });

  it('treats a leading dot as part of the name, not as an extension', () => {
    expect(storageObjectName('.gitignore')).toBe('.gitignore');
  });

  it('caps the stem so one absurd name cannot produce an absurd key', () => {
    const key = storageObjectName(`${'חשבונית'.repeat(60)}.pdf`);
    expect(key.length).toBeLessThanOrEqual(96 + '.pdf'.length);
    expect(key.endsWith('.pdf')).toBe(true);
  });
});
