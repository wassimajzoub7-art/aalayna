-- §3 Device token. A weak identifier (Safari ITP wipes storage after 7 idle days,
-- in-app browsers isolate it): a linkage signal, never a customer.
-- Client: localStorage 'device_id' mirrored by a first-party cookie (1 year, SameSite=Lax);
-- whichever store still has it restores the other on load. Sent on every API call.
CREATE TABLE devices (
  device_id  uuid PRIMARY KEY,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen  timestamptz NOT NULL DEFAULT now()
);
-- upsert on every contact:
--   INSERT INTO devices (device_id) VALUES ($1)
--   ON CONFLICT (device_id) DO UPDATE SET last_seen = now();
