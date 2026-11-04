-- Wallet passes (Phase 4).
--
-- Signed Apple passes are made offline by scripts/make_wallet_passes.py and
-- uploaded to the private `wallet` bucket as <zola_guest_id>.pkpass. The
-- `wallet` Edge Function serves one to whoever holds its pass token, as
-- application/vnd.apple.pkpass, and only while the `wallet` feature is open.
-- Google Wallet save links, once generated, are stored per pass.
--
-- my_pass_card() gives a phone that claimed a pass what the landing page
-- needs: the on-screen pass, and which Wallet buttons to show.

alter table public.passes add column if not exists google_save_url text;

do $$
begin
    if to_regclass('storage.buckets') is not null then
        insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        values ('wallet', 'wallet', false, 2097152, array['application/vnd.apple.pkpass'])
        on conflict (id) do nothing;
    end if;
end $$;

create or replace function app_private.pass_file(p public.passes)
returns text language sql immutable set search_path = public, pg_temp as $$
    select p.zola_guest_id || '.pkpass'
$$;

create or replace function app_private.apple_pass_ready(p public.passes)
returns boolean language sql stable set search_path = public, pg_temp as $$
    select exists (select 1 from storage.objects o
                    where o.bucket_id = 'wallet' and o.name = app_private.pass_file(p))
$$;

-- The claimed pass, for the landing page.
create or replace function public.my_pass_card()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.passes;
begin
    if auth.uid() is not null then
        p := app_private.my_pass();
    end if;
    if p.token is null then
        return jsonb_build_object('has_pass', false);
    end if;
    return jsonb_build_object(
        'has_pass', true,
        'token', p.token,
        'first_name', p.first_name, 'last_name', p.last_name,
        'pass_name', p.pass_name, 'strip_name', p.strip_name,
        'table_number', p.table_number, 'gate', p.gate, 'seat', p.seat, 'cabin', p.cabin,
        'destination_city', p.destination_city, 'destination_code', p.destination_code,
        'ssr_remarks', p.ssr_remarks,
        'wallet_state', app_private.feature_state('wallet'),
        'apple_ready', app_private.apple_pass_ready(p),
        'google_save_url', case when app_private.feature_state('wallet') = 'open' then p.google_save_url end);
end $$;

-- For the `wallet` Edge Function: the stored file for a token, if the
-- feature is open and the file exists.
create or replace function public.wallet_file_as(p_token text)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $$
declare p public.passes;
begin
    perform app_private.require_feature('wallet', 'Your Wallet pass', false);
    select * into p from public.passes where token = p_token;
    if not found then
        perform app_private.fail('unknown_pass', 'We could not find that boarding pass.');
    end if;
    if not app_private.apple_pass_ready(p) then
        perform app_private.fail('not_ready', 'Your Wallet pass isn''t ready yet. Your paper pass works just the same.');
    end if;
    return app_private.pass_file(p);
end $$;

revoke all on function app_private.pass_file(public.passes), app_private.apple_pass_ready(public.passes) from public;
revoke all on function public.my_pass_card(), public.wallet_file_as(text) from public, anon, authenticated;
grant execute on function public.my_pass_card() to authenticated;
grant execute on function public.wallet_file_as(text) to service_role;
