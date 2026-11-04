-- Song request rules, exercised through the same roles the browser and the
-- Edge Function use. Run with supabase/tests/run.sh.
\set ON_ERROR_STOP 1

create schema t;
grant usage on schema t to public;

-- Runs p_sql and fails the test unless it raises a guest-facing error whose
-- code (the exception DETAIL) is p_code.
create function t.expect_error(p_sql text, p_code text) returns void language plpgsql as $$
declare got text; msg text;
begin
    begin
        execute p_sql;
        got := '<no error>';
    exception when others then
        get stacked diagnostics got = pg_exception_detail, msg = message_text;
        if got = '' then got := '<' || sqlstate || ': ' || msg || '>'; end if;
    end;
    if got is distinct from p_code then
        raise exception 'expected % from [%], got %', p_code, p_sql, got;
    end if;
end $$;
grant execute on function t.expect_error(text, text) to public;

create function t.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
    if p_ok is not true then raise exception 'FAILED: %', p_what; end if;
end $$;
grant execute on function t.check(boolean, text) to public;

create function t.as_guest(p uuid) returns void language sql as $$
    select set_config('request.jwt.claim.sub', coalesce(p::text, ''), false)
$$;
grant execute on function t.as_guest(uuid) to public;

-- The board for the current guest, by title.
create function t.row_for(p_title text) returns jsonb language sql as $$
    select x from jsonb_array_elements(public.song_board()->'requests') x where x->>'title' = p_title
$$;
grant execute on function t.row_for(text) to public;

insert into auth.users (id) values
    ('00000000-0000-0000-0000-00000000000a'),
    ('00000000-0000-0000-0000-00000000000b'),
    ('00000000-0000-0000-0000-00000000000c');

-- ---------------------------------------------------------------- anon --
set role anon;
select t.check(jsonb_array_length(public.song_board()->'requests') = 0, 'anon sees an empty board');
select t.expect_error('select * from public.votes', '<42501: permission denied for table votes>');
select t.expect_error($$select public.vote(1)$$, '<42501: permission denied for function vote>');
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-00000000000a', '{}', null)$$,
                      '<42501: permission denied for function submit_request_as>');
reset role;

-- --------------------------------------------------------- authenticated --
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000a');
select t.expect_error('select * from public.song_requests', '<42501: permission denied for table song_requests>');
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-00000000000a', '{}', null)$$,
                      '<42501: permission denied for function submit_request_as>');
select t.expect_error($$select public.admin_board('wrong-key-wrong-key')$$, 'not_admin');
reset role;

-- --------------------------------------------- requests via the function --
set role service_role;
-- Guest A requests September; their own vote comes with it.
select t.check(
    public.submit_request_as('00000000-0000-0000-0000-00000000000a',
        '{"spotify_id":"demo000000000000000001","title":"September","artist":"Earth, Wind & Fire","duration_ms":215000}',
        'Aunt Jo')->>'action' = 'created', 'first request is created');
-- Guest B requests the same song: that becomes an upvote.
select t.check(
    public.submit_request_as('00000000-0000-0000-0000-00000000000b',
        '{"spotify_id":"demo000000000000000001","title":"September","artist":"Earth, Wind & Fire"}', null)->>'action' = 'voted',
    'duplicate request becomes a vote');
-- Blocked by the starter rule, in search and on submit.
select t.check(jsonb_array_length(public.allowed_tracks(
    '[{"spotify_id":"x1","title":"Chicken Dance","artist":"Somebody"},{"spotify_id":"x2","title":"Dancing Queen","artist":"ABBA"}]')) = 1,
    'search results drop blocked songs');
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-00000000000c',
    '{"title":"The Chicken Dance","artist":"Polka Band"}', null)$$, 'blocked');
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-00000000000c',
    '{"title":"","artist":"Nobody"}', null)$$, 'incomplete_track');
-- Request cooldown: A just requested, so a second song must wait.
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-00000000000a',
    '{"title":"Dancing Queen","artist":"ABBA"}', null)$$, 'request_cooldown');
reset role;

set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000a');
select t.check((t.row_for('September')->>'votes')::int = 2, 'September has two votes');
select t.check((t.row_for('September')->>'voted')::boolean, 'A sees their own vote');
select t.check(t.row_for('September')->>'requester_name' = 'Aunt Jo', 'requester name shown');
select t.check(not (t.row_for('September') ? 'requested_by'), 'requester id is not exposed');
select t.expect_error($$select public.vote((t.row_for('September')->>'id')::int)$$, 'already_voted');
select t.as_guest('00000000-0000-0000-0000-00000000000c');
select t.check(not (t.row_for('September')->>'voted')::boolean, 'C has not voted');
reset role;

