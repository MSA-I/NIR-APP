import { describe, expect, it } from 'vitest';
import { routeBackPresentation, routePresentationTitle, STATIC_ROUTE_TITLES } from './routePresentation';

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
  });

  it.each(DYNAMIC_ROUTES)('%s מקבל שם קנוני', (path, title) => {
    expect(routePresentationTitle(path)).toBe(title);
  });

  it('מכסה את שני מסלולי ההקשר שלא הופיעו בניווט', () => {
    expect(routePresentationTitle('/reports/products')).toBe('סיכום רכישות מוצרים');
    expect(routePresentationTitle('/finance/suppliers/supplier-1')).toBe('כרטיס ספק פיננסי');
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
    expect(routeBackPresentation(path)).toEqual({ to, label });
  });

  it('אינו מציג חזרה במסך רשימה ראשי', () => {
    expect(routeBackPresentation('/invoices')).toBeNull();
  });
});
