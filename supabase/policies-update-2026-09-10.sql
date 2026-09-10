-- The key from the request header, and the role it grants for a venue.
create or replace function aal_key() returns text language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json->>'x-aalayna-key', '')
$$;
-- The phone's device id (a weak identifier): a guest may read back only the rows
-- their own device wrote, which is what an upsert needs to check for conflicts.
create or replace function aal_device() returns text language sql stable as $$
  select coalesce(current_setting('request.headers', true)::json->>'x-aalayna-device', '')
$$;
create or replace function aal_role(rid text) returns text language sql stable security definer as $$
  select case
    when exists (select 1 from venue_keys v where v.restaurant_id = rid and v.owner_key = aal_key() and aal_key() <> '') then 'owner'
    when exists (select 1 from venue_keys v where v.restaurant_id = rid and v.guest_key = aal_key() and aal_key() <> '') then 'guest'
    else null end
$$;
revoke all on venue_keys from anon, authenticated;

alter table kv_docs enable row level security;
alter table kv_rows enable row level security;

drop policy if exists docs_read on kv_docs;
create policy docs_read on kv_docs for select
  using (aal_role(restaurant_id) in ('owner','guest'));
drop policy if exists docs_write on kv_docs;
create policy docs_write on kv_docs for all
  using (aal_role(restaurant_id) = 'owner') with check (aal_role(restaurant_id) = 'owner');

-- Guests: read bill state, plus only their own device's events and sign-ups;
-- never another guest's contact details or the venue's event stream.
drop policy if exists rows_read on kv_rows;
create policy rows_read on kv_rows for select
  using (aal_role(restaurant_id) = 'owner'
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.checks','aal.settle'))
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.events','aal.guests')
          and aal_device() <> '' and body->>'deviceId' = aal_device()));
drop policy if exists rows_insert on kv_rows;
create policy rows_insert on kv_rows for insert
  with check (aal_role(restaurant_id) = 'owner'
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.checks','aal.settle','aal.events','aal.guests')));
drop policy if exists rows_update on kv_rows;
create policy rows_update on kv_rows for update
  using (aal_role(restaurant_id) = 'owner'
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.checks','aal.settle'))
      or (aal_role(restaurant_id) = 'guest' and collection = 'aal.guests' and aal_device() <> '' and body->>'deviceId' = aal_device()))
  with check (aal_role(restaurant_id) = 'owner'
      or (aal_role(restaurant_id) = 'guest' and collection in ('aal.checks','aal.settle'))
      or (aal_role(restaurant_id) = 'guest' and collection = 'aal.guests' and aal_device() <> '' and body->>'deviceId' = aal_device()));
drop policy if exists rows_delete on kv_rows;
create policy rows_delete on kv_rows for delete
  using (aal_role(restaurant_id) = 'owner');

grant select, insert, update, delete on kv_docs, kv_rows to anon;
