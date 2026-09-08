-- §8 Menu editor permission tiers and the edit log.
--   Tier 1 (any restaurant user): price, availability (86), description.
--   Tier 2 (allowed, guarded): create item, rename, category changes. New items
--          without ingredients are status='incomplete' (derived in 001): visible on
--          the menu, excluded from filters, badged on the dashboard, admin notified.
--   Tier 3 (system only): item ids, archive semantics.
CREATE TABLE staff_users (
  user_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants,
  name          text NOT NULL,
  tier          smallint NOT NULL DEFAULT 1 CHECK (tier IN (1,2)),   -- 3 is never a user
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE edit_log (
  edit_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  who           uuid,                              -- staff_users.user_id; NULL = system
  restaurant_id uuid NOT NULL REFERENCES restaurants,
  entity_type   text NOT NULL,                     -- item | section | restaurant
  entity_id     uuid NOT NULL,
  field         text NOT NULL,
  old_value     jsonb,
  new_value     jsonb,
  tier          smallint NOT NULL,
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON edit_log (restaurant_id, at);

-- Field -> tier map, enforced in the API layer before the write and recorded here.
CREATE TABLE field_tiers (field text PRIMARY KEY, tier smallint NOT NULL);
INSERT INTO field_tiers VALUES
  ('price_cents',1),('available',1),('description',1),
  ('name',2),('category_id',2),('created',2),('image_url',2),('ingredients',2),('allergens',2),
  ('kcal',2),('protein_g',2),('fat_g',2),('carbs_g',2),('options',2),('translations',2),('allergens_confirmed',2),
  ('archived_at',3),('item_id',3);

-- Admin notification when an item is created or edited into the incomplete state.
CREATE OR REPLACE FUNCTION notify_incomplete_item() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'incomplete' AND (TG_OP = 'INSERT' OR OLD.status <> 'incomplete') THEN
    INSERT INTO notifications (restaurant_id, kind, audience, detail)
    VALUES (NEW.restaurant_id, 'incomplete_item', 'admin', jsonb_build_object('item_id', NEW.item_id, 'name', NEW.name));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER menu_items_incomplete AFTER INSERT OR UPDATE OF ingredients ON menu_items
  FOR EACH ROW EXECUTE FUNCTION notify_incomplete_item();
-- UI rule (not enforceable in SQL): the allergen filter carries the permanent
-- disclaimer "Always confirm allergies with staff."
