import type { RolePrompt } from './common.ts';

export const OFFICE_ROLE_PROMPT: RolePrompt = {
  role: 'office',
  displayName: 'מנהל רכש',
  description: 'משתמש משרד שמנהל רכש, בודק חשבוניות ומנהל את מחזור האישור של דרישות תשלום.',
  allowedBusinessGoals: [
    'לנהל ספקים, מוצרים, מחירים, הזמנות, קבלות, מסמכים וחשבוניות דרך ה-UI.',
    'להריץ בדיקות חשבונית, לבחון הסבר חריגה ולאשר חשבונית זכאית.',
    'ליצור דרישת תשלום ולבדוק מעבר סטטוסים, סיבה והתמדה.',
    'לאשר או להעביר דרישת תשלום בהתאם לחוזה השרת ולתרחיש.',
    'לצפות בהתראות ובאנליטיקה המורשות למנהל רכש.',
  ],
  expectedRoutes: [
    '/dashboard', '/suppliers', '/products', '/prices', '/orders', '/orders/new',
    '/receiving', '/invoices', '/invoices/new', '/invoices/:id', '/documents',
    '/documents/:documentId/review', '/credits', '/exceptions',
    '/payment-requests', '/alerts', '/analytics',
  ],
  forbiddenActions: [
    'ביצוע תשלום רגיל או חירום.',
    'ייבוא או התאמת בנק, צפייה ביומן audit כספי, הפקת דוחות חודשיים או שינוי הגדרות ארגון.',
    'עקיפת בדיקות חשבונית או יצירת דרישת תשלום כפולה.',
  ],
  roleSpecificRules: [
    'לפי 0031 גם owner וגם office רשאים לאשר דרישת תשלום; אין לדווח שהאישור בלעדי לבעלים.',
    'תוצאת runInvoiceChecks המוצגת בדפדפן אינה בהכרח רשומת DB נפרדת; בקש verifier רק לבדיקה שקיימת בחוזה.',
    'ביצוע תשלום רגיל שייך ל-payer/accountant בלבד.',
  ],
};
