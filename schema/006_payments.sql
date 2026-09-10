-- §6 Payment orchestration, direct-to-merchant. Aalayna initiates, the
-- restaurant's own account settles, the provider confirms via webhook.
-- Payment links are check/session-scoped, never static per table.
CREATE TABLE orders (                       -- the check; comes from the waiter / POS
  order_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants,
  session_id    uuid,
  table_id      text NOT NULL,
  pos_check_ref text,
  total_cents   bigint NOT NULL CHECK (total_cents > 0),
  currency      char(3) NOT NULL DEFAULT 'USD',
  fx_rate_used  numeric(12,2) NOT NULL,
  amount_usd    numeric(14,2) NOT NULL,
  amount_remaining_cents bigint NOT NULL,   -- maintained by confirmations; order closes at <= 0
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE TABLE order_items (
  order_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES orders,
  item_id       uuid NOT NULL REFERENCES menu_items,   -- archived items stay resolvable
  qty           int NOT NULL CHECK (qty > 0),
  unit_price_cents bigint NOT NULL,
  claimed_qty   int NOT NULL DEFAULT 0 CHECK (claimed_qty >= 0 AND claimed_qty <= qty)  -- split-by-item locks (§6b)
);

CREATE TABLE payment_requests (
  payment_request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL,
  device_id     uuid,
  order_id      uuid NOT NULL REFERENCES orders,
  restaurant_id uuid NOT NULL REFERENCES restaurants,
  customer_id   uuid REFERENCES identities,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),   -- bill principal
  tip_cents     bigint NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  currency      char(3) NOT NULL DEFAULT 'USD',
  fx_rate_used  numeric(12,2) NOT NULL,
  amount_usd    numeric(14,2) NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','completed','failed','expired','cancelled','refunded')),
  rail          text NOT NULL CHECK (rail IN ('whish','card','cash','other')),
  external_ref  text UNIQUE,                 -- provider transaction id; dedupe key for callbacks
  payer_ref_hash text,                       -- hashed Whish wallet id -> identity_keys('wallet_id')
  cash_note_cents bigint,                    -- declared note for cash requests
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  refunded_at   timestamptz
);
CREATE INDEX ON payment_requests (order_id);
CREATE INDEX ON payment_requests (restaurant_id, status, created_at);

-- §6b split by item: which units a request claims. First commit wins; the
-- second phone gets a refreshed state (the UPDATE below fails its check).
CREATE TABLE payment_request_items (
  payment_request_id uuid NOT NULL REFERENCES payment_requests,
  order_item_id      uuid NOT NULL REFERENCES order_items,
  qty                int NOT NULL CHECK (qty > 0),
  PRIMARY KEY (payment_request_id, order_item_id)
);
-- claim inside the same transaction that inserts the request:
--   UPDATE order_items SET claimed_qty = claimed_qty + :qty
--   WHERE order_item_id = :id AND claimed_qty + :qty <= qty;   -- 0 rows -> conflict, refresh

-- Raw provider callbacks, always logged before processing. Idempotent on external_ref.
CREATE TABLE webhook_log (
  webhook_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider     text NOT NULL,
  external_ref text,
  payment_request_id uuid,
  signature_ok boolean,
  body         jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);

-- Cash is a first-class path: waiter/owner marks the request paid from their
-- flow (or end-of-shift reconcile); it emits the same payment_completed event
-- with rail='cash'.
CREATE OR REPLACE FUNCTION complete_payment(p_request uuid, p_external_ref text, p_payer_ref_hash text)
RETURNS payment_requests AS $$
DECLARE r payment_requests;
BEGIN
  SELECT * INTO r FROM payment_requests WHERE payment_request_id = p_request FOR UPDATE;
  IF r.status = 'completed' AND r.external_ref IS NOT DISTINCT FROM p_external_ref THEN RETURN r; END IF;  -- duplicate callback
  IF r.status <> 'pending' THEN RAISE EXCEPTION 'request % is %', p_request, r.status; END IF;
  UPDATE payment_requests SET status = 'completed', completed_at = now(),
         external_ref = p_external_ref, payer_ref_hash = COALESCE(p_payer_ref_hash, payer_ref_hash)
   WHERE payment_request_id = p_request RETURNING * INTO r;
  UPDATE orders SET amount_remaining_cents = amount_remaining_cents - r.amount_cents,
         closed_at = CASE WHEN amount_remaining_cents - r.amount_cents <= 0 THEN now() ELSE closed_at END
   WHERE order_id = r.order_id;
  INSERT INTO events (device_id, session_id, restaurant_id, table_id, customer_id, event_type, payload)
  SELECT r.device_id, r.session_id, r.restaurant_id, o.table_id, r.customer_id, 'payment_completed',
         jsonb_build_object('order_id', r.order_id, 'payment_request_id', r.payment_request_id,
           'amount', r.amount_cents / 100.0, 'currency', r.currency, 'fx_rate_used', r.fx_rate_used,
           'amount_usd', r.amount_usd, 'rail', r.rail, 'payer_ref', r.payer_ref_hash, 'tip', r.tip_cents / 100.0)
  FROM orders o WHERE o.order_id = r.order_id;
  RETURN r;
END $$ LANGUAGE plpgsql;
