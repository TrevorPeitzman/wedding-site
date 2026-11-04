-- Organizer photo view (Phase 5 follow-up).
--
-- admin_photos() lists every uploaded (or hidden) photo with who took it, for
-- the Photos section of /admin/; the `camera` Edge Function signs short-lived
-- links for them (action "admin_photos"). admin_hide_photo() takes one out of
-- the guest gallery (status 'removed': it still counts as a shot) or puts it
-- back. Both need the organizer key.

create or replace function public.admin_photos(p_key text, p_include_tests boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_organizer(p_key);
    return (select coalesce(jsonb_agg(jsonb_build_object(
                'id', f.id, 'path', f.path, 'hidden', f.status = 'removed',
                'uploaded_at', f.uploaded_at, 'bytes', f.bytes,
                'first_name', p.first_name, 'last_name', p.last_name,
                'table_number', p.table_number, 'is_test', p.is_test)
                order by f.uploaded_at desc), '[]'::jsonb)
              from public.photos f join public.passes p on p.token = f.pass_token
             where f.uploaded_at is not null and f.status in ('uploaded', 'removed')
               and (p_include_tests or not p.is_test));
end $$;

create or replace function public.admin_hide_photo(p_key text, p_photo_id uuid, p_hidden boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.photos;
begin
    perform app_private.require_organizer(p_key);
    update public.photos
       set status = case when p_hidden then 'removed' else 'uploaded' end
     where id = p_photo_id and uploaded_at is not null and status in ('uploaded', 'removed')
    returning * into f;
    if f.id is null then
        perform app_private.fail('not_found', 'We couldn''t find that photo.');
    end if;
    return jsonb_build_object('id', f.id, 'hidden', f.status = 'removed');
end $$;

revoke all on function public.admin_photos(text, boolean), public.admin_hide_photo(text, uuid, boolean)
    from public, anon, authenticated;
grant execute on function public.admin_photos(text, boolean), public.admin_hide_photo(text, uuid, boolean)
    to anon, authenticated;
