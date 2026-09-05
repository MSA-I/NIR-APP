import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { productLabel } from './format';

describe('productLabel', () => {
  it('falls back to the raw name while no canonical name has been approved', () => {
    // The normal state of the catalogue. 0149 backfilled nothing, so this is the branch almost
    // every row takes, and it is why switching the display sites is a no-op until someone reviews.
    expect(productLabel({ name: 'שמן קנולה 100 מ״ל חברת דגן', display_name: null }))
      .toBe('שמן קנולה 100 מ״ל חברת דגן');
  });

  it('prefers the canonical name once a person has approved one', () => {
    expect(productLabel({ name: 'שמן קנולה 100 מ״ל חברת דגן', display_name: 'שמן קנולה — 100 מ״ל' }))
      .toBe('שמן קנולה — 100 מ״ל');
  });

  it('treats a blank canonical name as absent rather than rendering an empty cell', () => {
    // `products_display_name_shape` makes this unreachable from the database. It is reachable from
    // a row assembled in the client, and a product rendering as nothing at all is worse than a
    // product rendering under its raw name.
    expect(productLabel({ name: 'עגבניות שרי', display_name: '' })).toBe('עגבניות שרי');
    expect(productLabel({ name: 'עגבניות שרי', display_name: '   ' })).toBe('עגבניות שרי');
  });

  it('trims a canonical name it does render', () => {
    expect(productLabel({ name: 'עגבניות שרי', display_name: '  עגבניות שרי — 500 גרם  ' }))
      .toBe('עגבניות שרי — 500 גרם');
  });
});

/**
 * The half of the rule a doc comment cannot enforce.
 *
 * `productLabel` is a DISPLAY helper. Three kinds of code read a product name for something other
 * than display, and in each of them substituting a name we composed changes an outcome rather than
 * a rendering:
 *
 *   * MATCHING decides which catalogue row a spreadsheet line is. Canonicalise the key and rows
 *     that used to collide stop colliding, or start.
 *   * SUPPLIER-FACING text is read by someone who has never seen our canonical name and cannot act
 *     on it. The supplier recognises their own wording.
 *   * THE AUDIT LOG says what the record said.
 *
 * Each of these is a plausible place for a later reader to "finish the job" by importing the
 * helper, and none of them would fail any other test if they did. So the ban is stated as a test.
 *
 * Reading `display_name` directly would defeat the rule without importing anything, so the
 * identifier is banned alongside the helper in every file that must never see it.
 */
const NEITHER_LABEL_NOR_COLUMN: ReadonlyArray<readonly [string, string]> = [
  ['lib/share.ts', 'the WhatsApp order text is read by the supplier'],
  ['lib/orderImage.ts', 'the order image is sent to the supplier'],
  ['components/QuickCreateProduct.tsx', 'nameKey(product.name) decides whether this is a duplicate'],
  ['pages/Onboarding.tsx', 'the import indexes the catalogue by nameKey(product.name)'],
  ['pages/SupplierLog.tsx', 'the log says what the record said'],
];

/**
 * ONE MATCHING SURFACE READS THE COLUMN, AND THE RULE IS NARROWER THAN THE OLD BAN, NOT WEAKER.
 *
 * The rule this file states is that a name WE COMPOSED must never replace the name a supplier
 * wrote. `PL-04`..`PL-12` of the 2026-09-04 sweep found the cost of stating it as "the identifier
 * `display_name` may not appear here": `/products` and `/prices` both DISPLAY the canonical name
 * once a person has approved one, so it is the name a manager copies into a price sheet — and the
 * sheet importer, indexing the catalogue by the stored name alone, offered that row as a new
 * product. Ticking the box would have created a second product for the item the approval queue
 * exists to stop duplicating.
 *
 * So `PriceListUpload.tsx` reads the column as a SECOND KEY. The distinction the assertions below
 * hold is the one that matters:
 *
 *   - the helper stays banned, import and call, because substituting a composed label for the raw
 *     name is still the hazard;
 *   - the raw index is still built from `nameKey(product.name)` and is still consulted first, so
 *     no row that resolved before can start resolving to a different product.
 *
 * The behaviour behind the second clause is asserted where behaviour belongs — a fixture in
 * `pages/priceListSheetMatching.spec.tsx` holds a product whose RAW name is the CANONICAL name of
 * another, and the sheet row must still resolve to the raw one.
 */
