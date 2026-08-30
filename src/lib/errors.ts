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

// Imported from the dependency-free half of the assistant contracts on purpose: this file is
// pulled in by most of the app, and `./assistant/contracts` carries Zod for its schemas.
import { ASSISTANT_ERROR_CODES, ASSISTANT_ERROR_MESSAGES } from './assistant/errorCodes';

/**
 * The payment-execution split, refused by name.
 *
 * `buildPaymentAllocations` (AccountantPaymentQueue) refuses these BEFORE the RPC is called, so
 * the accountant is stopped at the field rather than at the server. The screen shows the same
 * sentence inline next to the button it disables, and `toHebrewError` reads it too — one wording,
 * whether the refusal came from the browser's own arithmetic or arrived as a thrown message.
 *
 * Two of these names are the SERVER'S OWN — `credit_allocation_invoice_required` and
 * `payment_cash_amount_required` are raised by `execute_payment_request` too, so the client uses
 * the identical name and the accountant reads the identical sentence whichever side caught it.
 * The rest are client-only readings of conditions the server folds into its broader containment
 * refusals (`allocation_target_invalid`, `credit_allocation_supplier_mismatch`,
 * `allocation_invoice_coverage_mismatch`), mapped separately below.
 */
export const ALLOCATION_REFUSAL_MESSAGES: Record<string, string> = {
  credit_allocation_exceeds_remaining: 'סכום הקיזוז חורג מיתרת הזיכוי הזמינה',
  credit_allocation_exceeds_invoice: 'סכום הקיזוז חורג מסכום החשבונית שהזיכוי מקוזז מולה',
  // OPEN-DECISIONS #243/#244 as the owner settled them on 23.08.2026: an unlinked credit may be
  // offset against any invoice of the same supplier, and the link is recorded at the moment of
  // allocation. Which invoice it lands on is therefore a decision with a money consequence, and
  // the absence of a decision is a refusal — not a default.
  credit_allocation_invoice_required:
    'יש לבחור לאיזו חשבונית נזקף כל זיכוי שאינו משויך לחשבונית. המערכת לא תבחר עבורך — החשבונית שתיבחר היא זו שתקוזז',
  // Client-only, and the server agrees by a broader name: a linked credit simply cannot be moved,
  // and naming a different invoice for it is answered there with `allocation_target_invalid`.
  credit_invoice_link_immutable:
    'זיכוי שכבר משויך לחשבונית מקוזז מולה בלבד ואי אפשר להעבירו לחשבונית אחרת',
  credit_invoice_not_in_request: 'החשבונית שנבחרה לזיכוי אינה מחשבוניות דרישת התשלום הזו',
  payment_cash_amount_required:
    'חייב להישאר סכום להעברה בפועל — לא ניתן לכסות את מלוא הדרישה בזיכויים',
};

/**
 * The refusal a settings screen can resolve, worded for who is reading it (`#293`).
 *
 * `bank_match_tolerance_unconfigured` is the only currency refusal whose fix is a field. Sending
 * everyone to that field would be wrong: an office user cannot change organisation settings, and
 * a screen that tells them to would be handing them a door that is locked. So the destination is
 * chosen by capability, not by hope.
 */
export function toleranceRefusalMessage(canChangeSettings: boolean): string {
  return 'לא נקבעה סטיית סכום מותרת למטבע של התנועה, ולכן אי אפשר להשוות סכומים. '
    + (canChangeSettings
      ? 'אפשר לקבוע אותה במסך ההגדרות, בקטע "סטיות סכום מותרות".'
      : 'יש לפנות לבעל העסק כדי שיקבע אותה בהגדרות.');
}

