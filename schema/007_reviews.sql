-- §7 Post-payment review prompt. The review itself is the review_submitted
-- event; ratings <= 2 raise a dashboard notification for the restaurant.
CREATE TABLE notifications (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants,
  kind            text NOT NULL,          -- low_rating | incomplete_item | ...
  detail          jsonb NOT NULL DEFAULT '{}',
  audience        text NOT NULL DEFAULT 'restaurant' CHECK (audience IN ('restaurant','admin')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  seen_at         timestamptz
);
CREATE INDEX ON notifications (restaurant_id, audience, seen_at);

CREATE OR REPLACE FUNCTION flag_low_rating() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type = 'review_submitted' AND (NEW.payload->>'rating')::int <= 2 THEN
    INSERT INTO notifications (restaurant_id, kind, detail)
    VALUES (NEW.restaurant_id, 'low_rating', jsonb_build_object('event_id', NEW.event_id, 'table_id', NEW.table_id,
            'rating', NEW.payload->'rating', 'comment', NEW.payload->'comment'));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER events_low_rating AFTER INSERT ON events FOR EACH ROW EXECUTE FUNCTION flag_low_rating();
