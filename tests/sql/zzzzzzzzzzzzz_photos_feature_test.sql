-- "photos" in the feature list, and shot times for the date stamp.
\set ON_ERROR_STOP 1

update public.events set photos_reveal_at = now() + interval '1 day' where slug = 'wedding';
set role anon;
select t.check(public.features()->'photos'->>'state' = 'soon', 'photos soon before the reveal');
select t.check(public.features() ? 'camera' and public.features() ? 'songs', 'the switches are still there');
reset role;
update public.events set photos_reveal_at = now() - interval '1 minute' where slug = 'wedding';
set role anon;
select t.check(public.features()->'photos'->>'state' = 'open', 'photos open after the reveal');
select t.check((select bool_and(x ? 'taken_at') from jsonb_array_elements(public.admin_photos('an-organizer-key-for-tests')) x), 'organizer list has taken_at');
reset role;
update public.events set photos_reveal_at = null where slug = 'wedding';
set role anon;
select t.check(public.features()->'photos'->>'state' = 'off', 'no reveal time: off');
reset role;
update public.events set photos_reveal_at = now() - interval '1 minute' where slug = 'wedding';
set role service_role;
select t.check(jsonb_array_length(public.gallery_photos_as('00000000-0000-0000-0000-0000000000d1')) >= 1
               and (public.gallery_photos_as('00000000-0000-0000-0000-0000000000d1')->0 ? 'taken_at'), 'gallery has times');
select t.expect_error($$select public.gallery_photos_as('00000000-0000-0000-0000-00000000000c')$$, 'no_access');
reset role;
select t.check(not has_function_privilege('anon', 'public.gallery_photos_as(uuid)', 'execute'), 'not for anon');
\echo photos feature ok
