import { BASE_LOCALE, INTL_LOCALE, type Locale } from './locale.ts';
import type { Dictionary } from './dictionaries/he.ts';

/**
 * Every legal key, as a union: `'common.save' | 'settings.languageTitle' | ...`.
 *
 * This is why the dictionary shape is capped at two levels. A typo is a compile error, renaming
 * a key surfaces every call site, and an autocomplete list of the real keys removes the main
 * reason people give up on extraction halfway and go back to hardcoding.
 */
// `& string` on both halves rather than only inside the template: Deno's stricter default lib
// admits a symbol key here, and `[keyof Dictionary]` then indexes by one. The narrowing is a
// no-op for Vite and the difference between compiling and not for the Edge function, which
// reads this file through the same shared-contract door `contracts.ts` already uses.
export type TKey = {
  [N in keyof Dictionary & string]: `${N}.${keyof Dictionary[N] & string}`;
}[keyof Dictionary & string];

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * ponytail: interpolation is `{name}` and nothing else — no ICU, no select, no formatters
 * inside the string. A message that needs a formatted number receives it ALREADY FORMATTED,
 * which keeps money and dates going through `src/lib/format.ts` where `check:money` can see
 * them. An ICU-style `{amount, number, currency}` would move a money decision into a
 * translation file, out of the guard's reach and into the hands of whoever edits the copy.
 *
 * A variable with no value left in `vars` keeps its placeholder rather than rendering `undefined`
 * or an empty gap: a visible `{count}` gets reported, a silent blank does not.
 */
export function translate(
  dict: Dictionary,
  key: TKey,
  vars?: Record<string, string | number>,
  locale: Locale = BASE_LOCALE,
): string {
  const raw = lookup(dict, pluralKey(dict, key, vars, locale));
  if (raw == null) return key; // the key itself, never an empty cell — a miss must be loud
  return vars ? raw.replace(PLACEHOLDER, (match, name) => String(vars[name] ?? match)) : raw;
}

/**
 * The singular sibling, when there is one and the count asks for it.
 *
 * `{count} suppliers` reads `1 suppliers` at one, and 72 keys in this dictionary were written that
 * way. The fix is NOT ICU — the note above rejects it, and for a reason that still holds: an ICU
 * plural puts a language rule inside a translation file. It is a second key, `<key>_one`, which the
 * `Dictionary` type then forces English to carry too, exactly like every other key.
 *
 * A key with no `_one` sibling is untouched, so this is additive: nothing changes for the 40 keys
 * whose count is a bare number in brackets, or for a sentence that reads correctly at one anyway.
 *
 * BINARY, and deliberately so. Hebrew has one/two/many/other and this handles only `one`, which
 * matches what the codebase already does at its three hand-rolled call sites
 * (`supplierGroupCard.itemOne`, `uiTail.recordOne`, `Invoices.countKey`). Hebrew's `two` falling to
 * the plural form is the behaviour those three already ship; making it four forms is a separate
 * decision about copy, not a mechanism this can settle on its own.
 */
function pluralKey(
  dict: Dictionary,
  key: TKey,
  vars: Record<string, string | number> | undefined,
  locale: Locale,
): TKey {
  const count = vars?.count;
  if (typeof count !== 'number') return key;
  if (pluralCategory(locale, count) !== 'one') return key;
  const singular = `${key}_one` as TKey;
  return lookup(dict, singular) == null ? key : singular;
}

/**
 * The escape hatch for keys only known at RUNTIME — a status enum, an audit action, a document
 * kind that arrives from the database. It returns `null` rather than the key so the caller can
 * fall back to the raw stored string, which is the rule `status.ts` already states: a reader
 * that met an unknown action must show the raw string rather than an empty cell.
 *
 * Deliberately NOT typed as `TKey`: the whole point is that the value is not known at compile
 * time. Callers pass `status.${row.status}` and handle the miss.
 */
export function tryTranslate(
  dict: Dictionary,
  key: string,
  vars?: Record<string, string | number>,
  locale: Locale = BASE_LOCALE,
): string | null {
  const raw = lookup(dict, pluralKey(dict, key as TKey, vars, locale));
  if (raw == null) return null;
  // Interpolation follows the same rule as `translate`: a variable with no value keeps its
  // placeholder. A runtime key is no less likely to carry one — the business summary's window
  // labels are reached only through this door, and without this they printed `{days}`.
  return vars ? raw.replace(PLACEHOLDER, (match, name) => String(vars[name] ?? match)) : raw;
}

function lookup(dict: Dictionary, key: string): string | undefined {
  const separator = key.indexOf('.');
  if (separator < 1) return undefined;
  const namespace = dict[key.slice(0, separator) as keyof Dictionary] as
    | Record<string, string>
    | undefined;
  return namespace?.[key.slice(separator + 1)];
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

/**
 * Hebrew has one/two/many/other and English has one/other. `Intl` knows both, so neither is
 * written down here — a hand-rolled `n === 1 ? a : b` is correct in English and wrong in Hebrew,
 * and that asymmetry is exactly the bug this exists to prevent.
 */
export function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(INTL_LOCALE[locale]);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}
