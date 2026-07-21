-- מקורות ההתראות בצד השרת: טריגר עליית-מחיר + סריקת תשלומים יומית (pg_cron).
-- שניהם קוראים ל-Edge Function ‏send-push דרך pg_net; ההיגיון העסקי (מי מקבל, איזה
-- נוסח) חי בפונקציה, לא כאן — ה-DB רק מדווח "קרה אירוע בארגון X".
--
-- ===== תפעול — מה מפעיל חד-פעמית (operator) =====
-- 1. מפתחות VAPID:  npx web-push generate-vapid-keys
--    ואז:  supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
--                                VAPID_SUBJECT=mailto:ops@example.co.il PUSH_FN_SECRET=<סוד-אקראי-ארוך>
--    את המפתח הציבורי מזינים גם ל-build של ה-SPA:  VITE_VAPID_PUBLIC_KEY (ראה .env.example).
-- 2. פריסה:  supabase functions deploy send-push --no-verify-jwt
--    (--no-verify-jwt הכרחי: הקריאות מגיעות מ-pg_net בלי JWT; הסוד המשותף הוא ההגנה.)
-- 3. זריעת התצורה — דרך scripts/db-query.sh / db-query.ps1, עם ערכים אמיתיים במקום ה-placeholders:
--      insert into private.push_config (id, edge_url, secret)
--      values (true,
--              'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-push',
--              'YOUR_PUSH_FN_SECRET')  -- אותו ערך בדיוק כמו ה-secret של הפונקציה
--      on conflict (id) do update set edge_url = excluded.edge_url, secret = excluded.secret;
-- 4. אימות ה-cron:  select jobname, schedule, active from cron.job;
--
-- כל עוד אין שורת תצורה — הטריגר וה-cron הם no-op שקט. כך המיגרציה בטוחה להרצה
-- לפני שהפונקציה נפרסה, וסביבת פיתוח בלי דחיפות פשוט לא שולחת כלום.

create extension if not exists pg_net;

-- סכימה מחוץ ל-API של PostgREST ובלי שום grant — הסוד המשותף לעולם אינו נגיש
-- למשתמשי האפליקציה, בשום role. רק קוד definer (הטריגר) וה-cron (postgres) קוראים אותו.
create schema if not exists private;

create table if not exists private.push_config (
  id boolean primary key default true,   -- שורה אחת בלבד (id חייב להיות true)
  edge_url text not null,                -- https://<ref>.supabase.co/functions/v1/send-push
  secret text not null                   -- זהה ל-PUSH_FN_SECRET של הפונקציה
);

-- ===== 1. טריגר עליית מחיר על supplier_products =====
-- ברמת statement עם transition tables: עדכון מחירון שנוגע במאה שורות מייצר קריאת
-- HTTP אחת פר ארגון (עם count), לא מאה קריאות. ההשוואה current_price ישנה מול חדשה
-- היא בדיוק התנאי של scanPriceIncreases ב-src/lib/alerts.ts:91 — שם זו סריקת מסך על
-- חלון של 30 יום, כאן זה הרגע עצמו: הדחיפה מדווחת על העדכון שקרה עכשיו.
--
-- security definer: הטריגר רץ בהקשר המשתמש המעדכן, שאסור לו (ואין לו) גישה
-- ל-private.push_config; הפונקציה קוראת את התצורה בזכות ה-definer בלבד.
create or replace function private.notify_price_increase() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cfg private.push_config%rowtype;
  rec record;
begin
  select * into cfg from private.push_config where id;
  if not found then
    return null;  -- אין תצורה — אין דחיפות (סביבה בלי send-push)
  end if;

  for rec in
    select n.org_id, count(*)::int as cnt
    from new_rows n
    join old_rows o on o.id = n.id
    where n.current_price > o.current_price
    group by n.org_id
  loop
    -- pg_net של Supabase: http_post(url, body jsonb, params jsonb, headers jsonb, timeout)
    -- מחזירה מזהה בקשה מיידית — אסינכרוני, לא חוסם את טרנזקציית העדכון.
    perform net.http_post(
      url     := cfg.edge_url,
      body    := jsonb_build_object(
                   'event',   'price_increase',
                   'org_id',  rec.org_id,
                   'payload', jsonb_build_object('count', rec.cnt)),
      headers := jsonb_build_object(
                   'Content-Type',  'application/json',
                   'x-push-secret', cfg.secret)
    );
  end loop;
  return null;
end $$;

create trigger supplier_products_push_price
  after update on supplier_products
  referencing old table as old_rows new table as new_rows
  for each statement
  execute function private.notify_price_increase();

-- ===== 2. סריקת תשלומים מתקרבים — pg_cron יומי =====
-- 04:00 UTC = ‏06:00 בישראל בחורף / ‏07:00 בקיץ (pg_cron מתוזמן ב-UTC בלבד) — לפני
-- תחילת יום העבודה. ההיגיון (חלון 7 ימים, סטטוסים פעילים) יושב ב-send-push, בראי
-- של src/lib/alerts.ts scanPaymentsDueSoon.
create extension if not exists pg_cron;

-- התצורה נקראת בתוך ה-DO — בזמן ריצה, לא בזמן התזמון: עדכון private.push_config
-- נקלט בריצה הבאה בלי לגעת ב-cron. בלי שורת תצורה הריצה מסתיימת בשקט.
select cron.schedule('push-payment-due', '0 4 * * *', $$
do $job$
declare
  cfg private.push_config%rowtype;
begin
  select * into cfg from private.push_config where id;
  if not found then
    return;
  end if;
  perform net.http_post(
    url     := cfg.edge_url,
    body    := '{"event":"payment_due_scan"}'::jsonb,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'x-push-secret', cfg.secret)
  );
end $job$;
$$);
