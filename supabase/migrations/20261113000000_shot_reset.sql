-- 1. Clear song board works on the hosted project.
--    Supabase runs pg-safeupdate for API calls, which refuses a DELETE or
--    UPDATE without a WHERE clause, even inside a function. Every statement
--    reached through the API needs one (tests/sql checks this).
--
-- 2. Reset a guest's shot counter, keeping their photos.
--    passes.shots_reset_at: shots reserved before it no longer count toward
--    the limit. Their photos stay uploaded, in the gallery and in /admin/.
--    admin_shots() lists every pass's count; admin_reset_shots() resets one
--    pass, or every pass when no token is given. Organizer key.

create or replace function public.admin_clear_songs(p_key text, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
    perform app_private.require_organizer(p_key);
    if p_confirm is distinct from 'CLEAR' then
        perform app_private.fail('not_confirmed', 'Type CLEAR to empty the song board.');
    end if;
    with gone as (delete from public.song_requests where id is not null returning 1)
    select count(*) into n from gone;
    return jsonb_build_object('removed', n);
end $$;

alter table public.passes add column if not exists shots_reset_at timestamptz;

create or replace function app_private.shots_used(p_token text)
returns integer language sql stable set search_path = public, pg_temp as $$
    select count(*)::int
      from public.photos f join public.passes p on p.token = f.pass_token
     where f.pass_token = p_token and f.status in ('reserved', 'uploaded', 'removed')
       and (p.shots_reset_at is null or f.reserved_at > p.shots_reset_at)
$$;

create or replace function public.admin_shots(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.events := app_private.the_event();
begin
    perform app_private.require_organizer(p_key);
    return jsonb_build_object(
        'shots_per_pass', e.shots_per_pass,
        'passes', (select coalesce(jsonb_agg(jsonb_build_object(
                'token', p.token, 'first_name', p.first_name, 'last_name', p.last_name,
                'table_number', p.table_number, 'is_test', p.is_test,
                'used', app_private.shots_used(p.token),
                'uploaded', (select count(*) from public.photos f where f.pass_token = p.token and f.status in ('uploaded', 'removed')),
                'phones', (select count(*) from public.guests g where g.pass_token = p.token),
                'reset_at', p.shots_reset_at)
                order by p.is_test, p.table_number nulls last, p.last_name, p.first_name), '[]'::jsonb)
              from public.passes p));
end $$;

-- p_token null: every pass (test passes too).
create or replace function public.admin_reset_shots(p_key text, p_token text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
    perform app_private.require_organizer(p_key);
    update public.passes set shots_reset_at = now()
     where p_token is null or token = p_token;
    get diagnostics n = row_count;
    if p_token is not null and n = 0 then
        perform app_private.fail('not_found', 'We couldn''t find that pass.');
    end if;
    return jsonb_build_object('reset', n);
end $$;

revoke all on function app_private.shots_used(text) from public, anon, authenticated;
revoke all on function public.admin_clear_songs(text, text), public.admin_shots(text),
    public.admin_reset_shots(text, text) from public, anon, authenticated;
grant execute on function public.admin_clear_songs(text, text), public.admin_shots(text),
    public.admin_reset_shots(text, text) to anon, authenticated;
