-- מדדי תמיכה בהחלטות פר-ספק (סעיף 4 של "המשך פיתוח").
--
-- מספר המיגרציה נקבע באינטגרציה. מצב המספור בזמן הכתיבה: 0010_documents_soft_delete
-- כבר קיים והוחל על ה-DB החי (docs/PROGRESS.md), ו-0011_global_search שייך לסוכן החיפוש
-- — כלומר המספר הפנוי הבא הוא 0012. אין בגוף המיגרציה שום תלות במספר עצמו: שמות
-- האובייקטים (העמודות, ה-view supplier_metrics) אינם ממוספרים.
--
-- דפוס 0003/0008: view אגרגטיבי הוא SECURITY DEFINER (ללא security_invoker)
-- ומגן על org + role בתוך ה-WHERE שלו. הסיבה: הטבלאות שמתחת נושאות RLS צר יותר
-- מהקהל המיועד לאגרגט (משתמש kitchen צריך מדדים בלי גישה ל-payment_allocations).
-- אסור לחשוף org_id בעמודות ה-select — ראה 0008:53-55 ובלוק ה-self-check ב-0005:95.
-- auth_org() הוגדרה מחדש ב-0006:79-86 וכוללת דחייה של ארגון suspended; השימוש זהה.

-- ===== 1. דירוג ספק ידני (הכרעה פתוחה #25) =====
alter table suppliers add column rating smallint check (rating between 1 and 5);
alter table suppliers add column rating_updated_at timestamptz;
alter table suppliers add column rating_note text;

comment on column suppliers.rating is
  'דירוג איכות ידני 1-5 שמזין הצוות. במכוון אינו ציון משוקלל מחושב: '
  'קביעת המשקלות היא הכרעה עסקית — docs/OPEN-DECISIONS.md #25.';

-- ===== 2. view המדדים =====
-- חלון: 180 יום (הכרעה פתוחה #26). מונים "אי פעם" נשמרים לצידו.
create view supplier_metrics as
with cfg as (
  select (now() - interval '180 days') as since
),
deliveries as (
  select po.supplier_id,
         po.expected_date,
         po.sent_at,
         (select min(g.received_at)
            from goods_receipts g
           where g.order_id = po.id and g.status = 'completed') as received_at
  from purchase_orders po
  where po.org_id = auth_org()
    and po.status in ('received', 'partial')
),
d as (
  select v.supplier_id,
    count(*) filter (where v.expected_date is not null)                      as otd_samples,
    count(*) filter (where v.expected_date is not null
                       and (v.received_at at time zone 'Asia/Jerusalem')::date
                           <= v.expected_date)                               as otd_on_time,
    count(*) filter (where v.sent_at is not null)                            as lead_samples,
    avg( (v.received_at at time zone 'Asia/Jerusalem')::date
       - (v.sent_at     at time zone 'Asia/Jerusalem')::date )
      filter (where v.sent_at is not null)                                   as avg_lead_days
  from deliveries v, cfg
  where v.received_at is not null
    and v.received_at >= cfg.since
  group by v.supplier_id
),
x as (
  select e.supplier_id,
    count(*) filter (where e.status in ('open','in_progress'))               as open_exceptions,
    count(*) filter (where e.created_at >= (select since from cfg))          as exceptions_window,
    count(*)                                                                 as exceptions_lifetime
  from exceptions e
  where e.org_id = auth_org() and e.supplier_id is not null
  group by e.supplier_id
),
c as (
  select cr.supplier_id,
    count(*) filter (where cr.status in ('open','requested','received'))     as open_credits,
    coalesce(sum(cr.amount) filter (where cr.status in ('open','requested','received')), 0)
                                                                             as open_credits_amount,
    count(*) filter (where cr.created_at >= (select since from cfg))         as credits_window,
    count(*)                                                                 as credits_lifetime
  from credit_requests cr
  where cr.org_id = auth_org()
  group by cr.supplier_id
),
p as (
  select sp.supplier_id,
         count(distinct sp.id)   as priced_items,
         count(h.id)             as price_changes_window,
         max(h.effective_date)   as last_price_change
  from supplier_products sp
  left join price_history h
         on h.supplier_product_id = sp.id
        and h.effective_date >= (select since::date from cfg)
  where sp.org_id = auth_org()
  group by sp.supplier_id
)
select s.id as supplier_id,
  coalesce(d.otd_samples, 0)                                   as otd_samples,
  coalesce(d.otd_on_time, 0)                                   as otd_on_time,
  case when coalesce(d.otd_samples, 0) = 0 then null
       else round(d.otd_on_time::numeric * 100 / d.otd_samples, 0)
  end                                                          as on_time_pct,
  coalesce(d.lead_samples, 0)                                  as lead_samples,
  round(d.avg_lead_days::numeric, 1)                           as avg_lead_days,
  coalesce(x.open_exceptions, 0)                               as open_exceptions,
  coalesce(x.exceptions_window, 0)                             as exceptions_window,
  coalesce(x.exceptions_lifetime, 0)                           as exceptions_lifetime,
  coalesce(c.open_credits, 0)                                  as open_credits,
  coalesce(c.open_credits_amount, 0)::numeric(12,2)            as open_credits_amount,
  coalesce(c.credits_window, 0)                                as credits_window,
  coalesce(c.credits_lifetime, 0)                              as credits_lifetime,
  coalesce(p.priced_items, 0)                                  as priced_items,
  coalesce(p.price_changes_window, 0)                          as price_changes_window,
  p.last_price_change
from suppliers s
left join d on d.supplier_id = s.id
left join x on x.supplier_id = s.id
left join c on c.supplier_id = s.id
left join p on p.supplier_id = s.id
where s.org_id = auth_org()
  and s.deleted_at is null
  and auth_role() in ('owner','office','kitchen','accountant');

-- אימות מיד אחרי ההרצה (scripts/db-query.ps1):
--   select supplier_id, on_time_pct, otd_samples, avg_lead_days, open_exceptions, open_credits
--   from supplier_metrics order by on_time_pct nulls last limit 10;
-- מצופה: on_time_pct לא-null רק עבור הזמנות ה-seed (demo/demo_seed.sql:299) —
-- ההוכחה הישירה שהמדד מציג — ולא 0% כשאין expected_date. ערך לא-null גורף = באג.
--
-- ולוודא שה-self-check של 0005:95-113 עדיין עובר: supplier_metrics אינו חושף עמודת org_id.
