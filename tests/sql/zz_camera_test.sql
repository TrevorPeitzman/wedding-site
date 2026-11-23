-- Disposable camera rules. Runs after song_requests_test.sql, which leaves
-- guest A holding pass 'pass-token-aaaa' and creates the t.* helpers.
\set ON_ERROR_STOP 1

select t.check((select count(*) from storage.buckets where id = 'photos' and not public
                and allowed_mime_types = array['image/jpeg']) = 1, 'private photos bucket, JPEG only');

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000d1'), ('00000000-0000-0000-0000-0000000000d2');
insert into public.passes (token, zola_guest_id, first_name, last_name) values ('pass-token-dddd', 'zola-d', 'Dora', 'Day');

-- anon: status only, no reserving, no gallery
set role anon;
select t.check(not (public.camera_status()->>'has_pass')::boolean, 'anon has no pass');
select t.expect_error($$select public.reserve_shot(gen_random_uuid())$$, '<42501: permission denied for function reserve_shot>');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$select public.gallery_paths_as('00000000-0000-0000-0000-0000000000d1')$$,
                      '<42501: permission denied for function gallery_paths_as>');
select t.expect_error('select * from public.photos', '<42501: permission denied for table photos>');

-- No pass yet: no camera.
select t.expect_error($$select public.reserve_shot(gen_random_uuid())$$, 'no_pass');
select public.claim_pass('pass-token-dddd');
select t.check((public.camera_status()->>'left')::int = 12, '12 shots to start');

-- First shot, and a retry of it.
select public.reserve_shot('11111111-0000-0000-0000-000000000001');
select t.check((public.reserve_shot('11111111-0000-0000-0000-000000000001')->>'left')::int = 11,
               'a retry reuses its slot');
select t.check((public.camera_status()->>'used')::int = 1, 'retry did not cost a shot');
select t.check(public.reserve_shot('11111111-0000-0000-0000-000000000001')->>'path' like '%.jpg', 'slot has a path');

-- Confirm needs the file to be in storage.
select t.expect_error($$select public.confirm_shot((public.reserve_shot('11111111-0000-0000-0000-000000000001')->>'photo_id')::uuid)$$,
                      'not_uploaded');
reset role;
insert into storage.objects (bucket_id, name, metadata)
select 'photos', path, '{"size": 734003, "mimetype": "image/jpeg"}' from public.photos
 where client_id = '11111111-0000-0000-0000-000000000001';
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.check(public.confirm_shot((public.reserve_shot('11111111-0000-0000-0000-000000000001')->>'photo_id')::uuid)->>'status'
               = 'uploaded', 'confirm after upload');
select t.check((public.camera_status()->>'uploaded')::int = 1, 'status counts uploads');
select t.check(not (public.camera_status()->'shots'->0 ? 'path'), 'status never returns photo paths');

-- A second phone on the same pass shares the 12.
select t.as_guest('00000000-0000-0000-0000-0000000000d2');
select public.claim_pass('pass-token-dddd');
select t.check((public.camera_status()->>'left')::int = 11, 'second phone sees the same count');
select public.reserve_shot(('11111111-0000-0000-0000-0000000000' || lpad(i::text, 2, '0'))::uuid) from generate_series(2, 12) i;
select t.check((public.camera_status()->>'left')::int = 0, 'all 12 used');
select t.expect_error($$select public.reserve_shot('11111111-0000-0000-0000-000000000099')$$, 'out_of_shots');
-- ...but a retry of an existing shot still works when out of shots.
select t.check(public.reserve_shot('11111111-0000-0000-0000-000000000012')->>'status' = 'reserved', 'retry works at 0 left');

-- Another guest can't touch this pass's slots.
select t.as_guest('00000000-0000-0000-0000-00000000000a');
select t.expect_error($$select public.reserve_shot('11111111-0000-0000-0000-000000000001')$$, 'not_yours');
select t.expect_error($$select public.confirm_shot((select '00000000-0000-0000-0000-000000000000')::uuid)$$, 'not_found');
reset role;

-- Camera switched off: no new shots. (Camera settings are the organizer's.)
select app_private.set_admin_key('a-long-dj-key-for-tests');
select app_private.set_organizer_key('an-organizer-key-for-tests');
set role anon;
select t.expect_error($$select public.admin_set_camera('a-long-dj-key-for-tests', '{"camera_open": false}')$$, 'not_organizer');
select public.admin_set_camera('an-organizer-key-for-tests', '{"camera_open": false}');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000a');
select t.expect_error($$select public.reserve_shot(gen_random_uuid())$$, 'camera_closed');
reset role;

-- Gallery: guests with a pass, after the reveal only.
set role service_role;
select t.expect_error($$select public.gallery_paths_as('00000000-0000-0000-0000-00000000000c')$$, 'no_access');
select t.expect_error($$select public.gallery_paths_as('00000000-0000-0000-0000-0000000000d1')$$, 'not_revealed');
reset role;
set role anon;
select public.admin_set_camera('an-organizer-key-for-tests', '{"photos_reveal_at": "now"}');
select t.check((public.admin_camera('a-long-dj-key-for-tests')->>'uploaded')::int = 1, 'organizer stats');
reset role;
set role service_role;
select t.check(jsonb_array_length(public.gallery_paths_as('00000000-0000-0000-0000-0000000000d1')) = 1,
               'after the reveal: uploaded photos only');
reset role;

-- Put the camera back for the next test file.
set role anon;
select public.admin_set_camera('an-organizer-key-for-tests', '{"camera_open": true}');
reset role;

select 'ok' as camera_test;
