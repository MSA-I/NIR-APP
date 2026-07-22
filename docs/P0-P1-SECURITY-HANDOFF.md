# P0 → P1 — חוזה cutover לביצוע תשלום

**סטטוס 22.07.2026: החוזה הושלם.** מסמך זה נשמר כהיסטוריית ה־cutover. מיגרציה `0023`
והלקוח התואם בקומיט P0/P1 ‏`e04dd5d` הסירו את שלוש כתיבות ה־payer הישירות והעבירו את
הביצוע ל־RPC יחיד. העבודה נבדקה מקומית בלבד ואינה אישור לפרודקשן; לא בוצעו push, deploy
או מיגרציה חיה.

## מה P0 כבר מבטיח

- `payments`, ‏`payment_requests`, ‏`payment_allocations`, החשבוניות והיעדים המקושרים נושאים
  `org_id` ונאכפים באמצעות FK מורכבים אל `(org_id,id)`.
- זהות הדייר/הרשומה אינה ניתנת לשינוי דרך JWT; DELETE קשיח סגור; ה־views וה־refresh של
  סטטוס חשבונית מסננים ומצרפים גם על `org_id`.
- audit של המוטציות עצמן הוא server-authored. P0 לא הוסיף unique/idempotency, בדיקת סכומי
  allocation או graph של מעברי סטטוס — אלה בבעלות P1.

## מסלול הכתיבה הישיר שנסגר

לפני `0023`, ‏`src/pages/PayerQueue.tsx` ביצע שלושה שלבים בלתי־אטומיים:

1. INSERT ל־`payments`.
2. INSERT אחד או יותר ל־`payment_allocations`, וביניהם קריאות
   `refresh_invoice_payment_status`.
3. UPDATE של `payment_requests.status` ל־`executed`.

מטריצת ה־RLS של P0 השאירה זמנית את שלוש המדיניות הבאות:

| טבלה | policy | פעולה שמותרת ל־payer |
|---|---|---|
| `payment_requests` | `payment_requests_payer_update` | UPDATE של דרישה בדייר הנוכחי מ־`approved`/`sent_for_execution` אל `sent_for_execution`/`executed` |
| `payments` | `payments_payer_insert` | INSERT בדייר הנוכחי כאשר `executed_by = auth.uid()` |
| `payment_allocations` | `pa_payer_insert` | INSERT כאשר התשלום בדייר הנוכחי ונוצר בידי אותו payer |

`0023` הסירה את שלוש המדיניות ואת הרשאות הכתיבה הישירה לטבלאות שבבעלות הפקודה. לא נוצרה
policy חלופית ל־payer; owner/office פועלים גם הם דרך פקודות השרת הרלוונטיות.

## העסקה האטומית ש־P1 מספק

`execute_payment_request` הוא מקור הכתיבה היחיד של payer. באותה טרנזקציה הוא:

- לגזור actor ו־`org_id` מן ה־JWT, לא מן הקלט, ולאפשר `payer` בלבד אלא אם החלטה מתועדת
  מאשרת במפורש תפקיד נוסף.
- לנעול את דרישת התשלום ואת כל החשבוניות/זיכויים לפי סדר UUID יציב; לקבל רק
  `approved`/`sent_for_execution`. ניסיון חוזר על אותו ביצוע מחזיר את אותו `payment_id`.
- לאמת אותו דייר ואותו ספק, סכומים חיוביים, יעד יחיד לכל allocation, ללא יעד כפול,
  שסכום ההקצאות אינו עולה על התשלום ושאין חריגה מיתרות פתוחות.
- ליצור `payment` והקצאות, לבצע מעבר זיכוי רלוונטי, לרענן חשבוניות ולעדכן את הדרישה — או
  לבצע rollback מלא. אין מצב ביניים של payment ללא allocations.
- לאכוף idempotency/unique על `payments.payment_request_id` בהתאם לחוזה של ביצוע יחיד,
  לדרוש סיבה לא ריקה ולכתוב audit אחד עם actor/org/old/new אמיתיים.
- להחזיר JSON מינימלי ויציב הכולל `payment_id`, סטטוס ורשימת החשבוניות שרועננו, עם קודי
  שגיאה קבועים המתורגמים ב־`src/lib/errors.ts`.

`PayerQueue.tsx` הוחלף לקריאת RPC אחת. אין fallback לרצף הישן ואין קריאת `logAction`
נוספת לפעולה הזאת.

## בדיקות cutover חובה

- קריאת ה־RPC החיובית יוצרת payment, allocations, סטטוס דרישה, סטטוסי חשבונית ו־audit
  בעסקה אחת; failure באמצע משאיר את כולן ללא שינוי.
- שני ניסיונות זהים/מקבילים יוצרים payment אחד ומחזירים תוצאה אידמפוטנטית; בקשות שונות
  עם אותה דרישה אינן יוצרות כפילות או deadlock.
- payer נדחה עבור סכום אפס/שלילי/עודף, יעד כפול, שני יעדים, דייר/ספק אחר, דרישה במצב לא חוקי,
  סיבה ריקה או שינוי שדות שאינם חלק מן הפקודה.
- קריאת REST ישירה כ־payer ל־INSERT `payments`, ‏INSERT `payment_allocations` ו־UPDATE
  `payment_requests` נכשלת לאחר הסרת שלוש ה־policies. קריאות SELECT המותרות ממשיכות לעבוד.
- owner/office/accountant והתפקידים האחרים נשארים במטריצה הקנונית; session של ארגון מושעה
  אינו מפעיל את ה־RPC; מזהה חוקי של דייר אחר נדחה.
- בדיקות P0 ‏`check-p0-security.ps1` ו־`check-p0-upgrade.ps1` רצות מחדש לאחר rebase/renumbering,
  לצד בדיקות retry/concurrency של P1, ‏`npm run build`, ‏`npm audit` ו־`git diff --check`.

## תלות audit נוספת שנחשפה

`src/lib/audit.ts` אינו כותב `audit_logs` מן הדפדפן ומחזיר `logged:false` בכוונה. כל פעולות
P1 ב־Bank, Credits, InvoiceNew/Detail, PaymentRequests, Reports, PayerQueue, Receiving ומחירים
כבר כותבות action וסיבה בתוך ה־RPC. נותרו פעולות legacy שמחוץ לגבול P1 ב־Exceptions,
Invoices soft-delete, Orders, Products, Suppliers ו־`src/lib/share.ts`; ה־trigger מתעד בהן את
המוטציה האמיתית, אך שדרוגן לפקודת שרת הוא עבודה עתידית נפרדת. אסור להחזיר INSERT גנרי
ל־audit או לאפשר ללקוח לבחור payload.
