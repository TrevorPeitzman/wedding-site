-- Timed release and the organizer key. Runs after zz_camera_test.sql, which
-- sets the DJ key and the organizer key and leaves guest d1 on pass dddd.
\set ON_ERROR_STOP 1

set role anon;
select t.check((select count(*) from jsonb_object_keys(public.features())) = 5, 'five features');
select t.check(public.features()->'songs'->>'state' = 'open', 'songs open by default');
select t.expect_error($$select * from public.feature_schedule$$, '<42501: permission denied for table feature_schedule>');

-- Keys: the DJ key can't run the admin screen; the organizer key can do the DJ's job.
select t.expect_error($$select public.admin_features('a-long-dj-key-for-tests')$$, 'not_organizer');
select t.check(public.admin_features('an-organizer-key-for-tests') ? 'camera', 'organizer reads the admin screen');
select t.check(public.admin_board('an-organizer-key-for-tests') ? 'requests', 'organizer key works in the DJ view');
select t.check(public.admin_board('a-long-dj-key-for-tests') ? 'requests', 'DJ key still works');
select t.expect_error($$select public.admin_set_feature('an-organizer-key-for-tests', 'songs', true,
    '2026-11-21 19:00-08', '2026-11-21 18:00-08')$$, 'bad_times');
select t.expect_error($$select public.admin_set_feature('an-organizer-key-for-tests', 'bogus', true, null, null)$$, 'bad_feature');

-- Songs not open yet: refused in the database, with the opening time.
select public.admin_set_feature('an-organizer-key-for-tests', 'songs', true, now() + interval '2 hours', null);
select t.check(public.features()->'songs'->>'state' = 'soon', 'songs soon');
reset role;
update public.events set requests_open = true, voting_open = true, request_cooldown_seconds = 0, max_requests_per_guest = 50;
set role service_role;
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-0000000000d1',
    '{"title":"Superstition","artist":"Stevie Wonder"}', null)$$, 'feature_soon');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000c1');
select t.expect_error($$select public.vote(1)$$, 'feature_soon');
reset role;

-- Switched off: closed.
set role anon;
select public.admin_set_feature('an-organizer-key-for-tests', 'songs', false, null, null);
reset role;
set role service_role;
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-0000000000d1',
    '{"title":"Superstition","artist":"Stevie Wonder"}', null)$$, 'feature_closed');
reset role;

-- Back on: works again.
set role anon;
select public.admin_set_feature('an-organizer-key-for-tests', 'songs', true, null, null);
reset role;
set role service_role;
select t.check(public.submit_request_as('00000000-0000-0000-0000-0000000000d1',
    '{"title":"Superstition","artist":"Stevie Wonder"}', null)->>'action' = 'created', 'songs open again');
reset role;

-- Camera past its closing time: no new shots, but a retry of a reserved one still goes through.
set role anon;
select public.admin_set_feature('an-organizer-key-for-tests', 'camera', true, null, now() - interval '1 minute');
select t.check(public.features()->'camera'->>'state' = 'closed', 'camera closed by time');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$select public.reserve_shot(gen_random_uuid())$$, 'feature_closed');
select t.check(public.reserve_shot('11111111-0000-0000-0000-000000000001')->>'status' = 'uploaded',
               'retry of an existing shot still allowed');
reset role;

-- The core functions are not callable directly.
set role service_role;
select t.expect_error($$select app_private.submit_request_core('00000000-0000-0000-0000-0000000000d1', '{}', null)$$,
                      '<42501: permission denied for schema app_private>');
reset role;

select 'ok' as timed_release_test;
