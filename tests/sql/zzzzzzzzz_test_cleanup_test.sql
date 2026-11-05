-- Deleting test passes also removes song activity from phones on them.
\set ON_ERROR_STOP 1

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000e1') on conflict do nothing;
set role anon;
select (public.admin_make_test_passes('an-organizer-key-for-tests', 1)->'test_passes'->0->>'token') as tpass \gset
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000e1');
select public.claim_pass(:'tpass');
reset role;

-- A real request (from a real guest) and one from the test phone, each voted
-- on by the test phone.
select id as real_track from public.tracks order by id limit 1 \gset
select id as test_track from public.tracks order by id desc limit 1 \gset
select id as real_guest from public.guests where pass_token is not null and pass_token <> :'tpass' limit 1 \gset
delete from public.song_requests where track_id in (:real_track, :test_track);
insert into public.song_requests (event_id, track_id, requested_by)
values ((app_private.the_event()).id, :real_track, :'real_guest'),
       ((app_private.the_event()).id, :test_track, '00000000-0000-0000-0000-0000000000e1');
insert into public.votes (request_id, guest_id)
select id, '00000000-0000-0000-0000-0000000000e1' from public.song_requests where track_id in (:real_track, :test_track);

set role anon;
select public.admin_delete_test_passes('an-organizer-key-for-tests');
reset role;
select t.check(not exists (select 1 from public.votes where guest_id = '00000000-0000-0000-0000-0000000000e1'), 'test phone''s votes gone');
select t.check(not exists (select 1 from public.song_requests where track_id = :test_track), 'test phone''s request gone');
select t.check(exists (select 1 from public.song_requests where track_id = :real_track), 'real request kept');
select t.check(not exists (select 1 from public.passes where is_test), 'test passes gone');
\echo test cleanup ok