-- Let time pass for A's cooldowns, then a manual entry.
update public.song_requests set created_at = created_at - interval '1 hour';
update public.votes set created_at = created_at - interval '1 hour';
set role service_role;
select t.check(public.submit_request_as('00000000-0000-0000-0000-00000000000a',
    '{"title":"Dancing Queen","artist":"ABBA"}', null)->>'action' = 'created', 'manual entry created');
reset role;
update public.song_requests set created_at = created_at - interval '1 hour';
update public.votes set created_at = created_at - interval '1 hour';
set role service_role;
-- Same manual song, different case: deduped into a vote.
select t.check(public.submit_request_as('00000000-0000-0000-0000-00000000000c',
    '{"title":"dancing queen","artist":"abba"}', null)->>'action' = 'voted', 'manual entries dedupe case-insensitively');
reset role;

-- Vote cooldown: C just voted (via the dedupe), so another vote must wait.
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000c');
select t.expect_error($$select public.vote((t.row_for('September')->>'id')::int)$$, 'vote_cooldown');
select t.check((public.song_board()->>'vote_cooldown_remaining')::int > 0, 'board reports the cooldown');
reset role;
update public.votes set created_at = created_at - interval '1 hour';
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000c');
select t.check(public.vote((t.row_for('September')->>'id')::int)->>'action' = 'voted', 'vote after cooldown');
select t.check((t.row_for('September')->>'votes')::int = 3, 'September has three votes');
-- Board order: most votes first.
select t.check((public.song_board()->'requests'->0->>'title') = 'September', 'highest score on top');
reset role;

-- Request cap.
update public.events set max_requests_per_guest = 2, request_cooldown_seconds = 0;
set role service_role;
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-00000000000a',
    '{"title":"Mr. Brightside","artist":"The Killers"}', null)$$, 'request_cap');
reset role;

-- ------------------------------------------------------------------ DJ --
select app_private.set_admin_key('a-long-dj-key-for-tests');
set role anon;
select t.expect_error($$select public.admin_board('not-the-right-key!!')$$, 'not_admin');
select t.check(jsonb_array_length(public.admin_board('a-long-dj-key-for-tests')->'requests') = 2, 'DJ sees the board');
select public.admin_set_status('a-long-dj-key-for-tests',
    (select (x->>'id')::int from jsonb_array_elements(public.admin_board('a-long-dj-key-for-tests')->'requests') x
      where x->>'title' = 'Dancing Queen'), 'played');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000b');
select t.check(public.song_board()->'requests'->-1->>'title' = 'Dancing Queen', 'played songs sink to the bottom');
select t.check(t.row_for('Dancing Queen')->>'status' = 'played', 'played status shown');
reset role;
update public.votes set created_at = created_at - interval '1 hour';
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000b');
select t.expect_error($$select public.vote((t.row_for('Dancing Queen')->>'id')::int)$$, 'not_votable');
reset role;

set role anon;
select public.admin_add_block_rule('a-long-dj-key-for-tests', 'artist', 'Earth, Wind', 'Not tonight',
    (select (x->>'id')::int from jsonb_array_elements(public.admin_board('a-long-dj-key-for-tests')->'requests') x
      where x->>'title' = 'September'));
select public.admin_update_event('a-long-dj-key-for-tests', '{"requests_open": false, "vote_cooldown_seconds": 60}');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000b');
select t.check(t.row_for('September') is null, 'hidden songs leave the board');
select t.check(not (public.song_board()->>'requests_open')::boolean, 'requests closed');
select t.check((public.song_board()->>'vote_cooldown_seconds')::int = 60, 'cooldown updated');
reset role;
set role service_role;
select t.expect_error($$select public.submit_request_as('00000000-0000-0000-0000-00000000000b',
    '{"title":"Shout","artist":"The Isley Brothers"}', null)$$, 'requests_closed');
reset role;

-- --------------------------------------------------------- boarding pass --
insert into public.passes (token, zola_guest_id, first_name, last_name, table_number)
values ('pass-token-aaaa', 'zola-1', 'Josephine', 'March', 9);
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-00000000000a');
select t.expect_error($$select public.claim_pass('nope')$$, 'unknown_pass');
select t.check(public.claim_pass('pass-token-aaaa')->>'name' = 'Josephine M.', 'pass claimed');
select t.check((public.song_board()->'me'->>'from_pass')::boolean, 'board knows the pass');
select public.set_display_name('Someone Else');
select t.check(public.song_board()->'me'->>'name' = 'Josephine M.', 'a pass name wins over a typed one');
reset role;
select t.check((select requester_name from public.song_requests r join public.tracks k on k.id = r.track_id
                 where k.title = 'Dancing Queen') = 'Josephine M.', 'earlier requests take the pass name');

select 'ok' as song_requests_test;
