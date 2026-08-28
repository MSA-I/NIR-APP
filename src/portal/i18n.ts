import { BUSINESS_TIME_ZONE, formatUnit } from '../lib/format';

export type PortalLocale = 'he' | 'en';

export const PORTAL_COPY = {
  he: {
    pageTitle: 'אישור הזמנת רכש',
    switchLanguage: 'English',
    switchLanguageLabel: 'מעבר לאנגלית',
    loading: 'טוען את פרטי ההזמנה…',
    invalidTitle: 'הקישור אינו פעיל',
    invalidBody: 'הקישור פג תוקף, בוטל או שגוי. יש לפנות לעסק שממנו התקבלה ההזמנה כדי לקבל קישור חדש.',
    lockedTitle: 'הקישור ננעל זמנית',
    lockedBody: 'נרשמו יותר מדי ניסיונות. יש לנסות שוב מאוחר יותר.',
    errorTitle: 'שגיאה זמנית',
    errorBody: 'לא ניתן לטעון את ההזמנה כרגע. יש לנסות שוב בעוד כמה דקות.',
    sentNow: 'התשובה נשלחה בהצלחה',
    alreadySent: 'כבר נשלחה תשובה להזמנה זו',
    approvedAsSent: 'ההזמנה אושרה כפי שנשלחה.',
    proposalStatus: {
      submitted: 'ההצעה התקבלה וממתינה להחלטת העסק',
      accepted: 'ההצעה אושרה על ידי העסק',
      partially_accepted: 'ההצעה אושרה חלקית על ידי העסק',
      rejected: 'ההצעה נדחתה על ידי העסק',
    },
    proposedMoneyDelta: 'הפרש כספי מוצע:',
    deliveryDateLabel: 'הצעה לתאריך אספקה אחר (לא חובה)',
    noteLabel: 'הערה כללית לעסק (לא חובה)',
    totalDelta: 'סה״כ הפרש כספי מוצע:',
    sending: 'שולח…',
    sendChanges: 'שליחת השינויים המוצעים',
    approveAsSent: 'אישור ההזמנה כפי שנשלחה',
    oneResponse: 'ניתן לשלוח תשובה אחת בלבד. לאחר השליחה העסק יבחן את התשובה ויחליט.',
    order: 'הזמנה',
    revision: 'גרסה',
    validUntil: 'בתוקף עד',
    addressee: 'לכבוד:',
    requestedDelivery: 'תאריך אספקה מבוקש:',
    orderLines: 'שורות ההזמנה',
    proposedQty: 'כמות מוצעת',
    proposedUnitPrice: 'מחיר יחידה מוצע',
    unavailable: 'הפריט אינו זמין',
    replacement: 'הצעת תחליף (טקסט חופשי, לא חובה)',
    lineDelta: 'הפרש לשורה:',
    submitAlready: 'כבר נשלחה תשובה להזמנה זו.',
    submitInvalid: 'התשובה לא התקבלה. יש לבדוק את הערכים שהוזנו ולנסות שוב.',
    submitRateLimited: 'נרשמו יותר מדי ניסיונות. יש להמתין ולנסות שוב.',
    submitTemporary: 'שגיאה זמנית בשליחה. יש לנסות שוב בעוד כמה דקות.',
  },
  en: {
    pageTitle: 'Purchase order response',
    switchLanguage: 'עברית',
    switchLanguageLabel: 'Switch to Hebrew',
    loading: 'Loading the purchase order…',
    invalidTitle: 'This link is not active',
    invalidBody: 'The link is invalid, expired, or revoked. Contact the business that sent the order for a new link.',
    lockedTitle: 'This link is temporarily locked',
    lockedBody: 'Too many attempts were recorded. Please try again later.',
    errorTitle: 'Temporary error',
    errorBody: 'The purchase order cannot be loaded right now. Please try again in a few minutes.',
    sentNow: 'Your response was sent successfully',
    alreadySent: 'A response has already been sent for this order',
    approvedAsSent: 'The order was approved as sent.',
    proposalStatus: {
      submitted: 'The proposal was received and is waiting for the business to review it',
      accepted: 'The proposal was accepted by the business',
      partially_accepted: 'The proposal was partially accepted by the business',
      rejected: 'The proposal was rejected by the business',
    },
    proposedMoneyDelta: 'Proposed amount difference:',
    deliveryDateLabel: 'Propose a different delivery date (optional)',
    noteLabel: 'General note to the business (optional)',
    totalDelta: 'Total proposed amount difference:',
    sending: 'Sending…',
    sendChanges: 'Send proposed changes',
    approveAsSent: 'Approve the order as sent',
    oneResponse: 'Only one response can be sent. The business will review it after submission.',
    order: 'Order',
    revision: 'Revision',
    validUntil: 'Valid until',
    addressee: 'For:',
    requestedDelivery: 'Requested delivery date:',
    orderLines: 'Order lines',
    proposedQty: 'Proposed quantity',
    proposedUnitPrice: 'Proposed unit price',
    unavailable: 'This item is unavailable',
    replacement: 'Replacement suggestion (free text, optional)',
    lineDelta: 'Line difference:',
    submitAlready: 'A response has already been sent for this order.',
    submitInvalid: 'The response was not accepted. Check the values and try again.',
    submitRateLimited: 'Too many attempts were recorded. Please wait and try again.',
    submitTemporary: 'Temporary sending error. Please try again in a few minutes.',
  },
} as const;

const INTL_LOCALE: Record<PortalLocale, string> = { he: 'he-IL', en: 'en-US' };

export function portalLocaleFromLocation(search: string, browserLanguage: string): PortalLocale {
  const requested = new URLSearchParams(search).get('lang')?.toLowerCase();
  if (requested === 'he' || requested === 'en') return requested;
  return browserLanguage.toLowerCase().startsWith('en') ? 'en' : 'he';
}

export function formatPortalDate(locale: PortalLocale, value: string | Date | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    day: '2-digit', month: '2-digit', year: 'numeric', timeZone: BUSINESS_TIME_ZONE,
  }).format(new Date(value));
}

export function formatPortalMoney(locale: PortalLocale, value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: 'currency', currency: 'ILS', minimumFractionDigits: 2,
  }).format(value);
}

export function formatPortalQuantity(
  locale: PortalLocale,
  quantity: number | null | undefined,
  unit: string | null | undefined,
): string {
  if (quantity == null) return '—';
  const amount = new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 2 }).format(quantity);
  const label = formatUnit(unit, locale, quantity);
  return `${amount}${label ? ` ${label}` : ''}`;
}