const PATTERNS: [RegExp, string][] = [
  /* THE CURRENCY REFUSALS (0227, 0228, 0231, 0232 — #290 to #293).
     Four distinct server refusals reached the user as one sentence: "הפעולה נכשלה. אם הבעיה
     חוזרת — פנה לתמיכה." Support is the wrong destination for all four, and for one of them the
     fix is a field the owner can fill in under a minute — but only if somebody says so.

     The tolerance line here is the role-blind fallback for paths that do not know who is reading;
     a screen that knows uses `toleranceRefusalMessage` above and names the right destination. */
  [/bank_match_tolerance_unconfigured/i,
    'לא נקבעה סטיית סכום מותרת למטבע של התנועה, ולכן אי אפשר להשוות סכומים. '
    + 'יש לקבוע אותה בהגדרות לפני ההתאמה.'],
  [/bank_match_currency_mismatch/i,
    'התנועה והחשבונית אינן באותו מטבע. תנועה סוגרת חוב במטבע אחר רק דרך תשלום שרשם את שני הסכומים.'],
  [/payment_request_currency_mixed/i,
    'בקשת תשלום אחת יכולה לכלול חשבוניות במטבע אחד בלבד. יש לפצל לבקשה נפרדת לכל מטבע.'],
  [/invoice_currency_precision_invalid/i,
    'לסכום יש יותר ספרות אחרי הנקודה העשרונית ממה שהמטבע הזה מאפשר.'],
  // Assistant codes (contracts §8), generated from the canonical map so a failure reads
  // identically whether it surfaced from the Edge function or from a direct RPC — one wording,
  // not two. FIRST in the list on purpose: the generic /timeout|timed out/ pattern below would
  // otherwise swallow assistant_provider_timeout, and /not_authorized/ sits below for the same
  // reason notification_preference_not_authorized does.
  ...ASSISTANT_ERROR_CODES.map((code): [RegExp, string] => [
    new RegExp(code, 'i'),
    ASSISTANT_ERROR_MESSAGES[code],
  ]),
  // Two different refusals that must never read the same. One says "you used what you have"; the
  // other says "nobody has told the system what you have", which is our problem, not the
  // customer's, and sending them to buy an upgrade for it would be wrong.
  [/plan_limit_reached/i,
    'הגעתם למכסת התקופה במסלול הנוכחי — מסמכים או עמודי סריקה. המסמכים הקיימים והדוחות נשארים זמינים; לעיבוד מסמך חדש יש לשדרג מסלול או להמתין לתחילת תקופת השימוש הבאה.'],
  [/plan_limit_unknown/i,
    'לא הוגדרה מכסת מסמכים למסלול של הארגון, ולכן העיבוד נעצר מחשש לחיוב לא מבוקר. זו הגדרה במערכת ולא חריגה שלכם — יש לפנות לתמיכה.'],
  [/not_platform_capability/i,
    'הפעולה הזו אינה כלולה בהרשאות המפעיל שלך. ההרשאות מוקצות מחוץ למוצר.'],
  [/platform_filter_unknown/i,
    'הסינון שנשלח אינו מוכר. רענן את המסך ובחר סינון מהרשימה.'],
  [/entitlement_override_exists/i,
    'כבר קיים חריג פעיל להרשאה הזו. יש לבטל אותו לפני שמגדירים חריג חדש.'],
  [/subscription_plan_inactive/i,
    'המסלול הזה אינו מוצע ללקוחות חדשים ואי אפשר להעביר אליו ארגון.'],
  // The billing adapter's single refusal for every unproven-provider path -- checkout and
  // cancellation alike. Without it a refused cancellation fell through to FALLBACK, which for an
  // action the customer believes they just performed is close enough to silence. Our state, not
  // theirs, and it promises no date because none has been decided. Wording provisional (#203).
  [/not_configured/i,
    'הפעולה אינה זמינה עדיין: חיבור ספק הסליקה טרם הוגדר במערכת. זו הגדרה אצלנו ולא משהו שחסר מצדכם, ושום דבר במנוי לא השתנה.'],
  [/internal_note_already_resolved/i,
    'משימת המעקב כבר נסגרה. פתיחה מחדש נעשית ברשומה חדשה, כדי שהסגירה הקודמת תישאר מתועדת.'],
  [/internal_note_immutable|platform_lifecycle_event_immutable/i,
    'רשומות פנימיות ויומן הפלטפורמה אינם ניתנים לעריכה או למחיקה לאחר השמירה.'],
  [/proposal_pending_decision/i,
    'לספק כבר יש הצעה שממתינה להחלטה על ההזמנה הזו. יש להכריע עליה לפני הנפקת קישור או שליחה מחדש.'],
  [/order_not_linkable|email_order_not_sendable/i,
    'ההזמנה אינה במצב שניתן לשלוח לספק — רק הזמנה מוכנה לשליחה או שנשלחה זמינה לכך.'],
  [/link_already_revoked/i, 'הקישור כבר בוטל.'],
  [/proposal_already_decided/i, 'כבר נרשמה החלטה על ההצעה הזו. רענן את המסך כדי לראות אותה.'],
  [/decision_reason_required/i, 'דחייה של שורה או של תאריך אספקה מוצע מחייבת סיבה — היא תתועד ביומן הביקורת.'],
  [/decisions_incomplete|decisions_invalid/i, 'יש להכריע על כל שורה בהצעה — אישור או דחייה — לפני הרישום.'],
  [/revision_already_created/i, 'כבר נוצרה רוויזיה מההצעה הזו.'],
  [/revision_empty|proposal_not_accepted/i,
    'אי אפשר ליצור רוויזיה: אין אף שורה שאושרה עם כמות תקינה.'],
  [/email_channel_disabled/i,
    'לספק זה לא הוגדר ערוץ מייל. יש להגדיר את העדפות התקשורת בכרטיס הספק תחילה.'],
  [/email_destination_missing|communication_email_destination_missing/i,
    'לספק אין כתובת מייל — יש להזין כתובת בכרטיס הספק או בהעדפות התקשורת.'],
  [/communication_whatsapp_destination_missing/i,
    'לספק אין מספר WhatsApp תקין — יש להזין מספר בכרטיס הספק או בהעדפות התקשורת.'],
  [/communication_email_invalid/i, 'כתובת המייל שהוזנה אינה תקינה.'],
  [/communication_whatsapp_invalid/i, 'מספר ה-WhatsApp שהוזן אינו תקין. יש להזין מספר ישראלי.'],
  [/email_message_retry_limit/i,
    'נוצלו כל ניסיונות השליחה להזמנה זו. בעל העסק יכול לאפס את הניסיונות מהמסך הזה.'],
  [/email_message_not_resettable/i, 'ניתן לאפס רק שליחה שנכשלה או שנתקעה במצב לא ידוע.'],
  [/accepted_document_scan_immutable|document_scan_superseded_by_recovery/i,
    'הסריקה כבר אושרה או הוחלפה ואי אפשר לשנות את הראיה הקודמת. רענן את המסך כדי לראות את הגרסה הנוכחית.'],
  [/document_scan_recovery_unavailable|document_scan_processing_state_invalid/i,
    'מצב הסריקה השתנה ולא ניתן ליצור ממנה תיקון חדש. רענן את המסך ובדוק את הגרסה הנוכחית.'],
  [/retired_identity_requires_platform_reactivation/i,
    'זהות של תפקיד שפרש יכולה לחזור לחשבון פעיל רק דרך מנהל השירות, שמעדכן יחד את התפקיד ואת חסימת הכניסה.'],
  [/account_role_retired|role_not_invitable/i,
    'התפקיד הזה הוצא מהמוצר והחשבון אינו פעיל. ניתן להיכנס רק כמנהל, מנהל רכש או רואה חשבון.'],
  [/offboarding_already_requested/i,
    'כבר קיימת בקשת סיום שירות פעילה. רענן את המסך כדי לראות את מצבה.'],
  [/offboarding_cancellation_window_closed/i,
    'חלון הביטול בן 30 הימים הסתיים. המידע נשאר זמין לצפייה ולייצוא; להפעלה מחדש יש לפנות למנהל השירות.'],
  [/offboarding_export_not_ready|export_not_ready/i,
    'הייצוא עדיין אינו מוכן להורדה. מצבו יוצג כאן לאחר השלמת ההכנה.'],
  [/offboarding_export_lease_lost|offboarding_export_not_building/i,
    'ניסיון הכנת הייצוא הוחלף בניסיון חדש יותר. רענן את המסך לפני ניסיון נוסף.'],
  [/offboarding_request_unknown/i,
    'בקשת סיום השירות אינה זמינה עוד. רענן את המסך.'],
  [/offboarding_reactivation_window_closed/i,
    'לא ניתן להפעיל את הארגון מחדש במסלול האוטומטי. נדרשת בדיקה של מנהל השירות.'],
  [/export_build_failed|export_storage_upload_failed|export_file_download_failed/i,
    'הכנת הייצוא לא הושלמה. הנתונים לא נמחקו ומנהל השירות יכול להפעיל ניסיון חוזר בטוח.'],
  [/organization_read_only/i,
    'תקופת הניסיון הסתיימה והמערכת במצב קריאה בלבד. המידע נשמר וזמין לצפייה ולייצוא; להפעלה מחדש יש לפנות למנהל השירות.'],
  [/payment_request_not_executable/i,
    'דרישת התשלום אינה במצב שמאפשר ביצוע. רענן את המסך ובדוק את הסטטוס.'],
  [/payment_execution_fields_required/i,
    'יש להשלים תאריך, אסמכתה וסיבת ביצוע.'],
  [/payment_execution_conflict|payment_request_idempotency_conflict|invoice_idempotency_conflict|receipt_idempotency_conflict|bank_payment_idempotency_conflict|credit_request_idempotency_conflict/i,
    'אותה פעולה כבר נשלחה עם פרטים אחרים. רענן את המסך לפני ניסיון נוסף.'],
  // Ahead of the server's allocation family on purpose: `credit_allocation_exceeds_invoice` and
  // its siblings are specific readings of the same failure, and the generic sentences below would
  // otherwise answer a question the specific ones already answer better.
  ...Object.entries(ALLOCATION_REFUSAL_MESSAGES).map(([code, text]): [RegExp, string] => [
    new RegExp(code, 'i'),
    text,
  ]),
  [/allocation_exceeds_balance|payment_request_allocation_invalid/i,
    'הסכום שהוקצה גבוה מהיתרה הפתוחה. רענן את הנתונים ועדכן את החלוקה.'],
  [/allocation_total_mismatch|bank_allocation_total_mismatch/i,
    'סכום החלוקה אינו תואם לסכום הפעולה.'],
  // 0173: the executor checks each invoice of the request separately — cash allocated to it plus
  // credit offset against it must equal exactly what the request allocated to that invoice. It
  // fires when the split drifted from the request between preview and execution, so the sentence
  // sends the accountant back to the split rather than to the total.
  [/allocation_invoice_coverage_mismatch/i,
    'הסכום שהוקצה לאחת מחשבוניות הדרישה אינו מכוסה במדויק על ידי ההעברה והזיכויים שיוחסו לה. רענן את המסך ובדוק את החלוקה בין החשבוניות.'],
  // 0173: the credit and the invoice it was pointed at belong to different suppliers. Its own
  // sentence rather than an arm of allocation_target_invalid, because it is the one refusal here
  // that says the two records were never related — no refresh and no re-split will change that.
  [/credit_allocation_supplier_mismatch/i,
    'הזיכוי שייך לספק אחר מזה של החשבונית שנבחרה. אפשר לקזז זיכוי רק מול חשבונית של אותו ספק.'],
  // The server's containment refusal for a single allocation row: an invoice or a credit that is
  // not this org's, not this supplier's, not in this request, not in a state that can be
  // allocated, an amount above what is left of it — or a credit that already names an invoice
  // being pointed at a different one, which the server refuses here rather than by its own name.
  [/allocation_target_invalid|allocation_invalid/i,
    'אחת מהקצאות התשלום אינה תקינה: החשבונית או הזיכוי אינם שייכים לספק ולדרישה הזו, או שהסכום גבוה מהיתרה שנותרה. רענן את המסך ובדוק את הבחירה.'],
  [/payment_request_checks_failed/i,
    'בדיקות השרת מצאו חשבונית ששולמה או יתרה שהשתנתה. רענן ובדוק את הדרישה.'],
  [/payment_request_checks_mismatch/i,
    'פרטי דרישת התשלום השתנו מאז הבדיקה. רענן את המסך ובדוק שוב.'],
  [/payment_request_credit_override_required/i,
    'לספק קיימים זיכויים פתוחים. יש לבחור באישור החריג, לקרוא את האזהרה ולציין סיבה.'],
  [/payment_request_credit_total_changed|payment_request_credit_supplier_mismatch/i,
    'נתוני הספק או הזיכויים השתנו. רענן את הדרישה ועבור שוב על האזהרה לפני אישור.'],
  [/payment_request_credit_override_replay_mismatch|payment_request_credit_override_invalid/i,
    'פרטי אישור החריגה אינם תואמים לדרישה. רענן את המסך לפני ניסיון נוסף.'],
  [/payment_request_credit_override_not_required/i,
    'הזיכויים הפתוחים אינם קיימים עוד. רענן ואשר במסלול הרגיל.'],
  [/payment_request_credit_scope_unresolved|payment_request_scope_unresolved|payment_request_scope_invalid/i,
    'לא ניתן לאמת את הישות המשפטית של הדרישה או של זיכוי פתוח. האישור נחסם לבדיקה.'],
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
  // G1, finding 5: the old text said "רענן ובדוק את השורות", and a refresh cannot help with any of
  // the conditions this code actually covers. `save_goods_receipt` (0023:1505-1525) raises it when
  // the row count differs from the order's, when a row names an item that is not on the order, when
  // a quantity exceeds what remains, or when the status and the quantity disagree — the common
  // real-world cause being an item that arrived and was never ordered. Naming the constraint is the
  // only advice that leads anywhere, since a receipt cannot carry a line the order does not have.
  [/receipt_qty_exceeds_order/i,
    'הקבלה אינה תואמת לשורות ההזמנה. ניתן לקלוט רק את פריטי ההזמנה, בכמות שנותרה ובסטטוס התואם לה — פריט שלא הוזמן אינו יכול להתווסף לקבלה.'],
  // Split apart in wave 8: the offline queue can hit either of these while a device was
  // disconnected, and the conflict screen asks a different question for each — "another draft
  // exists for this order" is not "this receipt is already closed".
  [/receipt_draft_conflict/i,
    'קיימת טיוטת קבלה אחרת להזמנה הזו. יש להכריע איזו טיוטה מתארת את המשלוח לפני שמירה.'],
  [/receipt_already_completed/i,
    'הקבלה הזו כבר הושלמה בשרת ואינה נדרסת. הטיוטה נשמרה במכשיר ונדרשת הכרעה.'],
  [/inventory_movement_id_conflict/i,
    'אותה פעולת מלאי כבר נשלחה עם פרטים אחרים. השאר את החלון פתוח ורענן את נתוני המלאי לפני ניסיון נוסף.'],
  [/inventory_stocktake_required/i,
    'לא ניתן לרשום שינוי לפני ספירה פיזית ראשונה של המוצר.'],
  [/inventory_insufficient_stock/i,
    'הפעולה תיצור יתרה שלילית ולכן נחסמה. בדוק את הכמות או בצע ספירה פיזית.'],
  [/inventory_negative_override_forbidden/i,
    'אישור יתרה שלילית זמין לבעלים בלבד.'],
  [/inventory_product_unknown/i,
    'המוצר אינו פעיל או אינו זמין עוד. רענן את מסך המלאי.'],
  [/inventory_movement_invalid/i,
    'כמות תנועת המלאי או הסיבה אינן תקינות.'],
  [/inventory_not_authorized/i,
    'אין לך הרשאה לבצע את פעולת המלאי הזו.'],
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
  [/invoice_has_financial_references/i,
    'לא ניתן למחוק חשבונית שמקושרת לדרישת תשלום, תשלום, זיכוי, התאמת בנק או דוח שנשלח. יש לטפל בקשר הכספי במסך המתאים.'],
  [/invoice_not_found/i,
    'החשבונית אינה זמינה עוד.'],
  // Two guards, two sentences (0146). They shared one line until the owner hit it: a supplier with
  // a forgotten draft order and no money owed was told he had an open balance.
  [/supplier_has_open_balance/i,
    'לא ניתן למחוק ספק שיש לו יתרה פתוחה. יש לסגור את היתרה לפני המחיקה.'],
  [/supplier_has_active_orders/i,
    'לא ניתן למחוק ספק שיש לו הזמנה פעילה. יש לסיים או לבטל את ההזמנה לפני המחיקה.'],
  [/supplier_not_found|product_not_found/i,
    'הרשומה אינה זמינה עוד. רענן את המסך.'],
  [/purchase_order_cancel_invalid/i,
    'לא ניתן לבטל הזמנה שכבר התקבלה, גם באופן חלקי.'],
  [/invoice_fields_required|invoice_review_fields_required/i,
    'חסרים פרטים הנדרשים לשמירת החשבונית.'],
  [/credit_request_not_fully_allocated/i,
    'הזיכוי טרם נוצל. אפשר לסמן אותו כמקוזז רק אחרי שהוא שובץ בתשלום בפועל.'],
  [/credit_request_transition_invalid/i,
    'לא ניתן להעביר את הזיכוי לסטטוס שנבחר מהמצב הנוכחי.'],
  [/credit_request_invoice_unknown|credit_request_unknown/i,
    'הזיכוי או החשבונית המקושרת אינם זמינים עוד. רענן את המסך.'],
  [/credit_request_invoice_not_approved/i,
    'הנהלת חשבונות יכולה לטפל בזיכוי רק לאחר אישור החשבונית המקושרת.'],
  [/credit_request_amount_invalid|credit_request_fields_required|credit_request_transition_fields_required/i,
    'חסרים פרטים או שסכום הזיכוי אינו תקין.'],
  [/price_import_target_invalid/i,
    'הייבוא בוטל: ספק או מוצר אינם זמינים או אינם שייכים לחשבון הזה.'],
  [/price_import_invalid/i,
    'הייבוא בוטל: קיימת שורה כפולה או מחיר שאינו בטווח המותר.'],
  [/price_submission_idempotency_conflict/i,
    'ההגשה כבר נקלטה עם פרטי קובץ אחרים. רענן את היסטוריית ההגשות לפני ניסיון נוסף.'],
  [/price_submission_intake_busy/i,
    'הקובץ כבר נמצא בתהליך קליטה. המתן רגע ונסה שוב.'],
  [/price_submission_file_changed/i,
    'הקובץ השתנה בזמן הקליטה. בחר אותו מחדש ונסה שוב.'],
  [/price_submission_file_missing|price_submission_intake_required/i,
    'הקובץ הזמני אינו זמין עוד. בחר את הקובץ מחדש ונסה שוב.'],
  [/price_submission_supplier_invalid/i,
    'הספק אינו זמין עוד. רענן את המסך לפני הגשה נוספת.'],
  [/price_submission_intake_invalid|price_submission_invalid/i,
    'פרטי קובץ המחירון אינם תקינים. השתמש בתבנית המעודכנת ונסה שוב.'],
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
  [/Invalid month/i,
    'החודש שנבחר אינו תקין — בחר חודש בפורמט תקין'],
  // `queryResult.ts` throws this instead of ever letting a missing COUNT render as 0 — zero is a
  // claim about the business. The sentence says the list is unverified, not empty.
  [/count_unavailable/i,
    'לא ניתן לאמת כרגע את מספר הרשומות ברשימה. רענן את המסך ונסה שוב.'],
  // Migration 0068 / migration 0068. Ahead of the generic `not_authorized` line below on purpose:
  // PATTERNS is scanned in order, and `notification_preference_not_authorized` would otherwise be
  // answered by the generic sentence instead of by one that names the setting.
  [/notification_preference_not_authorized/i,
    'לא ניתן לעדכן את העדפות ההתראות כרגע. יש להתחבר מחדש ולנסות שוב.'],
  [/notification_event_unknown/i,
    'סוג ההתראה הזה אינו מוכר למערכת. רענן את הדף ונסה שוב.'],
  [/notification_preference_invalid/i,
    'העדפת ההתראה שנשלחה אינה תקינה.'],
  [/financial_command_rpc_required|invoice_soft_delete_rpc_required|supplier_soft_delete_rpc_required|product_active_rpc_required|purchase_order_cancel_rpc_required/i,
    'הנתונים השתנו דרך מסלול ישן שנחסם. רענן את האפליקציה ונסה שוב.'],
  [/fresh_authentication_required/i,
    'נדרש אימות מחדש — הזינו סיסמה כדי לאשר פעולה רגישה.'],
  // 0071: the server refuses to leave an active member with zero scope grants. Without this
  // sentence the browser would show a bare Postgres string for the one refusal whose whole
  // purpose is to prevent a silent ₪0 on a financial screen.
  [/scope_last_grant_required/i,
    'לא ניתן להסיר את הרשאת היחידה האחרונה של משתמש פעיל — הוא יאבד גישה לכל הנתונים הכספיים והמסכים יציגו אפס. הענק יחידה אחרת לפני הצמצום, או השבת את המשתמש.'],
  [/invoice_create_not_authorized|invoice_review_not_authorized|credit_request_create_not_authorized|credit_request_transition_not_authorized|price_write_not_authorized|price_import_not_authorized|price_submission_not_authorized|price_submission_intake_service_only|month_export_not_authorized|not_authorized/i,
    'אין לך הרשאה לבצע את הפעולה הזו.'],
  [/draft_unknown/i,
    'הטיוטה אינה זמינה עוד. ייתכן שבוטלה או אושרה בחלון אחר.'],
  [/draft_invalid_supplier_selection|draft_supplier_unavailable/i,
    'אחד הספקים שנבחרו אינו זמין עוד. יש לבחור ספק מחדש.'],
  [/draft_price_changed/i,
    'המחירים השתנו. הסיכום רוענן ויש לעבור עליו ולאשר שוב.'],
  [/document_already_filed/i,
    // "יעד עסקי" is the entity_type column talking. A bookkeeper files a document against an
    // invoice or a goods receipt, so that is what the message names.
    'המסמך כבר משויך לחשבונית או לקבלת סחורה.'],
  [/document_processing_active/i,
    'המסמך כבר נמצא בתור או בעיבוד. רענן את מרכז התפעול לפני ניסיון נוסף.'],
  [/document_target_unknown/i,
    'יעד התיוק אינו זמין עוד. יש לבחור יעד אחר.'],
  // The archive screen's most likely real race: two clerks, one rescues the document, the
  // other's list is stale. Both refusals name exactly what happened, so the second person is
  // told the truth instead of getting the generic fallback.
  [/document_not_in_archive/i,
    'המסמך כבר אינו בארכיון. ייתכן שהוחזר לטיפול בחלון אחר.'],
  [/document_unknown/i,
    'המסמך אינו זמין עוד. ייתכן שהוסר בחלון אחר.'],
  // 0077 section 4b. Reversal is a ONE-WAY DOOR, and its likeliest real failure is not an attack —
  // it is two clerks looking at one list, the second a few seconds behind. Both refusals say what
  // actually happened instead of the generic fallback, and `auto_action_unknown` deliberately does
  // not distinguish "another tenant's" from "does not exist": that distinction is the leak.
  [/auto_action_already_reverted|document_auto_action_immutable/i,
    'השיוך האוטומטי כבר בוטל. רענן את המסך כדי לראות את המצב העדכני.'],
  [/auto_action_unknown/i,
    'השיוך האוטומטי אינו זמין עוד. רענן את המסך.'],
  // 0076. The autonomy command refuses by name rather than by constraint, so each refusal can be
  // answered with the rule that was broken. `autonomy_policy_reason_required` is deliberately NOT
  // here: it contains `reason_required`, and the generic sentence below is already the right one.
  [/autonomy_policy_not_tightening/i,
    'הסף שהוזן נמוך מרצפת המערכת. דייר רשאי לדרוש ביטחון גבוה יותר, לעולם לא נמוך יותר.'],
  [/autonomy_policy_invalid/i,
    'סף הביטחון חייב להיות מספר גדול מ-0 ועד 1, ויש לבחור ארגון ומצב.'],
  [/autonomy_policy_unknown/i,
    'מדיניות האוטונומיה המבוקשת אינה קיימת במערכת.'],
  [/not_platform_admin/i,
    'הפעולה הזו פתוחה למנהלי פלטפורמה בלבד.'],
  [/reason_required/i,
    'יש להזין סיבה לביצוע הפעולה.'],
  // Its own sentence rather than an arm of reason_required: telling someone who just wrote 1001
  // characters that they must enter a reason is a worse answer than the raw constraint name it
  // replaces. Ahead of nothing in particular — it collides with no other pattern.
  [/reason_too_long/i,
    'הסיבה ארוכה מדי. יש לקצר אותה ל-1000 תווים לכל היותר.'],
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
  [/FunctionsHttpError|Edge Function returned a non-2xx status code/i,
    'שירות הפעולה אינו זמין כרגע. נסה שוב בעוד מספר דקות.'],
  [/Failed to fetch|NetworkError|ERR_NETWORK|fetch failed|FunctionsFetchError|Failed to send a request to the Edge Function|FunctionsRelayError/i,
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
