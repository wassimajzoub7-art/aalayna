-- §1 Stable item IDs. Ids are minted once; rename touches `name`, delete sets
-- `archived_at`. Nothing that an event, order line or claim references is ever
-- hard-deleted (the trigger below refuses it).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE restaurants (
  restaurant_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  place              text,
  fx_rate            numeric(12,2) NOT NULL DEFAULT 89500,   -- LBP per USD, house rate (§4)
  fx_rate_updated_at timestamptz,
  fx_rate_updated_by uuid,                                   -- staff_users.user_id (§8)
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE menu_categories (
  category_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  uuid NOT NULL REFERENCES restaurants,
  name           text NOT NULL,
  service_window text NOT NULL DEFAULT 'all',   -- all | brkf | lunch | dinner
  position       int  NOT NULL DEFAULT 0,
  archived_at    timestamptz
);

CREATE TABLE menu_items (
  item_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- immutable
  restaurant_id uuid NOT NULL REFERENCES restaurants,
  category_id   uuid NOT NULL REFERENCES menu_categories,
  name          text NOT NULL,                                 -- the only thing a rename changes
  description   text NOT NULL DEFAULT '',
  image_url     text,
  price_cents   bigint NOT NULL CHECK (price_cents >= 0),
  currency      char(3) NOT NULL DEFAULT 'USD',
  available     boolean NOT NULL DEFAULT true,                 -- the 86 toggle (tier 1)
  status        text NOT NULL DEFAULT 'incomplete'
                CHECK (status IN ('complete','incomplete')),   -- incomplete = no ingredient record (§8)
  ingredients   text[] NOT NULL DEFAULT '{}',
  allergens     text[] NOT NULL DEFAULT '{}',
  kcal          int, protein_g numeric(6,1), fat_g numeric(6,1), carbs_g numeric(6,1),
  allergens_confirmed boolean NOT NULL DEFAULT false,
  options       jsonb NOT NULL DEFAULT '[]',                   -- option groups, same shape as the prototype
  translations  jsonb NOT NULL DEFAULT '{}',
  archived_at   timestamptz,                                   -- soft delete; NULL = live
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON menu_items (restaurant_id) WHERE archived_at IS NULL;

-- status is derived, never hand-set
CREATE OR REPLACE FUNCTION menu_items_derive() RETURNS trigger AS $$
BEGIN
  NEW.status := CASE WHEN cardinality(NEW.ingredients) > 0 THEN 'complete' ELSE 'incomplete' END;
  NEW.updated_at := now();
  IF TG_OP = 'UPDATE' AND NEW.item_id <> OLD.item_id THEN
    RAISE EXCEPTION 'item_id is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER menu_items_derive BEFORE INSERT OR UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION menu_items_derive();

-- Hard deletes are refused outright; archive instead.
CREATE OR REPLACE FUNCTION refuse_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'rows in % are archived, never deleted', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;
CREATE TRIGGER menu_items_no_delete BEFORE DELETE ON menu_items FOR EACH ROW EXECUTE FUNCTION refuse_delete();

-- Guest-facing view: published, live, not archived.
CREATE VIEW guest_menu_items AS
  SELECT * FROM menu_items WHERE archived_at IS NULL;
