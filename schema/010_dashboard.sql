-- §10 Dashboard v2 metrics from the event stream, on amount_usd, per restaurant,
-- parameterised by a date range (:from, :to).

-- Scan -> payment conversion (sessions with payment_completed / sessions with qr_scan).
-- order_placed fires for every check in this product (no ordering), so payment is the conversion.
CREATE OR REPLACE FUNCTION scan_conversion(p_restaurant uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (scans bigint, paid bigint, rate float) AS $$
  WITH s AS (SELECT DISTINCT session_id FROM events WHERE restaurant_id=p_restaurant AND event_type='qr_scan' AND created_at BETWEEN p_from AND p_to),
       p AS (SELECT DISTINCT session_id FROM events WHERE restaurant_id=p_restaurant AND event_type='payment_completed' AND created_at BETWEEN p_from AND p_to)
  SELECT (SELECT count(*) FROM s), (SELECT count(*) FROM s JOIN p USING (session_id)),
         CASE WHEN (SELECT count(*) FROM s)=0 THEN NULL ELSE (SELECT count(*) FROM s JOIN p USING (session_id))::float/(SELECT count(*) FROM s) END;
$$ LANGUAGE sql;

-- Viewed-never-ordered items, top 10 by views, 30 days.
CREATE OR REPLACE FUNCTION viewed_never_ordered(p_restaurant uuid) RETURNS TABLE (item_id uuid, name text, views bigint) AS $$
  WITH v AS (SELECT (payload->>'item_id')::uuid AS item_id, count(*) AS views FROM events
             WHERE restaurant_id=p_restaurant AND event_type='item_view' AND created_at > now()-interval '30 days' GROUP BY 1),
       o AS (SELECT DISTINCT (i->>'item_id')::uuid AS item_id FROM events e, jsonb_array_elements(e.payload->'items') i
             WHERE e.restaurant_id=p_restaurant AND e.event_type='order_placed' AND e.created_at > now()-interval '30 days')
  SELECT v.item_id, m.name, v.views FROM v JOIN menu_items m USING (item_id)
  WHERE v.item_id NOT IN (SELECT item_id FROM o) ORDER BY v.views DESC LIMIT 10;
$$ LANGUAGE sql;

-- Cash vs digital split by rail, on amount_usd.
CREATE OR REPLACE FUNCTION rail_split(p_restaurant uuid, p_from timestamptz, p_to timestamptz)
RETURNS TABLE (rail text, amount_usd numeric) AS $$
  SELECT payload->>'rail', sum((payload->>'amount_usd')::numeric) FROM events
  WHERE restaurant_id=p_restaurant AND event_type='payment_completed' AND created_at BETWEEN p_from AND p_to GROUP BY 1;
$$ LANGUAGE sql;

-- Repeat-device rate: sessions whose device was seen before the session started.
CREATE OR REPLACE FUNCTION repeat_device_rate(p_restaurant uuid, p_from timestamptz, p_to timestamptz) RETURNS float AS $$
  WITH s AS (SELECT session_id, device_id, min(created_at) AS started FROM events
             WHERE restaurant_id=p_restaurant AND created_at BETWEEN p_from AND p_to GROUP BY 1,2),
       first AS (SELECT device_id, min(created_at) AS first_seen FROM events WHERE restaurant_id=p_restaurant GROUP BY 1)
  SELECT CASE WHEN count(*)=0 THEN NULL ELSE count(*) FILTER (WHERE f.first_seen < s.started)::float/count(*) END
  FROM s JOIN first f USING (device_id);
$$ LANGUAGE sql;

-- Median seconds from bill_requested to payment_completed within a session (turnover proof).
CREATE OR REPLACE FUNCTION median_bill_to_payment(p_restaurant uuid, p_from timestamptz, p_to timestamptz) RETURNS float AS $$
  WITH b AS (SELECT session_id, min(created_at) AS at FROM events WHERE restaurant_id=p_restaurant AND event_type='bill_requested' AND created_at BETWEEN p_from AND p_to GROUP BY 1),
       p AS (SELECT session_id, min(created_at) AS at FROM events WHERE restaurant_id=p_restaurant AND event_type='payment_completed' AND created_at BETWEEN p_from AND p_to GROUP BY 1)
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM p.at - b.at)) FROM b JOIN p USING (session_id) WHERE p.at >= b.at;
$$ LANGUAGE sql;

-- Identity capture rate (identified payment_completed / all payment_completed).
CREATE OR REPLACE FUNCTION identity_capture_rate(p_restaurant uuid, p_from timestamptz, p_to timestamptz) RETURNS float AS $$
  SELECT CASE WHEN count(*)=0 THEN NULL ELSE count(customer_id)::float/count(*) END FROM events
  WHERE restaurant_id=p_restaurant AND event_type='payment_completed' AND created_at BETWEEN p_from AND p_to;
$$ LANGUAGE sql;
