-- מנויי Web Push — תשתית התראות דחיפה (PWA).
--
-- מספר המיגרציה נקבע באינטגרציה: 0013_align_allocation_fk הוא האחרון שהוחל, ו-0014
-- שמור לסוכן שעובד במקביל. אין בגוף המיגרציה תלות במספר עצמו.
--
-- כל שורה = מכשיר אחד של משתמש אחד שאישר קבלת התראות בדפדפן. ה-endpoint הוא כתובת
-- שירות הדחיפה של הדפדפן (FCM/Mozilla/APNs) והמפתחות p256dh/auth הם מפתחות ההצפנה
-- שהדפדפן הנפיק למנוי — בלעדיהם אי אפשר להצפין את ההודעה. שליחה בפועל נעשית רק
-- ב-Edge Function ‏send-push (עם מפתח VAPID הפרטי, שלעולם אינו בדפדפן).
--
-- אין כאן מחיקה רכה: מנוי דחיפה אינו רשומה כספית — הוא הרשאה טכנית של מכשיר.
-- מנוי שפג (410 Gone משירות הדחיפה) נמחק ב-send-push; משתמש שנמחק גורר cascade.

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  user_id uuid not null references profiles(id) on delete cascade,
  endpoint text not null unique,      -- כתובת ייחודית פר-מנוי; עוגן ההשתלטות ב-claim_push_subscription
  p256dh text not null,               -- מפתח הצפנה ציבורי של המנוי (מהדפדפן)
  auth text not null,                 -- auth secret של המנוי (מהדפדפן)
  user_agent text,                    -- זיהוי מכשיר לתצוגה/דיבוג בלבד
  created_at timestamptz default now()
);

-- send-push שולף "כל המנויים של ארגון X" — זו השאילתה היחידה שרצה על הטבלה בצד השרת.
create index push_subscriptions_org_idx on push_subscriptions (org_id);

-- ===== RLS =====
-- משתמש רואה ומנהל אך ורק את המנויים של עצמו, בתוך הארגון שלו. אין policy ל-update
-- בכוונה: מנוי לא "מתעדכן" — הדפדפן מנפיק endpoint חדש, והלקוח מבצע insert/delete.
-- ה-Edge Function ניגש עם service_role ועוקף RLS כדין (שליחה + ניקוי מנויים מתים).
alter table push_subscriptions enable row level security;

create policy push_subs_select on push_subscriptions for select
  using (org_id = auth_org() and user_id = auth.uid());
create policy push_subs_insert on push_subscriptions for insert
  with check (org_id = auth_org() and user_id = auth.uid());
create policy push_subs_delete on push_subscriptions for delete
  using (org_id = auth_org() and user_id = auth.uid());

-- ===== claim_push_subscription — השתלטות-מחדש על endpoint בהחלפת משתמש =====
-- ה-endpoint הוא פר-דפדפן (per-origin), לא פר-משתמש: כשמשתמש א' מתנתק ומשתמש ב' נכנס
-- באותו מכשיר, הדפדפן מחזיר לב' את אותו endpoint בדיוק. insert/upsert רגיל תחת ה-RLS
-- שלמעלה לא יכול לגעת בשורה של א' (היא לא נראית לב'), כך שהמכשיר היה ממשיך לקבל
-- התראות של הארגון של א' בזמן שב' רואה "התראות פעילות". לכן ההרשמה עוברת דרך פונקציית
-- definer: מוחקת כל שורה קיימת עם ה-endpoint הזה — יהיה בעליה אשר יהיה — ומכניסה שורה
-- חדשה על שם המשתמש המחובר עכשיו. המכשיר תמיד שייך למי שמחזיק בו כרגע, ולא לקודמו.
-- אותו דפוס definer + search_path כמו 0001:42-47 ו-0007.
create or replace function claim_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_org uuid := auth_org();
  v_uid uuid := auth.uid();
begin
  if v_org is null or v_uid is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  delete from push_subscriptions where endpoint = p_endpoint;
  insert into push_subscriptions (org_id, user_id, endpoint, p256dh, auth, user_agent)
  values (v_org, v_uid, p_endpoint, p_p256dh, p_auth, p_user_agent);
end $$;

-- דפוס ההרשאות של 0007:267-277: שלילת ברירת המחדל הציבורית, ואז הענקה מפורשת
-- ל-authenticated בלבד — anon לעולם לא רושם מנוי מכשיר.
revoke all on function claim_push_subscription(text, text, text, text) from public;
grant execute on function claim_push_subscription(text, text, text, text) to authenticated;
