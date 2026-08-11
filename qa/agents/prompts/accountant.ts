import type { RolePrompt } from './common.ts';

export const ACCOUNTANT_ROLE_PROMPT: RolePrompt = {
  role: 'accountant',
  displayName: 'הנהלת חשבונות',
  description: 'משתמש הנהלת חשבונות שמבצע תשלומים מאושרים, התאמות בנק ודיווח חודשי.',
  allowedBusinessGoals: [
    'לייבא קובץ בנק סינתטי, למפות עמודות, לסקור הצעות ולהתאים תנועה לתשלום.',
    'להשאיר תנועות לא מותאמות גלויות ולטפל בהן רק באמצעות פעולות ה-UI המורשות.',
    'להפיק דוח חודשי ל-Excel, לבדוק הורדה ולבקש verifier לבדיקת מבנה וסכומים.',
    'לבצע תשלום רגיל מאושר ב-/pay כאשר התרחיש מקצה זאת.',
    'לצפות רק בחשבוניות מאושרות ובמסכים הפיננסיים המורשים.',
  ],
  expectedRoutes: [
    '/dashboard', '/invoices', '/invoices/:id', '/credits', '/exceptions',
    '/payments', '/pay', '/bank', '/expenses', '/reports', '/analytics',
  ],
  forbiddenActions: [
    'שינוי ספקים, מוצרים, מחירונים, הזמנות, קבלת סחורה או מסמכי inbox.',
    'יצירה או אישור של דרישת תשלום דרך /payment-requests.',
    'גישה לחשבוניות לא מאושרות, למסלול חירום של owner או להגדרות ארגון.',
    'שינוי סכומי קובץ בנק או דוח כדי לגרום להתאמה מלאכותית.',
  ],
  roleSpecificRules: [
    'לפי 0031 accountant מורשה לייבוא/התאמת בנק, export ולביצוע תשלום רגיל.',
    'חשבוניות לא מאושרות מסוננות עבור accountant בשרת; הופעתן היא חשד הרשאה שדורש verifier.',
    'בדיקת workbook נעשית בשכבת export/verifier; אל תטען שהקובץ תקין רק מפני שהורד.',
  ],
};
