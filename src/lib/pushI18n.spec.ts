import { describe, expect, it } from 'vitest';
import { translateIn } from './i18n/LocaleProvider';
import { subscribePush } from './push';

describe('push failure language boundary', () => {
  it('returns a typed reason that the reader resolves in the current locale', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'Notification');
    Reflect.deleteProperty(window, 'Notification');

    try {
      const key = await subscribePush();

      expect(key).toBe('push.unsupported');
      expect(key && translateIn('he', key)).toBe('הדפדפן הזה אינו תומך בהתראות דחיפה');
      expect(key && translateIn('en', key)).toBe('This browser does not support push notifications');
    } finally {
      if (descriptor) Object.defineProperty(window, 'Notification', descriptor);
    }
  });
});
