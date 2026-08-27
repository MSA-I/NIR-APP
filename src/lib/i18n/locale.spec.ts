import { describe, expect, it } from 'vitest';
import { BASE_LOCALE, INTL_LOCALE, LOCALES, dirFor, resolveLocale } from './locale';

describe('resolveLocale', () => {
  it('prefers an explicit stored choice over everything else', () => {
    expect(resolveLocale({ stored: 'en', query: '?lang=he', browser: 'he-IL' })).toBe('en');
    expect(resolveLocale({ stored: 'he', query: '?lang=en', browser: 'en-US' })).toBe('he');
  });

  it('falls back to the query parameter when nothing is stored', () => {
    expect(resolveLocale({ stored: null, query: '?lang=en', browser: 'he-IL' })).toBe('en');
  });

  it('detects from the browser when nothing was chosen or requested', () => {
    expect(resolveLocale({ stored: null, query: '', browser: 'en-GB' })).toBe('en');
    expect(resolveLocale({ stored: null, query: '', browser: 'en' })).toBe('en');
    expect(resolveLocale({ stored: null, query: '', browser: 'EN-US' })).toBe('en');
  });

  it('defaults to Hebrew for any language that is not English', () => {
    expect(resolveLocale({ stored: null, query: '', browser: 'fr-FR' })).toBe('he');
    expect(resolveLocale({ stored: null, query: '', browser: 'he-IL' })).toBe('he');
    expect(resolveLocale({ stored: null, query: '', browser: '' })).toBe('he');
  });

  it('ignores a stored or requested value that is not a supported locale', () => {
    expect(resolveLocale({ stored: 'de', query: '', browser: 'en-US' })).toBe('en');
    expect(resolveLocale({ stored: '', query: '', browser: 'en-US' })).toBe('en');
    expect(resolveLocale({ stored: null, query: '?lang=de', browser: 'he-IL' })).toBe('he');
  });

  it('maps direction and Intl tags without a second source of truth', () => {
    expect(LOCALES).toEqual(['he', 'en']);
    expect(BASE_LOCALE).toBe('he');
    expect(dirFor('he')).toBe('rtl');
    expect(dirFor('en')).toBe('ltr');
    expect(INTL_LOCALE).toEqual({ he: 'he-IL', en: 'en-US' });
  });
});
