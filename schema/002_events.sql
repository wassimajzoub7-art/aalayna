-- §2 Event log. Single append-only table. Never UPDATE or DELETE rows;
-- the one sanctioned write-back is customer_id backfill by the identity layer (§5).
CREATE TABLE events (
  event_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid,
  session_id    uuid NOT NULL,
  restaurant_id uuid NOT NULL REFERENCES restaurants,
  table_id      text,
  customer_id   uuid,            -- nullable; backfilled by identity linking
  event_type    text NOT NULL CHECK (event_type IN (
                  'qr_scan','item_view','bill_requested','order_placed','payment_completed',
                  'payment_refunded','payment_cancelled','receipt_requested','review_submitted','ui_action')),
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON events (restaurant_id, created_at);
CREATE INDEX ON events (device_id);
CREATE INDEX ON events (session_id);
CREATE INDEX ON events (restaurant_id, event_type, created_at);

-- payment events must carry a rail
ALTER TABLE events ADD CONSTRAINT payment_events_have_rail CHECK (
  event_type NOT IN ('payment_completed','payment_refunded','payment_cancelled')
  OR payload->>'rail' IN ('whish','card','cash','other'));

-- append-only: only customer_id may change, and only from NULL
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'events are never deleted'; END IF;
  IF OLD.customer_id IS NOT NULL OR
     to_jsonb(NEW) - 'customer_id' <> to_jsonb(OLD) - 'customer_id' THEN
    RAISE EXCEPTION 'events are append-only (customer_id backfill excepted)';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();

-- Event payloads (v1):
--   qr_scan            {table_id, user_agent}                              client
--   item_view          {item_id, category_id, dwell_ms?}                   client
--   bill_requested     {}                                                  client (turnover metric, §10)
--   order_placed       {order_id, items:[{item_id,qty,unit_price,currency}], total, currency, fx_rate_used, amount_usd}   server
--   payment_completed  {order_id, payment_request_id, amount, currency, fx_rate_used, amount_usd, rail, payer_ref?, tip?} server
--   receipt_requested  {channel: email|whatsapp, contact_hash}             server
--   review_submitted   {rating, comment?}                                  server
--   ui_action          {action, value}  language, currency, filter, split, tip, rail, note, option   client
