/**
 * The BASE dictionary. Every key in the product is born here, in Hebrew, and `en.ts` must
 * cover all of them — `en: Dictionary` turns a missing or misspelled key into a `tsc` failure
 * rather than an `undefined` that reaches a screen. There is no runtime dictionary-diff script
 * because the compiler already is one.
 *
 * SHAPE: exactly two levels, `namespace.key`. Not a style preference — `TKey` in `../t.ts` is a
 * template-literal union over exactly this shape, and a third level would silently fall out of
 * the type and stop being checked. Status maps that would want a third level are flattened
 * instead: `status.invoice_approved`, never `status.invoice.approved`.
 *
 * NAMESPACES ARE SURFACES, not files. A string used by three components on the orders screen
 * lives in `orders` once, not three times under three component names.
 *
 * KEYS DESCRIBE ROLE, NOT CONTENT. `orders.emptyTitle`, never `orders.noOrdersYet` — content
 * gets reworded by a copy pass, role does not.
 */
export const he = {
  common: {
    save: 'שמירה',
    cancel: 'ביטול',
    close: 'סגירה',
    search: 'חיפוש',
  },

  settings: {
    languageTitle: 'שפת הממשק',
    languageHint: 'השפה נבחרת אוטומטית לפי הדפדפן. בחירה כאן גוברת עליה ונשמרת לחשבון שלך.',
    languageOptionHe: 'עברית',
    languageOptionEn: 'English',
    languageSaveFailed: 'השפה הוחלפה במסך אך לא נשמרה לחשבון. נסה שוב מאוחר יותר.',
  },
} as const;

/**
 * The contract `en.ts` must satisfy. Derived from the Hebrew object rather than declared
 * separately, so adding a Hebrew key immediately obliges an English one and there is no third
 * place to keep in sync.
 */
export type Dictionary = {
  [N in keyof typeof he]: { [K in keyof (typeof he)[N]]: string };
};
