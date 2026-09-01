/**
 * The one source of truth for "which appearance is this session in", as a PURE value.
 *
 * The exact sibling of `i18n/locale.ts`, and it exists for the same reason: `types.ts` needs the
 * type (since `0283`, `profiles.theme` is a column) and `types.ts` must stay free of the DOM.
 *
 * WHY THIS FILE EXISTS AT ALL — it was carved out of `appearance.ts` on 01.09.2026 because CI
 * caught what the local typecheck could not. `types.ts` imported `Theme` from `appearance.ts`;
 * the assistant's Deno contract tests import `../types`; and Deno type-checks the whole module
 * graph with NO `lib: dom`. So `appearance.ts` — which legitimately touches `document`,
 * `HTMLMetaElement` and `requestAnimationFrame` — was dragged into a DOM-free checker and produced
 * ten errors about globals it is entitled to use. `npm run typecheck` passed the whole time,
 * because the app's tsconfig includes `lib: dom`: one type-checker's floor is another's ceiling.
 *
 * So the rule this file enforces by its own existence: **a type that `types.ts` needs cannot live
 * in a module that touches the browser.** The side effects stay in `appearance.ts`; the decision
 * lives here, where anything may import it.
 *
 * `THEME_STORAGE_KEY` deliberately does NOT move here. `check:appearance-scope` asserts that
 * `appearance.ts` is the only file in the tree that names the storage key, so that there is exactly
 * one reader and one writer of it; moving the constant would make that guard's claim false.
 */
export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/**
 * Light, and not "whatever the operating system says".
 *
 * The owner's ruling of 31.08.2026: a finance screen that changes appearance because the laptop
 * crossed into evening is a screen that changed without being asked. `prefers-color-scheme` is
 * therefore read NOWHERE in the product — the only thing that sets the theme is a person choosing,
 * or the value their profile already carries. The one exception is `public/favicon.svg`, which has
 * no scripting and cannot ask.
 */
export const DEFAULT_THEME: Theme = 'light';

export const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);
