-- Connecting a payment provider from admin.html, 2026-11-24.
--
-- Run after payment-start-2026-10-14.sql and review-fixes-2026-11-10.sql (and every file
-- before them), in the Supabase SQL editor. Independent of webhook-venues-2026-11-24.sql: it
-- works whether that file has run or not, before or after it. Tested against PGlite
-- (tests/payment-connect-sql.test.cjs with PGLITE_MODULE set), with and without a stand-in
-- for Supabase Vault; not yet run against the live project.
--
-- Safe to re-run: one transaction; "create or replace function", grants and revokes only. No
-- table, row, policy or existing function changes; aal_payment_provider is not touched. It
-- stops without changing anything if payment-start-2026-10-14.sql or admin.sql has not been
-- applied.
--
-- Until now a venue's provider was connected by hand in the SQL editor
-- (vault.create_secret, then an insert into payment_providers). These functions do the same
-- from admin.html's Payments block, with the admin key, and keep the credentials in Vault.
--
-- What it adds (each aal_admin_* function checks the admin key first, exactly as admin.sql's
-- do, and raises 'Admin key required.'; called by admin.html at /rest/v1/rpc/<name> with
-- x-aalayna-admin)
--   aal_admin_list_payment_providers(p_rid)
--                          the venue's payment_providers rows, card first, as a jsonb array.
--                          Every column of the row comes through as it is (to_jsonb), so a
--                          column added later (webhook_route, webhook-venues-2026-11-24.sql)
--                          appears without changing this file, plus has_secret: true when
--                          secret_name names a secret that is in Vault. The secret itself
--                          is never read here; only aal_payment_provider (service role)
--                          decrypts it.
--   aal_admin_set_payment_provider(p_rid, p_rail, p_provider, p_config, p_secret, p_enabled)
--                          insert or update the (venue, rail) row and answer it as the list
--                          does. p_config null keeps the current config ({} for a new row);
--                          otherwise a small JSON object: at most 20 keys (a letter, then
--                          letters, digits or _; up to 40), values a string up to 300
--                          characters, a number, true, false or null, 2,000 characters in
--                          all. p_secret null keeps the current secret; otherwise (1 to 4,000
--                          characters) it is written to Vault: the secret the row already
--                          names is updated, or a new one is created with the name
--                          aalayna_pay_<rail>_<md5 of the venue id> (deterministic, letters,
--                          digits and _ only) and stored in secret_name. Changing p_provider
--                          without a new secret drops the old provider's secret (it belongs
--                          to another account). p_enabled null keeps the current flag (true
--                          for a new row). The secret is never answered, raised or logged;
--                          no error message carries it. Without Vault a call that passes a
--                          secret raises 'Supabase Vault is not available ...' and changes
--                          nothing; a call without one still works.
--   aal_admin_remove_payment_provider(p_rid, p_rail)
--                          DELETES the row (not a disable: admin.html disables through
--                          aal_admin_set_payment_provider with p_enabled false) and the Vault
--                          secret it names, unless another row names the same secret.
--                          Answers {removed: true|false}. With no row the rail falls back as
--                          before: the fake provider while demo payments are on, otherwise
--                          not offered.
--   aal_admin_key_valid(p_key)
--                          true when p_key is in admin_keys. Service role only: the way the
--                          payment-start function checks the x-aalayna-admin header of POST
--                          /payment-start/admin/check before it runs a provider's connection
--                          test, without trusting the header's shape alone.
--   aal_admin_payment_secret_name, aal_admin_vault_has, aal_admin_vault_drop,
--   aal_admin_payment_provider_json
--                          internal helpers, callable only inside the functions above.
--
-- Demo payments: admin.html offers real provider rows only once a venue's demo payments are
-- off. These functions do not enforce it: a row and demo payments can coexist, and the
-- function then takes the row (a row naming fake only while demo payments are on).

begin;
do $$ begin
 if to_regclass('public.payment_providers') is null or to_regprocedure('public.aal_payment_provider(text,text)') is null then
  raise exception 'Run payment-start-2026-10-14.sql before payment-connect-2026-11-24.sql';
 end if;
 if to_regprocedure('public.aal_is_admin()') is null or to_regclass('public.admin_keys') is null then
  raise exception 'Run admin.sql before payment-connect-2026-11-24.sql';
 end if;
