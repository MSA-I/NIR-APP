# חוזה גל 6b — חידוש הזמנת העלאה (agent-db → agent-client)

‏`0065_upload_reservation_renewal.sql`. כל מה שהלקוח (tus / Upload Center) צריך כדי לבנות מול
צד-השרת של גל 6b, בלי לקרוא את המיגרציה.

## 1. ה-RPC החדש

```sql
renew_supplier_price_document_upload(p_document_id uuid) returns jsonb
```

- ‏SECURITY DEFINER; ‏EXECUTE ל-`authenticated` בלבד (‏anon/service_role — לא).
- קריאה: `supabase.rpc('renew_supplier_price_document_upload', { p_document_id })`.
- מאריך **זמן בלבד**. שום פרמטר אחר; שום re-bind; העמודה היחידה שמשתנה היא `expires_at`.
- ההזמנה חייבת להיות **של הקורא עצמו** (`actor_id = auth.uid()`, `org_id = auth_org()`), עם
  בדיקות-החיים המלאות של reserve: פרופיל פעיל, תפקיד `owner`/`office`/`supplier`, ‏supplier
  מקושר עבור תפקיד supplier, ארגון `trial`/`active`, ספק לא-מחוק.

### תשובה מוצלחת

```json
{
  "document_id": "…",
  "expires_at": "…",        // ההארכה החדשה: least(now()+15min, created_at+45min)
  "renewable_until": "…"    // created_at + 45min — אחרי הרגע הזה renew ייכשל סופית
}
```

### קודי שגיאה (message → משמעות ללקוח)

| message | errcode | מתי | מה הלקוח עושה |
|---|---|---|---|
| `document_upload_reservation_unknown` | `P0002` | אין הזמנה כזו של הקורא (כולל actor זר / org זר / נמחקה ב-sweep) | כישלון סופי של ההעלאה; להציע העלאה חדשה (reserve חדש) |
| `document_upload_reservation_registered` | `P0001` | ההזמנה כבר נרשמה — אין חלון העלאה להאריך | **לא** להעלות מחדש; להציג את המסמך הרשום (חוק הכסף); `register` על אותו id יחזיר קבלה אידמפוטנטית |
| `document_upload_reservation_lifetime_exceeded` | `P0001` | ‏`created_at + 45min <= now()` — תקרת החיים הכוללת | כישלון סופי; העלאה מחדש דורשת reserve חדש |
| `not_authorized` | `42501` | פרופיל לא פעיל / תפקיד לא מורשה / supplier לא-תואם / ארגון לא פעיל | כמו בכל שאר ה-RPCs |
| `supplier_unknown` | `P0002` | הספק של ההזמנה נמחק בינתיים | כישלון סופי |

## 2. תקרת חיים ו-grace — הסמנטיקה המלאה

- **הזמנה נולדת** עם `expires_at = created_at + 15min` (ללא שינוי מ-0048).
- **‏renew** קובע `expires_at = least(now() + 15min, created_at + 45min)`. תקרת החיים הכוללת
  היא **45 דקות** מ-`created_at` — מתחת לתפוגת ה-tus בענן (~1h). קריאת renew כשמגיעים לתקרה
  נכשלת ב-`document_upload_reservation_lifetime_exceeded`.
- **‏expires_at הוא שער-המוות הלוגי:** מדיניות ה-Storage (העלאה) ו-`register` דוחים הזמנה
  שפגה — ללא שינוי. ‏register על הזמנה שפגה: `document_upload_reservation_expired`.
- **ה-sweep הפיזי מחכה שעה:** ‏reserve (של כל שחקן, בכל דייר) מוחק רק הזמנות `reserved` עם
  `expires_at <= now() - interval '1 hour'`. המשמעות ללקוח: הזמנה שפגה **אך בתוך תקרת
  ה-45 דקות** עדיין ניתנת ל-renew — ‏renew מחיה אותה (קובע expires_at עתידי). זה בדיוק מרוץ
  החידוש שה-grace קיים בשבילו: 403 על PATCH ⇒ ‏renew אחד ⇒ ‏resume, בלי לאבד bytes שכבר עלו.
- **תזמון מומלץ (הכרעת PLAN-07 §1.5):** ‏renew יזום כשנותרו <5 דק׳ ל-`expires_at`
  (‏onChunkComplete); על 403 ב-PATCH — ‏renew-אחד-ואז-resume לפני שמכריזים כישלון.

## 3. נירמול MIME — חוק אחד, זהה לשרת

השרת מנרמל בכל שער (‏reserve, מדיניות ה-Storage, ‏register):

```
lower(split_part(trim(mime), ';', 1))
```

כלומר: חיתוך בנקודה-פסיק הראשונה (הסרת `;charset=…`), ‏trim, ‏lowercase. הלקוח חייב לשלוח
ב-tus ‏`contentType` (‏metadata mimetype) **מנורמל כך** — זהה לערך שנמסר ל-reserve. אחרת
מדיניות ההעלאה נכשלת (403). ‏`application/octet-stream` אינו ברשימת ה-MIME המותרת —
נכשל-סגור ב-403 שה-UI מתרגם.

## 4. מה עוד השתנה ב-0065 (לידיעה בלבד)

- **טריגר-שומר עמודות** על טבלת ההזמנות: כל UPDATE שמשנה
  ‏`org_id`/`actor_id`/`supplier_id`/`file_name`/`mime_type`/`storage_path`/`created_at` נזרק;
  מעבר סטטוס יחיד מותר: `reserved → registered` (נתיב ה-register בלבד). ללקוח אין נגיעה —
  אין לו גישת DML לטבלה ממילא.
- **אין audit על renew** (תקדים reserve; ‏OPEN-DECISIONS ‏#95).
- ‏preflight קיבל זרוע ‏#39 (`expired_reservations_with_stored_object`) — לא נוגע ללקוח.
