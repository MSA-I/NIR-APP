import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_ROUTE_DESCRIPTIONS,
  DYNAMIC_ROUTE_TITLES,
  routeBackPresentation,
  routePresentationDescription,
  routePresentationTitle,
  STATIC_ROUTE_DESCRIPTIONS,
  STATIC_ROUTE_TITLES,
} from './routePresentation';
import { he } from './i18n/dictionaries/he';

/**
 * The words a key stands for.
 *
 * The catalogue holds keys now, so every expectation below could have been rewritten to compare
 * key against key — and would then pass whatever the dictionary said. Resolving through `he`
 * keeps each one naming the exact sentence a Hebrew reader sees, which is what these tests were
 * written to pin.
 */
const say = (key: string | null) => (key === null ? null : (he.nav as Record<string, string>)[key.replace(/^nav./, '')]);

const DYNAMIC_ROUTES = [
  ['/finance/suppliers/supplier-1', 'כרטיס ספק פיננסי'],
  ['/suppliers/supplier-1', 'כרטיס ספק'],
  ['/orders/order-1', 'פרטי הזמנה'],
  ['/receiving/order-1', 'קבלת סחורה'],
  ['/receipts/receipt-1', 'פרטי קבלה'],
  ['/invoices/invoice-1', 'פרטי חשבונית'],
  ['/documents/document-1/review', 'בדיקת מסמך'],
] as const;

describe('קטלוג שמות מסכים', () => {
  it.each(Object.entries(STATIC_ROUTE_TITLES))('%s מקבל שם קנוני', (path, title) => {
    expect(routePresentationTitle(path)).toBe(title);
    expect(say(title)).toBeTruthy();
  });

  it.each(DYNAMIC_ROUTES)('%s מקבל שם קנוני', (path, title) => {
    expect(say(routePresentationTitle(path))).toBe(title);
  });

  it('מכסה את שני מסלולי ההקשר שלא הופיעו בניווט', () => {
    expect(say(routePresentationTitle('/reports/products'))).toBe('סיכום רכישות מוצרים');
    expect(say(routePresentationTitle('/finance/suppliers/supplier-1'))).toBe('כרטיס ספק פיננסי');
  });

  it('אינו ממציא שם למסלול לא מוכר', () => {
    expect(routePresentationTitle('/not-a-real-route')).toBeNull();
  });

  it.each([
    ['/orders/new', '/orders', 'חזרה להזמנות רכש'],
    ['/orders/order-1', '/orders', 'חזרה להזמנות רכש'],
    ['/invoices/new', '/invoices', 'חזרה לחשבוניות'],
    ['/invoices/invoice-1', '/invoices', 'חזרה לחשבוניות'],
    ['/receiving/order-1', '/receiving', 'חזרה לקבלת סחורה'],
    ['/receipts/receipt-1', '/receiving', 'חזרה לקבלת סחורה'],
    ['/documents/document-1/review', '/documents', 'חזרה למסמכים'],
  ])('%s מקבל יעד אב קבוע', (path, to, label) => {
    const back = routeBackPresentation(path);
    expect(back?.to).toBe(to);
    expect(say(back?.label ?? null)).toBe(label);
  });

  it('אינו מציג חזרה במסך רשימה ראשי', () => {
    expect(routeBackPresentation('/invoices')).toBeNull();
  });
});

describe('קטלוג תיאורי מסכים', () => {
  it.each(Object.keys(STATIC_ROUTE_TITLES))('%s מקבל תיאור שאינו חזרה על השם', (path) => {
    const description = routePresentationDescription(path);
    expect(description).toBeTruthy();
    expect(description?.trim()).not.toBe('');
    expect(description).not.toBe(routePresentationTitle(path));
  });

  it.each(DYNAMIC_ROUTES)('%s מקבל תיאור שאינו חזרה על השם', (path, title) => {
    const description = routePresentationDescription(path);
    expect(description).toBeTruthy();
    expect(description).not.toBe(title);
  });

  it('לכל תבנית דינמית של שם יש תבנית תיאור מקבילה', () => {
    expect(DYNAMIC_ROUTE_DESCRIPTIONS.map(([pattern]) => pattern.source))
      .toEqual(DYNAMIC_ROUTE_TITLES.map(([pattern]) => pattern.source));
  });

  it('שני הקטלוגים הסטטיים מכסים בדיוק את אותם מסלולים', () => {
    expect(Object.keys(STATIC_ROUTE_DESCRIPTIONS).sort()).toEqual(Object.keys(STATIC_ROUTE_TITLES).sort());
  });

  it('אינו ממציא תיאור למסלול לא מוכר', () => {
    expect(routePresentationDescription('/not-a-real-route')).toBeNull();
  });
});
