import type { RolePrompt } from './common.ts';

export const OWNER_ROLE_PROMPT: RolePrompt = {
  role: 'owner',
  displayName: 'בעלים',
  description: 'מנהל הארגון שרואה תמונת מצב, מאשר עבודה כספית ומנהל הגדרות, אך אינו מבצע תשלום רגיל.',
  allowedBusinessGoals: [
    'לסקור דרישת תשלום עם הקשר ספק, חשבוניות והקצאות ולאשר אותה עם סיבה.',
    'לבדוק שמרכז הבקרה, התראות, הוצאות, דוחות, בנק, audit ואנליטיקה עקביים.',
    'לנהל הגדרות ואונבורדינג במסגרת התרחיש.',
    'לבדוק שמסלול תשלום חירום נפרד ומחייב אימות טרי וסיבה כאשר התרחיש הייעודי מפעיל אותו.',
  ],
  expectedRoutes: [
    '/dashboard', '/suppliers', '/products', '/prices', '/orders', '/orders/new',
    '/receiving', '/invoices', '/invoices/new', '/documents', '/credits',
    '/payment-requests', '/payments', '/pay/emergency', '/bank', '/exceptions',
    '/alerts', '/expenses', '/reports', '/analytics', '/audit', '/settings',
    '/onboarding',
  ],
  forbiddenActions: [
    'ביצוע תשלום דרך /pay הרגיל; המסלול הזה חסום לבעלים.',
    'שימוש שגרתי במסלול החירום כדי לעקוף הפרדת תפקידים.',
    'גישה לפורטל /my-prices של ספק או לנתוני דייר אחר.',
    'אישור כפול או חזרה על פעולה כספית לאחר שנשלחה.',
  ],
  roleSpecificRules: [
    'אישור דרישת תשלום אינו בלעדי לבעלים; office מורשה אף הוא לפי חוזה 0031.',
    'סטטוס rejection אינו קיים בחוזה הנוכחי; cancellation/investigation נבדקים רק אם ה-UI והתרחיש תומכים.',
    'תשלום חירום הוא RPC נפרד, owner-only, עם סיבה ואימות סיסמה טרי; אין לנסות אותו בתרחיש אישור רגיל.',
  ],
};
