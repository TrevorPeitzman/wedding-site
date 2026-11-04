-- Rehearsal tools. Runs last; the organizer key is set by zz_camera_test.sql.
\set ON_ERROR_STOP 1

set role anon;
select t.expect_error($$select public.admin_make_test_passes('a-long-dj-key-for-tests', 3)$$, 'not_organizer');
select t.check(jsonb_array_length(public.admin_make_test_passes('an-organizer-key-for-tests', 3)->'test_passes') = 3, 'three test passes');
select t.check(jsonb_array_length(public.admin_make_test_passes('an-organizer-key-for-tests', 3)->'test_passes') = 3, 'making again tops up, never duplicates');
reset role;
select t.check((select bool_and(token ~ '^[A-Za-z0-9_-]{16}$') from public.passes where is_test), 'test tokens: 16 URL-safe characters');

-- A phone claims test pass 1 and shoots twice; one shot is uploaded.
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000f1');
select token as test1 from public.passes where zola_guest_id = 'test-1' \gset
select public.admin_set_feature('an-organizer-key-for-tests', 'camera', true, null, null);
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000f1');
select public.claim_pass(:'test1');
select public.reserve_shot('22222222-0000-0000-0000-000000000001');
select public.reserve_shot('22222222-0000-0000-0000-000000000002');
reset role;
insert into storage.objects (bucket_id, name, metadata)
select 'photos', path, '{"size": 1000}' from public.photos where client_id = '22222222-0000-0000-0000-000000000001';
select id as shot1 from public.photos where client_id = '22222222-0000-0000-0000-000000000001' \gset
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000f1');
select public.confirm_shot(:'shot1');
select t.check((public.camera_status()->>'left')::int = 10, 'test pass used 2 shots');
reset role;

-- Test photos never reach the gallery (the reveal is already out from the camera test).
set role service_role;
select public.gallery_paths_as('00000000-0000-0000-0000-0000000000d1') as gallery \gset
reset role;
select t.check(not exists (
    select 1 from jsonb_array_elements_text(:'gallery'::jsonb) x
    join public.photos f on f.path = x join public.passes p on p.token = f.pass_token where p.is_test),
    'gallery leaves out test photos');
select t.check(jsonb_array_length(:'gallery'::jsonb) = 1, 'gallery still has the real photo');

-- Reset gives the shots back and returns the paths to delete.
set role anon;
select t.check(jsonb_array_length(public.admin_reset_test_pass('an-organizer-key-for-tests', :'test1')) = 2,
               'reset returns both paths');
select t.expect_error($$select public.admin_reset_test_pass('an-organizer-key-for-tests', 'pass-token-dddd')$$, 'not_test_pass');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000f1');
select t.check((public.camera_status()->>'left')::int = 12, 'shots back to 12');
reset role;

-- Stats.
set role anon;
select t.check((public.admin_rehearsal('an-organizer-key-for-tests')->>'real_photos')::int >= 1, 'stats count real photos');
reset role;

-- Clear the song board: needs the word.
set role anon;
select t.expect_error($$select public.admin_clear_songs('an-organizer-key-for-tests', 'yes')$$, 'not_confirmed');
select t.check((public.admin_clear_songs('an-organizer-key-for-tests', 'CLEAR')->>'removed')::int > 0, 'song board cleared');
reset role;
select t.check((select count(*) from public.song_requests) = 0 and (select count(*) from public.votes) = 0,
               'no requests or votes left');

-- Delete the test passes: the phone is unlinked, real passes stay.
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000f1');
select public.reserve_shot('22222222-0000-0000-0000-000000000003');
reset role;
set role anon;
select t.check(jsonb_array_length(public.admin_delete_test_passes('an-organizer-key-for-tests')) = 1, 'delete returns the test photo paths');
reset role;
select t.check((select count(*) from public.passes where is_test) = 0, 'test passes gone');
select t.check((select count(*) from public.passes where token = 'pass-token-dddd') = 1, 'real passes kept');
select t.check((select pass_token from public.guests where id = '00000000-0000-0000-0000-0000000000f1') is null,
               'phone unlinked from the deleted pass');

select 'ok' as rehearsal_test;
