-- Song details for the DJ view.
\set ON_ERROR_STOP 1

select t.check(not has_function_privilege('anon', 'public.set_track_details(integer, text, numeric, text)', 'execute'), 'anon cannot set details');
select t.check(not has_function_privilege('anon', 'public.track_details_todo(integer)', 'execute'), 'anon cannot list the to-do');

insert into public.tracks (spotify_id, title, artist, duration_ms) values ('detailsTestTrack0000001', 'Details Test', 'Tester', 215000);
select id as tid from public.tracks where spotify_id = 'detailsTestTrack0000001' \gset
set role service_role;
select t.check(not exists (select 1 from jsonb_array_elements(public.track_details_todo(20)) x where (x->>'id')::int = :tid), 'not on the to-do until requested');
reset role;
insert into public.song_requests (event_id, track_id) values ((app_private.the_event()).id, :tid);
set role service_role;
select t.check(exists (select 1 from jsonb_array_elements(public.track_details_todo(20)) x where (x->>'id')::int = :tid), 'requested: on the to-do');
select public.set_track_details(:tid, 'USAT21703015', 127.96, ' Pop ');
select t.check(not exists (select 1 from jsonb_array_elements(public.track_details_todo(20)) x where (x->>'id')::int = :tid), 'done: off the to-do');
reset role;
select t.check((select bpm = 128.0 and genre = 'Pop' and isrc = 'USAT21703015' from public.tracks where id = :tid), 'stored, rounded and trimmed');
set role service_role;
select public.set_track_details(:tid, null, 0, null);
reset role;
select t.check((select bpm is null and genre is null and details_checked_at is not null from public.tracks where id = :tid), 'zero BPM stored as unknown, still checked');
set role anon;
select t.check((select x->>'genre' is null and (x->>'duration_ms')::int = 215000
                  from jsonb_array_elements(public.admin_board('a-long-dj-key-for-tests')->'requests') x
                 where x->>'title' = 'Details Test'), 'DJ board carries length, bpm and genre');
reset role;
delete from public.song_requests where track_id = :tid;
\echo track details ok
