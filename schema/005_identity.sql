-- §5 Identity layer. Keys are normalised (E.164 phones, lower-cased emails) and
-- hashed at rest; the Whish payer_ref enters as key_type 'wallet_id' (strong key).
CREATE TABLE identities (
  customer_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE identity_keys (
  key_type    text NOT NULL CHECK (key_type IN ('phone','email','wallet_id','card_fingerprint')),
  key_value   text NOT NULL,   -- sha256(normalised value)
  customer_id uuid NOT NULL REFERENCES identities,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_type, key_value)
);
CREATE INDEX ON identity_keys (customer_id);
CREATE TABLE device_links (
  device_id   uuid NOT NULL REFERENCES devices,
  customer_id uuid NOT NULL REFERENCES identities,
  linked_at   timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL CHECK (source IN ('receipt','payment','review')),
  PRIMARY KEY (device_id, customer_id)
);
CREATE TABLE identity_merges (
  merge_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_customer uuid NOT NULL,
  into_customer uuid NOT NULL REFERENCES identities,
  merged_at    timestamptz NOT NULL DEFAULT now(),
  reason       text
);

-- Linking flow, one transaction:
--  1. look up each normalised key in identity_keys
--  2. miss -> create identity + key; hit -> reuse customer_id
--  3. two keys, two customers -> merge: pick the survivor, repoint identity_keys,
--     device_links, events.customer_id, payment_requests.customer_id; log the merge
--  4. upsert device_links (device_id, survivor)
--  5. retroactive attribution:
--       UPDATE events SET customer_id = :cid WHERE device_id = :did AND customer_id IS NULL;
CREATE OR REPLACE FUNCTION merge_identities(p_from uuid, p_into uuid, p_reason text) RETURNS void AS $$
BEGIN
  UPDATE identity_keys SET customer_id = p_into WHERE customer_id = p_from;
  UPDATE device_links SET customer_id = p_into WHERE customer_id = p_from
    AND NOT EXISTS (SELECT 1 FROM device_links d WHERE d.device_id = device_links.device_id AND d.customer_id = p_into);
  DELETE FROM device_links WHERE customer_id = p_from;
  -- events are append-only except this backfill; the trigger allows NULL -> value only,
  -- so merges repoint through a privileged path:
  ALTER TABLE events DISABLE TRIGGER events_append_only;
  UPDATE events SET customer_id = p_into WHERE customer_id = p_from;
  ALTER TABLE events ENABLE TRIGGER events_append_only;
  UPDATE payment_requests SET customer_id = p_into WHERE customer_id = p_from;
  INSERT INTO identity_merges (from_customer, into_customer, reason) VALUES (p_from, p_into, p_reason);
  DELETE FROM identities WHERE customer_id = p_from;
END $$ LANGUAGE plpgsql;