end $$;

-- ---------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------

-- The Vault name for a venue's credentials on one rail: deterministic, and safe for the
-- secret_name check (^[A-Za-z0-9_.-]{1,120}$) whatever the venue id holds.
create or replace function public.aal_admin_payment_secret_name(p_rid text, p_rail text) returns text
language sql immutable set search_path = public, extensions, pg_temp as $$
  select 'aalayna_pay_' || p_rail || '_' || md5(p_rid)
$$;

-- Whether Vault holds a secret by that name; false without Vault.
create or replace function public.aal_admin_vault_has(p_name text) returns boolean
language plpgsql stable set search_path = public, extensions, pg_temp as $$
declare n int;
begin
 if p_name is null or to_regclass('vault.secrets') is null then return false; end if;
 execute 'select count(*) from vault.secrets where name = $1' into n using p_name;
 return n > 0;
end $$;

-- Remove a Vault secret by name, unless a payment_providers row still names it.
create or replace function public.aal_admin_vault_drop(p_name text) returns void
language plpgsql volatile set search_path = public, extensions, pg_temp as $$
begin
 if p_name is null or to_regclass('vault.secrets') is null then return; end if;
 if exists (select 1 from public.payment_providers where secret_name = p_name) then return; end if;
 execute 'delete from vault.secrets where name = $1' using p_name;
end $$;

-- One row as admin.html shows it: every column, plus has_secret. Null when there is no row.
create or replace function public.aal_admin_payment_provider_json(p_rid text, p_rail text) returns jsonb
language sql stable set search_path = public, extensions, pg_temp as $$
  select to_jsonb(r) || jsonb_build_object('has_secret', public.aal_admin_vault_has(r.secret_name))
    from public.payment_providers r
   where r.restaurant_id = p_rid and r.rail = p_rail
$$;

