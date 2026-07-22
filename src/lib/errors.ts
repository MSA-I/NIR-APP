/**
 * Hebrew-facing error text.
 *
 * supabase-js returns `{ data, error }` and never throws, so a failed write reaches the user
 * either as nothing at all or as a raw Postgres string. This maps the messages the app can
 * actually produce onto sentences a business owner can act on, and keeps the original in the
 * console so a developer still sees what really happened.
 *
 * ponytail: a flat pattern list, not an error-code taxonomy. Postgres does not give
 * supabase-js a stable code on every path, and the strings below are the ones this schema
 * can raise.
 */

const PATTERNS: [RegExp, string][] = [
  [/payment_request_not_executable/i,
    'דרישת התשלום אינה במצב שמאפשר ביצוע. רענן את המסך ובדוק את הסטטוס.'],
  [/payment_execution_fields_required/i,
    'יש להשלים תאריך, אסמכתה וסיבת ביצוע.'],
  [/payment_execution_conflict|payment_request_idempotency_conflict|invoice_idempotency_conflict|receipt_idempotency_conflict|bank_payment_idempotency_conflict|credit_request_idempotency_conflict/i,
    'אותה פעולה כבר נשלחה עם פרטים אחרים. רענן את המסך לפני ניסיון נוסף.'],
  [/allocation_exceeds_balance|payment_request_allocation_invalid/i,
    'הסכום שהוקצה גבוה מהיתרה הפתוחה. רענן את הנתונים ועדכן את החלוקה.'],
  [/allocation_total_mismatch|bank_allocation_total_mismatch/i,
    'סכום החלוקה אינו תואם לסכום הפעולה.'],
  [/allocation_target_invalid|allocation_invalid/i,
    'אחת מהקצאות התשלום אינה תקינה או אינה שייכת לספק הנבחר.'],
  [/payment_request_checks_failed/i,
    'בדיקות השרת מצאו חשבונית ששולמה או יתרה שהשתנתה. רענן ובדוק את הדרישה.'],
  [/payment_request_transition_invalid/i,
    'לא ניתן להעביר את דרישת התשלום לסטטוס שנבחר מהמצב הנוכחי.'],
  [/payment_request_unknown/i,
    'דרישת התשלום אינה זמינה עוד. רענן את המסך.'],
  [/payment_request_supplier_invalid|payment_request_invalid/i,
    'פרטי דרישת התשלום אינם תקינים.'],
  [/bank_transaction_already_matched|payment_already_bank_matched/i,
    'התנועה או התשלום כבר הותאמו. רענן את המסך כדי לראות את ההתאמה.'],
  [/bank_transaction_not_matchable|bank_transaction_not_ignorable/i,
    'מצב תנועת הבנק השתנה ואינו מאפשר את הפעולה.'],
  [/bank_transaction_unknown/i,
    'תנועת הבנק אינה זמינה עוד.'],
  [/bank_payment_invalid|bank_supplier_invalid|bank_match_invalid/i,
    'התשלום, הספק או פרטי ההתאמה אינם תואמים לתנועת הבנק.'],
  [/bank_row_replayed/i,
    'הייבוא בוטל: לפחות אחת מתנועות הבנק כבר קיימת במערכת.'],
  [/bank_import_invalid_rows|bank_import_invalid/i,
    'הייבוא בוטל: הקובץ כולל שורה לא תקינה או פרטי קובץ חסרים.'],
  [/receipt_qty_exceeds_order/i,
    'כמות בקבלה אינה תואמת לכמות שנותרה בהזמנה. רענן ובדוק את השורות.'],
  [/receipt_already_completed|receipt_draft_conflict/i,
    'לקבלה זו כבר קיימת השלמה או טיוטה אחרת. רענן את המסך.'],
  [/purchase_order_not_receivable/i,
    'ההזמנה אינה במצב שמאפשר קבלת סחורה.'],
  [/purchase_order_unknown|goods_receipt_invalid/i,
    'ההזמנה או הקבלה אינן זמינות עוד.'],
  [/invoice_amounts_invalid/i,
    'סכומי החשבונית אינם תקינים או שסכום הביניים והמע״מ אינם שווים לסכום הכולל.'],
  [/invoice_order_invalid|invoice_receipt_invalid|invoice_supplier_invalid/i,
    'הספק, ההזמנה או הקבלה המקושרים אינם תואמים לחשבונית.'],
  [/invoice_review_transition_invalid/i,
    'לא ניתן להעביר את החשבונית לסטטוס שנבחר מהמצב הנוכחי.'],
  [/invoice_not_found/i,
    'החשבונית אינה זמינה עוד.'],
  [/invoice_fields_required|invoice_review_fields_required/i,
    'חסרים פרטים הנדרשים לשמירת החשבונית.'],
  [/credit_request_transition_invalid/i,
    'לא ניתן להעביר את הזיכוי לסטטוס שנבחר מהמצב הנוכחי.'],
  [/credit_request_invoice_unknown|credit_request_unknown/i,
    'הזיכוי או החשבונית המקושרת אינם זמינים עוד. רענן את המסך.'],
  [/credit_request_amount_invalid|credit_request_fields_required|credit_request_transition_fields_required/i,
    'חסרים פרטים או שסכום הזיכוי אינו תקין.'],
  [/price_import_target_invalid/i,
    'הייבוא בוטל: ספק או מוצר אינם זמינים או אינם שייכים לחשבון הזה.'],
  [/price_import_invalid/i,
    'הייבוא בוטל: קיימת שורה כפולה או מחיר שאינו בטווח המותר.'],
  [/price_values_invalid/i,
    'המחיר, התאריך או הזמינות אינם תקינים.'],
  [/supplier_product_not_found/i,
    'שורת המחיר אינה זמינה עוד. רענן את המחירון.'],
  [/month_export_legacy_snapshot_missing/i,
    'הדוח ההיסטורי סומן בעבר ללא צילום מצב. נדרשת בדיקה ידנית לפני ניסיון נוסף.'],
  [/month_export_snapshot_conflict/i,
    'החודש כבר סומן עם רשימת חשבוניות אחרת ולא יורחב בשקט.'],
  [/month_export_invoice_invalid|month_export_duplicate_invoice|month_export_invalid/i,
    'רשימת החשבוניות או החודש אינם תקינים לדוח שנבחר.'],
  [/financial_command_rpc_required/i,
    'הנתונים השתנו דרך מסלול ישן שנחסם. רענן את האפליקציה ונסה שוב.'],
  [/invoice_create_not_authorized|invoice_review_not_authorized|credit_request_create_not_authorized|credit_request_transition_not_authorized|price_write_not_authorized|price_import_not_authorized|month_export_not_authorized|not_authorized/i,
    'אין לך הרשאה לבצע את הפעולה הזו.'],
  [/draft_unknown/i,
    'הטיוטה אינה זמינה עוד. ייתכן שבוטלה או אושרה בחלון אחר.'],
  [/draft_invalid_supplier_selection|draft_supplier_unavailable/i,
    'אחד הספקים שנבחרו אינו זמין עוד. יש לבחור ספק מחדש.'],
  [/draft_price_changed/i,
    'המחירים השתנו. הסיכום רוענן ויש לעבור עליו ולאשר שוב.'],
  [/document_already_filed/i,
    'המסמך כבר שויך ליעד עסקי.'],
  [/document_target_unknown/i,
    'יעד התיוק אינו זמין עוד. יש לבחור יעד אחר.'],
  [/reason_required/i,
    'יש להזין סיבה לביצוע הפעולה.'],
  [/row-level security|permission denied|insufficient privilege/i,
    'אין לך הרשאה לבצע את הפעולה הזו.'],
  [/duplicate key value|already exists/i,
    'הרשומה כבר קיימת במערכת.'],
  [/violates foreign key constraint/i,
    'לא ניתן להשלים את הפעולה — קיימות רשומות אחרות שמקושרות לרשומה זו.'],
  [/null value in column .* violates not-null/i,
    'חסר שדה חובה.'],
  [/violates check constraint/i,
    'אחד הערכים שהוזנו אינו תקין.'],
  [/JWT expired|Invalid Refresh Token|refresh_token_not_found/i,
    'פג תוקף החיבור. יש להתחבר מחדש.'],
  [/Invalid login credentials/i,
    'אימייל או סיסמה שגויים.'],
  [/Email not confirmed/i,
    'כתובת המייל טרם אומתה.'],
  [/already registered/i,
    'כתובת המייל כבר רשומה במערכת.'],
  [/Failed to fetch|NetworkError|ERR_NETWORK|fetch failed/i,
    'אין חיבור לשרת. בדוק את החיבור לאינטרנט ונסה שוב.'],
  [/timeout|timed out/i,
    'הפעולה ארכה זמן רב מדי. נסה שוב.'],
  [/payload too large|exceeded the maximum allowed size/i,
    'הקובץ גדול מדי.'],
];

const FALLBACK = 'הפעולה נכשלה. אם הבעיה חוזרת — פנה לתמיכה.';

/** Turns any thrown value or Supabase error message into Hebrew. */
export function toHebrewError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
  // The original is what a developer needs; the return value is what the user reads.
  if (raw) console.error('[supplyflow]', raw);
  for (const [re, text] of PATTERNS) if (re.test(raw)) return text;
  return FALLBACK;
}

/**
 * Reads a supabase-js result and throws on failure.
 *
 * The reason this exists: `await supabase.from(x).insert(y)` resolves successfully even when
 * the insert was rejected, so `try/catch` around it catches nothing and the next line happily
 * reports success. Every write should pass through here.
 */
export function ok<T extends { error: { message: string } | null }>(res: T): T {
  if (res.error) throw new Error(res.error.message);
  return res;
}
