// The reader's language, inside the Edge function.
//
// WHY THE FUNCTION NEEDS ONE AT ALL. Three things this function produces are read by a PERSON,
// not only by the model: the warnings on a tool envelope, a source's screen label, and the help
// steps themselves. Until now all three were Hebrew, because the product was. An English speaker
// asking an English question got English steps only when the model happened to guess `en`, and a
// Hebrew scope-limit sentence underneath them either way (`OPEN-DECISIONS #283`).
//
// WHY IT COMES FROM THE REQUEST BODY, next to a file whose rule is "identity from the server,
// never from the request body". A reading language is not identity and grants nothing: both
// locales of the help registry are `public_product_metadata`, available to the same roles, so a
// caller who lied about their locale would receive a screen they were already entitled to, in a
// language they chose. Nothing here reads tenant data by locale and nothing branches on it for
// authorization. Reading it from `profiles.locale` instead would cost an extra round trip per run
// to answer a question the caller already knows the answer to.
//
// The dictionaries are imported whole rather than a handful of sentences being copied here. One
// wording per language, in one place, is the rule the extraction exists to establish; a second
// copy inside an Edge function is exactly the drift `open-alerts.ts` was already carrying.
import { en } from "../../../src/lib/i18n/dictionaries/en.ts";
import { he } from "../../../src/lib/i18n/dictionaries/he.ts";
import type { Dictionary } from "../../../src/lib/i18n/dictionaries/he.ts";
import { translate, type TKey } from "../../../src/lib/i18n/t.ts";
import {
  PRODUCT_HELP_LOCALES,
  type ProductHelpLocale,
} from "../../../src/lib/assistant/contracts.ts";

/**
 * The reader's language for one run. Deliberately the SAME closed set as the help registry's:
 * a locale the registry has no rows for is a locale this product cannot answer in, and having
 * two lists that could disagree is the shape of the bug rather than a safeguard against it.
 */
export type ReaderLocale = ProductHelpLocale;
export const READER_LOCALES = PRODUCT_HELP_LOCALES;

const DICTIONARIES: Record<ReaderLocale, Dictionary> = {
  he: he as unknown as Dictionary,
  en: en as unknown as Dictionary,
};

/** One sentence, in the reader's language. A miss returns the key, exactly as the browser does. */
export function readerText(
  locale: ReaderLocale,
  key: TKey,
  vars?: Record<string, string | number>,
): string {
  return translate(DICTIONARIES[locale], key, vars);
}

/**
 * The one line of the system prompt that changes with the reader.
 *
 * Named here rather than inlined in `buildInstructions` so the answer language and the tool data's
 * language cannot drift apart: both resolve from this module, from the same value, in one run.
 */
export const ANSWER_LANGUAGE: Record<ReaderLocale, string> = {
  he: "Hebrew",
  en: "English",
};

/**
 * The prompt's worked examples of describing a scope in words instead of digits.
 *
 * They were Hebrew for every reader, inside an instruction that also says "answer in English".
 * A worked example is the strongest instruction in a prompt, so an English run was being shown two
 * Hebrew phrases as the model of what to write - which is not a weaker answer but a Hebrew one, on
 * the exact screen the owner said must not contain a single Hebrew word. They live here, beside
 * `ANSWER_LANGUAGE`, for the same reason it does: the answer language and everything that steers
 * the answer's wording resolve from one module, from one value, in one run.
 *
 * Prompt guidance, deliberately NOT dictionary copy. Nobody reads these; the model does.
 */
export const SCOPE_PHRASE_EXAMPLES: Record<ReaderLocale, string> = {
  he: '"בשבוע האחרון", "בחודש האחרון"',
  en: '"in the last week", "in the last month"',
};