const LABEL_BANNED_COLUMN_IS_A_SECOND_KEY = 'components/PriceListUpload.tsx';

/**
 * `ProductNameReview.tsx` is the one file that both handles `display_name` and must never render
 * a product through the helper: its entire job is to show the RAW name beside a proposal, so a
 * person can judge one against the other. Labelling the row it is asking about with the name it is
 * asking about would make the screen agree with itself and answer nothing.
 */
const HANDLES_THE_COLUMN_BUT_NOT_THE_LABEL = 'pages/ProductNameReview.tsx';

/**
 * USING the helper is what is banned, not NAMING it. Several of the files below carry a docblock
 * explaining why they read the raw name, and those docblocks have to be allowed to say which
 * helper they are declining — a rule that forbids its own explanation gets deleted by whoever
 * next writes a comment. So: no import of it, and no call to it.
 */
const IMPORTS_IT = /import[^;]*\{[^}]*\bproductLabel\b[^}]*\}[^;]*from/;
const CALLS_IT = /\bproductLabel\s*\(/;

describe('the display-only rule', () => {
  // `process.cwd()`, the idiom productDisplayName.spec.ts and noteProse.spec.ts already use.
  // Deriving the root from `import.meta.url` does not survive this repository's Hebrew directory
  // name; a guard pointed at a path that does not exist passes forever.
  const srcRoot = join(process.cwd(), 'src');
  const read = (relative: string) => readFileSync(join(srcRoot, relative), 'utf8');

  it.each(NEITHER_LABEL_NOR_COLUMN)('%s reads the raw name — %s', (relative) => {
    const source = read(relative);
    expect(source).not.toMatch(IMPORTS_IT);
    expect(source).not.toMatch(CALLS_IT);
    expect(source).not.toMatch(/\bdisplay_name\b/);
  });

  it('the sheet importer reads the column as a second key and never as a label', () => {
    const source = read(LABEL_BANNED_COLUMN_IS_A_SECOND_KEY);
    expect(source).not.toMatch(IMPORTS_IT);
    expect(source).not.toMatch(CALLS_IT);
    // The raw name is still the index a sheet row is matched against first. If this disappears the
    // exemption above has lost the very thing that made it narrow.
    expect(source).toMatch(/nameKey\(product\.name\)/);
    expect(source).toMatch(/\bdisplay_name\b/);
  });

  it('the proposal screen handles the column but never labels a row with it', () => {
    const source = read(HANDLES_THE_COLUMN_BUT_NOT_THE_LABEL);
    expect(source).not.toMatch(IMPORTS_IT);
    expect(source).not.toMatch(CALLS_IT);
    // If this stops being true the file above is no longer the approval surface, and its exemption
    // from the ban next door has lost its reason.
    expect(source).toMatch(/\bdisplay_name\b/);
  });

  it('is actually looking at a helper that exists and is used', () => {
    // A ban is only worth having while there is something to ban. If nothing imports the helper,
    // the switch this whole stage performed has been reverted and these tests are guarding air.
    const users = ['pages/Products.tsx', 'pages/Orders.tsx', 'pages/PriceLists.tsx'];
    for (const file of users) expect(read(file)).toMatch(CALLS_IT);
  });

  it('every file named by the rule exists', () => {
    // A ban on a file that was renamed or deleted is a hole with nothing behind it: it keeps
    // passing while the code it was protecting has moved somewhere unprotected.
    for (const [relative] of NEITHER_LABEL_NOR_COLUMN) {
      expect(existsSync(join(srcRoot, relative))).toBe(true);
    }
    expect(existsSync(join(srcRoot, HANDLES_THE_COLUMN_BUT_NOT_THE_LABEL))).toBe(true);
    expect(existsSync(join(srcRoot, LABEL_BANNED_COLUMN_IS_A_SECOND_KEY))).toBe(true);
  });
});
