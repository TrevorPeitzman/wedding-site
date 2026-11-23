-- After the night.
--
-- 1. features() also reports "photos": open from photos_reveal_at, so pages
--    can link to the gallery once it is out (the camera's own links hide
--    when the camera is switched off). Not a switch: the reveal time sets it.
-- 2. The gallery and the organizer's list carry when each shot was taken
--    (reserved_at: the moment the guest pressed the shutter), for the
--    disposable-camera date stamp on downloads.

create or replace function public.features()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select jsonb_object_agg(feature, jsonb_build_object(
               'on', is_on, 'opens_at', opens_at, 'closes_at', closes_at,
               'state', app_private.feature_state(feature)))
             from public.feature_schedule), '{}'::jsonb)
        || jsonb_build_object('photos', (
             select jsonb_build_object(
               'on', e.photos_reveal_at is not null, 'opens_at', e.photos_reveal_at, 'closes_at', null,
               'state', case when e.photos_reveal_at is null then 'off'
                             when now() < e.photos_reveal_at then 'soon' else 'open' end)
             from public.events e where e.slug = 'wedding'))
$$;

-- The gallery with times: same rules as gallery_paths_as (a pass or the
-- gallery password, then the reveal).
create or replace function public.gallery_photos_as(p_guest uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.events := app_private.the_event();
begin
    if not app_private.gallery_access(p_guest) then
        perform app_private.fail('no_access', 'Enter the password, or scan the QR on your boarding pass, to see the photos.');
    end if;
    if e.photos_reveal_at is null or now() < e.photos_reveal_at then
        perform app_private.fail('not_revealed', 'The photos aren''t out yet.');
    end if;
    return (select coalesce(jsonb_agg(jsonb_build_object('path', f.path, 'taken_at', f.reserved_at)
                                      order by f.uploaded_at), '[]'::jsonb)
              from public.photos f join public.passes p on p.token = f.pass_token
             where f.status = 'uploaded' and not p.is_test);
end $$;

create or replace function public.admin_photos(p_key text, p_include_tests boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_organizer(p_key);
    return (select coalesce(jsonb_agg(jsonb_build_object(
                'id', f.id, 'path', f.path, 'hidden', f.status = 'removed',
                'uploaded_at', f.uploaded_at, 'taken_at', f.reserved_at, 'bytes', f.bytes,
                'first_name', p.first_name, 'last_name', p.last_name,
                'table_number', p.table_number, 'is_test', p.is_test)
                order by f.uploaded_at desc), '[]'::jsonb)
              from public.photos f join public.passes p on p.token = f.pass_token
             where f.uploaded_at is not null and f.status in ('uploaded', 'removed')
               and (p_include_tests or not p.is_test));
end $$;

revoke all on function public.gallery_photos_as(uuid) from public, anon, authenticated;
grant execute on function public.gallery_photos_as(uuid) to service_role;
