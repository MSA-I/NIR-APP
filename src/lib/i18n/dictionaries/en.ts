/**
 * The English dictionary. `: Dictionary` is the whole completeness guard — a key that exists in
 * `he.ts` and not here fails `npm run typecheck`, and so does a key here that exists nowhere.
 *
 * Two rules for the copy itself:
 *   - British-neutral, sentence case. This is a B2B control room, not a marketing page.
 *   - The language names stay in their own language: a person looking for Hebrew is looking for
 *     `עברית`, and `Hebrew` written in English is no help to someone who cannot read the screen.
 */
import type { Dictionary } from './he';

export const en: Dictionary = {
  common: {
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    search: 'Search',
  },

  settings: {
    languageTitle: 'Interface language',
    languageHint: 'The language follows your browser. A choice here overrides it and is saved to your account.',
    languageOptionHe: 'עברית',
    languageOptionEn: 'English',
    languageSaveFailed: 'The language changed on screen but was not saved to your account. Please try again later.',
  },
};
