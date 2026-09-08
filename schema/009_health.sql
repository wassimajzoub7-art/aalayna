-- §9 Weekly data-health check, one row per restaurant per ISO week.
CREATE TABLE health_reports (
  restaurant_id uuid NOT NULL REFERENCES restaurants,
  week          text NOT NULL,                 -- e.g. 2026-W36
  computed_at   timestamptz NOT NULL DEFAULT now(),
  checks        jsonb NOT NULL,                -- [{key,label,value,flag}]
  issues        int NOT NULL,
  PRIMARY KEY (restaurant_id, week)
);

CREATE OR REPLACE FUNCTION compute_health(p_restaurant uuid) RETURNS jsonb AS $$
  WITH live AS (SELECT * FROM menu_items WHERE restaurant_id = p_restaurant AND archived_at IS NULL),
  viewed AS (SELECT DISTINCT (payload->>'item_id')::uuid AS item_id FROM events
             WHERE restaurant_id = p_restaurant AND event_type = 'item_view' AND created_at > now() - interval '30 days'),
  pays AS (SELECT customer_id FROM events WHERE restaurant_id = p_restaurant AND event_type = 'payment_completed'
           AND created_at > now() - interval '30 days'),
  fx AS (SELECT stale FROM restaurant_fx_status WHERE restaurant_id = p_restaurant),
  menu_touch AS (SELECT max(at) AS at FROM edit_log WHERE restaurant_id = p_restaurant),
  archived_orders AS (
    SELECT count(*) AS n FROM events e, jsonb_array_elements(e.payload->'items') i
    JOIN menu_items m ON m.item_id = (i->>'item_id')::uuid
    WHERE e.restaurant_id = p_restaurant AND e.event_type = 'order_placed'
      AND m.archived_at IS NOT NULL AND e.created_at >= m.archived_at)
  SELECT jsonb_build_array(
    jsonb_build_object('key','incomplete_items','value',(SELECT count(*) FROM live WHERE status='incomplete'),
                       'flag',(SELECT count(*) FROM live WHERE status='incomplete') > 0),
    jsonb_build_object('key','unviewed_items','value',(SELECT count(*) FROM live WHERE item_id NOT IN (SELECT item_id FROM viewed)),
                       'flag',(SELECT count(*) FROM live WHERE item_id NOT IN (SELECT item_id FROM viewed)) > 0),
    jsonb_build_object('key','stale_rate','value',(SELECT stale FROM fx),'flag',(SELECT stale FROM fx)),
    jsonb_build_object('key','orders_on_archived','value',(SELECT n FROM archived_orders),'flag',(SELECT n FROM archived_orders) > 0),
    jsonb_build_object('key','identity_capture',
                       'value',(SELECT CASE WHEN count(*)=0 THEN NULL ELSE count(customer_id)::float/count(*) END FROM pays),
                       'flag',(SELECT count(*) > 0 AND count(customer_id)::float/count(*) < 0.1 FROM pays)),
    jsonb_build_object('key','menu_untouched','value',(SELECT at FROM menu_touch),
                       'flag',(SELECT count(*) > 0 FROM pays) AND (SELECT at < now() - interval '60 days' FROM menu_touch))
  );
$$ LANGUAGE sql;

-- Cron (weekly, per restaurant):
--   INSERT INTO health_reports (restaurant_id, week, checks, issues)
--   SELECT r.restaurant_id, to_char(now(),'IYYY-"W"IW'), c, (SELECT count(*) FROM jsonb_array_elements(c) x WHERE (x->>'flag')::bool)
--   FROM restaurants r, LATERAL compute_health(r.restaurant_id) c
--   ON CONFLICT (restaurant_id, week) DO UPDATE SET checks = EXCLUDED.checks, issues = EXCLUDED.issues, computed_at = now();
CREATE VIEW admin_health_ranking AS
  SELECT h.*, r.name FROM health_reports h JOIN restaurants r USING (restaurant_id)
  WHERE week = to_char(now(),'IYYY-"W"IW') ORDER BY issues DESC;
