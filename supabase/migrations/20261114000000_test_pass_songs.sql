-- "Delete test passes" also removes the song requests and votes made by
-- phones on test passes (rehearsals, scripts/load_test.mjs --night), so the
-- real board is left as guests made it. Real guests' votes on a deleted
-- test request go with it.
create or replace function public.admin_delete_test_passes(p_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare paths jsonb;
begin
    perform app_private.require_organizer(p_key);
    delete from public.votes v
     using public.guests g join public.passes p on p.token = g.pass_token
     where v.guest_id = g.id and p.is_test;
    delete from public.song_requests r
     using public.guests g join public.passes p on p.token = g.pass_token
     where r.requested_by = g.id and p.is_test;
    with gone as (
        delete from public.photos f using public.passes p
         where p.token = f.pass_token and p.is_test
        returning f.path)
    select coalesce(jsonb_agg(path), '[]'::jsonb) into paths from gone;
    delete from public.passes where is_test;
    return paths;
end $$;

revoke all on function public.admin_delete_test_passes(text) from public, anon, authenticated;
grant execute on function public.admin_delete_test_passes(text) to anon, authenticated;
