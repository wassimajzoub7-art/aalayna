-- §4 Currency and FX per transaction. restaurants.fx_rate lives in 001_menu.sql.
-- Every order and payment stores all four: currency (raw), amount (raw),
-- fx_rate_used (rate at that moment), amount_usd (normalised). Never only the
-- converted number. Analytics run on amount_usd.
CREATE OR REPLACE FUNCTION set_fx_rate(p_restaurant uuid, p_rate numeric, p_user uuid) RETURNS void AS $$
  UPDATE restaurants SET fx_rate = p_rate, fx_rate_updated_at = now(), fx_rate_updated_by = p_user
  WHERE restaurant_id = p_restaurant AND p_rate BETWEEN 1000 AND 10000000;
$$ LANGUAGE sql;

-- Stale-rate flag used by the health check (§9): older than 14 days.
CREATE VIEW restaurant_fx_status AS
  SELECT restaurant_id, fx_rate, fx_rate_updated_at,
         fx_rate_updated_at IS NULL OR fx_rate_updated_at < now() - interval '14 days' AS stale
  FROM restaurants;