-- ---------------------------------------------------------------------------
-- API for admin.html (admin key in x-aalayna-admin)
-- ---------------------------------------------------------------------------
create or replace function public.aal_admin_list_payment_providers(p_rid text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
begin
 if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
 return coalesce((select jsonb_agg(public.aal_admin_payment_provider_json(r.restaurant_id, r.rail)
                                   order by case r.rail when 'card' then 0 else 1 end)
                    from public.payment_providers r where r.restaurant_id = p_rid), '[]'::jsonb);
end $$;

create or replace function public.aal_admin_set_payment_provider(p_rid text, p_rail text, p_provider text, p_config jsonb, p_secret text, p_enabled boolean)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare
 cur    public.payment_providers%rowtype;
 found_ boolean;
 v_cfg  jsonb;
 v_name text;
 v_old  text;
 v_id   uuid;
 k      text;
 val    jsonb;
begin
 if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
 if not exists (select 1 from public.venue_keys where restaurant_id = p_rid) then raise exception 'Unknown venue.'; end if;
 if p_rail is null or p_rail not in ('card', 'whish') then raise exception 'Rail must be card or whish.'; end if;
 if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{0,39}$' then
  raise exception 'Provider must be an adapter name: a lower-case letter, then lower-case letters, digits or _, up to 40.';
 end if;

 -- the config: a small object of plain values
 if p_config is not null then
  if jsonb_typeof(p_config) <> 'object' then raise exception 'Config must be a JSON object.'; end if;
  if length(p_config::text) > 2000 then raise exception 'Config is over 2,000 characters.'; end if;
  if (select count(*) from jsonb_object_keys(p_config)) > 20 then raise exception 'Config has more than 20 keys.'; end if;
  for k, val in select * from jsonb_each(p_config) loop
   if k !~ '^[A-Za-z][A-Za-z0-9_]{0,39}$' then
    raise exception 'Config keys start with a letter and use letters, digits and _ only, up to 40.';
   end if;
   if jsonb_typeof(val) not in ('string', 'number', 'boolean', 'null') then
    raise exception 'Config value % must be text, a number, true, false or null.', k;
   end if;
   if jsonb_typeof(val) = 'string' and length(val #>> '{}') > 300 then
    raise exception 'Config value % is over 300 characters.', k;
   end if;
  end loop;
 end if;

 -- the secret: checked without ever being echoed
 if p_secret is not null then
  if length(p_secret) < 1 or length(p_secret) > 4000 or btrim(p_secret) = '' then
   raise exception 'Credentials must be 1 to 4,000 characters.';
  end if;
  if to_regclass('vault.secrets') is null or to_regclass('vault.decrypted_secrets') is null then
   raise exception 'Supabase Vault is not available on this database, so credentials cannot be stored. Enable the supabase_vault extension (Database, Extensions), or save the provider without credentials.';
  end if;
 end if;

 select * into cur from public.payment_providers where restaurant_id = p_rid and rail = p_rail for update;
 found_ := found;

 v_cfg := coalesce(p_config, case when found_ and cur.provider = p_provider then cur.config end, '{}'::jsonb);
 v_name := case when found_ then cur.secret_name end;

 if found_ and cur.provider <> p_provider and p_secret is null then
  -- another provider: the old account's credentials do not carry over
  v_old := cur.secret_name;
  v_name := null;
 end if;

 if p_secret is not null then
  v_name := coalesce(v_name, public.aal_admin_payment_secret_name(p_rid, p_rail));
  execute 'select id from vault.secrets where name = $1 limit 1' into v_id using v_name;
  if v_id is null then
   execute 'select vault.create_secret($1, $2, $3)' into v_id
     using p_secret, v_name, 'Aalayna payment provider credentials (' || p_rail || ')';
  else
   execute 'select vault.update_secret($1, $2)' using v_id, p_secret;
  end if;
 end if;

 if found_ then
  update public.payment_providers
     set provider = p_provider, config = v_cfg, secret_name = v_name,
         enabled = coalesce(p_enabled, cur.enabled)
   where restaurant_id = p_rid and rail = p_rail;
 else
  insert into public.payment_providers (restaurant_id, rail, provider, config, secret_name, enabled)
  values (p_rid, p_rail, p_provider, v_cfg, v_name, coalesce(p_enabled, true));
 end if;

 if v_old is not null then perform public.aal_admin_vault_drop(v_old); end if;
 return public.aal_admin_payment_provider_json(p_rid, p_rail);
end $$;

create or replace function public.aal_admin_remove_payment_provider(p_rid text, p_rail text) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare v_name text;
begin
 if not public.aal_is_admin() then raise exception 'Admin key required.' using errcode = '42501'; end if;
 delete from public.payment_providers where restaurant_id = p_rid and rail = p_rail returning secret_name into v_name;
 if not found then return jsonb_build_object('removed', false); end if;
 perform public.aal_admin_vault_drop(v_name);
 return jsonb_build_object('removed', true);
end $$;

-- ---------------------------------------------------------------------------
-- For the payment-start function: is this an admin key? (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.aal_admin_key_valid(p_key text) returns boolean
language plpgsql stable security definer set search_path = public, extensions, pg_temp as $$
begin
 if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
  raise exception 'Service role required';
 end if;
 return coalesce(p_key, '') ~ '^adm_[0-9a-f]{12,64}$'
    and exists (select 1 from public.admin_keys a where a.admin_key = p_key);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges, as admin.sql: helpers run only inside the SECURITY DEFINER functions
-- ---------------------------------------------------------------------------
revoke all on function public.aal_admin_payment_secret_name(text, text) from public, anon, authenticated;
revoke all on function public.aal_admin_vault_has(text) from public, anon, authenticated;
revoke all on function public.aal_admin_vault_drop(text) from public, anon, authenticated;
revoke all on function public.aal_admin_payment_provider_json(text, text) from public, anon, authenticated;

revoke all on function public.aal_admin_list_payment_providers(text) from public;
revoke all on function public.aal_admin_set_payment_provider(text, text, text, jsonb, text, boolean) from public;
revoke all on function public.aal_admin_remove_payment_provider(text, text) from public;
grant execute on function public.aal_admin_list_payment_providers(text) to anon, authenticated;
grant execute on function public.aal_admin_set_payment_provider(text, text, text, jsonb, text, boolean) to anon, authenticated;
grant execute on function public.aal_admin_remove_payment_provider(text, text) to anon, authenticated;

revoke all on function public.aal_admin_key_valid(text) from public, anon, authenticated;
grant execute on function public.aal_admin_key_valid(text) to service_role;
commit;
