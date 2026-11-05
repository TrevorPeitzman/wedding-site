-- Clear song board without a bare DELETE, and resetting shot counters.
-- By now pass dddd (Dora) has used all 12 shots, one of them uploaded.
\set ON_ERROR_STOP 1

-- Supabase's pg-safeupdate refuses DELETE/UPDATE without WHERE in API
-- calls, inside functions too. No public function may contain one.
select t.check(not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           regexp_matches(p.prosrc, '(delete\s+from\s+[a-z_.]+(\s+[a-z_]+)?\s*(returning|\)|;)|update\s+[a-z_.]+\s+set\s[^;]*;)', 'gi') m
     where n.nspname = 'public' and m[1] !~* '\mwhere\M'),
    'no DELETE or UPDATE without WHERE in public functions');

-- Shots.
set role anon;
select t.expect_error($$select public.admin_shots('a-long-dj-key-for-tests')$$, 'not_organizer');
select public.admin_shots('an-organizer-key-for-tests') as shots \gset
reset role;
select t.check((select (x->>'used')::int from jsonb_array_elements(:'shots'::jsonb->'passes') x
                 where x->>'token' = 'pass-token-dddd') = 12, 'Dora has used 12');

set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.check((public.camera_status()->>'left')::int = 0, 'no shots left before the reset');
select (public.camera_status()->>'uploaded')::int as up_before \gset
reset role;
select client_id as old_client from public.photos where pass_token = 'pass-token-dddd' limit 1 \gset

set role anon;
select t.expect_error($$select public.admin_reset_shots('an-organizer-key-for-tests', 'no-such-pass')$$, 'not_found');
select t.check((public.admin_reset_shots('an-organizer-key-for-tests', 'pass-token-dddd')->>'reset')::int = 1, 'one pass reset');
reset role;

-- The camera is open for the rest of this test.
update public.events set camera_open = true where slug = 'wedding';
update public.feature_schedule set is_on = true, opens_at = null, closes_at = null where feature = 'camera';

set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.check((public.camera_status()->>'used')::int = 0 and (public.camera_status()->>'left')::int = 12, 'counter back to 12');
select t.check((public.camera_status()->>'uploaded')::int = :up_before, 'uploads kept');
select t.check(public.reserve_shot(:'old_client'::uuid)->>'photo_id' is not null, 'a retry of an old shot still answers');
select t.check((public.camera_status()->>'left')::int = 12, 'and does not cost a new shot');
select t.check((public.reserve_shot(gen_random_uuid())->>'left')::int = 11, 'a new shot counts from the reset');
reset role;
set role service_role;
select t.check(jsonb_array_length(public.gallery_paths_as('00000000-0000-0000-0000-0000000000d1')) >= 0, 'gallery still answers');
reset role;

-- Everyone at once.
select count(*) as n_passes from public.passes \gset
set role anon;
select t.check((public.admin_reset_shots('an-organizer-key-for-tests')->>'reset')::int = :n_passes, 'every pass reset');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.check((public.camera_status()->>'left')::int = 12, 'the new shot no longer counts either');
reset role;

-- Clear song board.
insert into public.song_requests (event_id, track_id)
select (app_private.the_event()).id, id from public.tracks limit 1 on conflict do nothing;
select t.check((select count(*) from public.song_requests) >= 1, 'a request to clear');
set role anon;
select t.check((public.admin_clear_songs('an-organizer-key-for-tests', 'CLEAR')->>'removed')::int >= 1, 'songs cleared');
reset role;
\echo shot reset ok
