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
  endpoint text not null unique,      -- כתובת ייחודית פר-מנוי; עוגן ה-upsert בצד הלקוח
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
