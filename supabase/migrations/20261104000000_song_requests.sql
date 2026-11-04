-- Song requests on Supabase.
--
-- A port of wedding-song-requests/db/schema.sql + app/service.py. The rules
-- are the same; they now live in Postgres functions because the pages are
-- static (GitHub Pages) and talk to Supabase directly.
--
-- Access model
--  * Every table has RLS on and NO policies, and anon/authenticated have no
--    table grants. Browsers never read or write a table directly.
--  * Guests call the SECURITY DEFINER functions below via supabase.rpc().
--    Identity is auth.uid() from a Supabase anonymous sign-in: one per phone,
--    the replacement for the old signed cookie.
--  * Submitting a song goes through the `songs` Edge Function, which looks the
--    track up on Spotify itself and then calls submit_request_as() with the
--    service role. So a guest can't put made-up metadata on the board.
--  * The DJ view authenticates with a shared key (the old ADMIN_TOKEN). Only
--    its SHA-256 lives in the database: set it with
--      select app_private.set_admin_key('<long random string>');
--
-- Errors a guest should see are raised with errcode P0001: message = the
-- prose, detail = a stable code for the UI, hint = retry-after seconds.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists app_private;
revoke all on schema app_private from public;

-- ---------------------------------------------------------------- tables --

create table if not exists public.events (
    id                       serial primary key,
    slug                     text not null unique,
    name                     text not null,
    event_date               date,
    requests_open            boolean not null default true,
    voting_open              boolean not null default true,
    vote_cooldown_seconds    integer not null default 300,
    request_cooldown_seconds integer not null default 600,
    max_requests_per_guest   integer not null default 5,
    block_explicit           boolean not null default false,
    created_at               timestamptz not null default now()
);

-- One row per printed boarding pass. Imported from Zola before the night
-- (Phase 4); the QR on the pass carries `token`. Empty until then.
create table if not exists public.passes (
    token          text primary key,
    zola_guest_id  text unique,
    first_name     text not null,
    last_name      text not null,
    table_number   integer,
    created_at     timestamptz not null default now()
);

-- One row per phone (anonymous auth user) that has done anything.
create table if not exists public.guests (
    id           uuid primary key references auth.users (id) on delete cascade,
    display_name text,
    pass_token   text references public.passes (token) on delete set null,
    first_seen   timestamptz not null default now(),
    last_seen    timestamptz not null default now()
);

create table if not exists public.tracks (
    id           serial primary key,
    spotify_id   text unique,
    title        text not null,
    artist       text not null,
    album        text,
    artwork_url  text,
    duration_ms  integer,
    explicit     boolean not null default false,
    preview_url  text,
    created_at   timestamptz not null default now()
);
create unique index if not exists idx_tracks_manual_key
    on public.tracks (lower(artist), lower(title)) where spotify_id is null;

create table if not exists public.song_requests (
    id             serial primary key,
    event_id       integer not null references public.events (id) on delete cascade,
    track_id       integer not null references public.tracks (id),
    requested_by   uuid references public.guests (id) on delete set null,
    requester_name text,
    status         text not null default 'queued'
                   check (status in ('queued', 'played', 'hidden')),
    played_at      timestamptz,
    created_at     timestamptz not null default now(),
    unique (event_id, track_id)
);
create index if not exists idx_requests_event_status
    on public.song_requests (event_id, status);
create index if not exists idx_requests_guest
    on public.song_requests (requested_by, created_at desc);

create table if not exists public.votes (
    id          serial primary key,
    request_id  integer not null references public.song_requests (id) on delete cascade,
    guest_id    uuid not null references public.guests (id) on delete cascade,
    created_at  timestamptz not null default now(),
    unique (request_id, guest_id)
);
create index if not exists idx_votes_guest_recent
    on public.votes (guest_id, created_at desc);

create table if not exists public.block_rules (
    id         serial primary key,
    kind       text not null check (kind in ('spotify_id', 'artist', 'title', 'keyword')),
    pattern    text not null,
    reason     text,
    active     boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index if not exists idx_block_rules_key
    on public.block_rules (kind, lower(pattern));

-- Reserved for capturing what the DJ actually played (see DESIGN.md).
create table if not exists public.played_tracks (
    id         serial primary key,
    event_id   integer not null references public.events (id) on delete cascade,
    track_id   integer references public.tracks (id),
    raw_title  text,
    raw_artist text,
    played_at  timestamptz not null,
    source     text not null check (source in ('dj_marked', 'dj_export', 'listener')),
    created_at timestamptz not null default now()
);

create table if not exists app_private.settings (
    id             boolean primary key default true check (id),
    admin_key_hash text
);
insert into app_private.settings default values on conflict do nothing;

insert into public.events (slug, name, event_date)
values ('wedding', 'Katarina & Trevor', '2026-11-21')
on conflict (slug) do nothing;

insert into public.block_rules (kind, pattern, reason) values
    ('keyword', 'Chicken Dance', 'Example rule. Delete it in the DJ view.'),
    ('keyword', 'Cha Cha Slide', 'Example rule. Delete it in the DJ view.')
on conflict do nothing;

-- Lock every table down: RLS on, no policies, no grants to API roles.
do $$
declare t text;
begin
    foreach t in array array['events', 'passes', 'guests', 'tracks', 'song_requests',
                             'votes', 'block_rules', 'played_tracks'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on public.%I from anon, authenticated', t);
    end loop;
end $$;

-- --------------------------------------------------------------- helpers --

create or replace function app_private.fail(p_code text, p_message text, p_retry_after integer default null)
returns void language plpgsql as $$
begin
    raise exception using errcode = 'P0001', message = p_message, detail = p_code,
                          hint = coalesce(p_retry_after::text, '');
end $$;

create or replace function app_private.pretty(p_seconds integer)
returns text language sql immutable as $$
    select case
        when p_seconds < 60 then p_seconds || 's'
        when round(p_seconds / 60.0) = 1 then '1 minute'
        else round(p_seconds / 60.0)::int || ' minutes'
    end
$$;

create or replace function app_private.the_event()
returns public.events language sql stable as $$
    select * from public.events where slug = 'wedding'
$$;

create or replace function app_private.set_admin_key(p_key text)
returns void language sql as $$
    update app_private.settings
       set admin_key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
$$;

create or replace function app_private.require_admin(p_key text)
returns void language plpgsql stable as $$
declare want text;
begin
    select admin_key_hash into want from app_private.settings;
    if want is null or p_key is null or length(p_key) < 16
       or encode(extensions.digest(p_key, 'sha256'), 'hex') <> want then
        perform app_private.fail('not_admin', 'That DJ link is not valid.');
    end if;
end $$;

create or replace function app_private.touch_guest(p_guest uuid, p_name text default null)
returns void language sql as $$
    insert into public.guests (id, display_name)
    values (p_guest, nullif(left(trim(p_name), 60), ''))
    on conflict (id) do update
        set last_seen = now(),
            display_name = coalesce(excluded.display_name, public.guests.display_name)
$$;

-- The block list. Returns the reason a track is blocked, or null if allowed.
create or replace function app_private.blocked_reason(
    p_spotify_id text, p_title text, p_artist text, p_explicit boolean)
returns text language sql stable as $$
    select coalesce(
        (select 'Explicit tracks are turned off for this event.'
           from app_private.the_event() e
          where e.block_explicit and coalesce(p_explicit, false)),
        (select coalesce(r.reason, 'That one is on the do-not-play list. Pick another!')
           from public.block_rules r
          where r.active and trim(r.pattern) <> ''
            and case r.kind
                when 'spotify_id' then p_spotify_id is not null and p_spotify_id = trim(r.pattern)
                when 'artist'  then strpos(lower(coalesce(p_artist, '')), lower(trim(r.pattern))) > 0
                when 'title'   then strpos(lower(coalesce(p_title, '')), lower(trim(r.pattern))) > 0
                when 'keyword' then strpos(lower(coalesce(p_title, '')), lower(trim(r.pattern))) > 0
                                 or strpos(lower(coalesce(p_artist, '')), lower(trim(r.pattern))) > 0
                else false end
          order by r.id limit 1))
$$;

create or replace function app_private.seconds_left(p_last timestamptz, p_cooldown integer)
returns integer language sql stable as $$
    select case when p_last is null or p_cooldown <= 0 then 0
                else greatest(0, round(p_cooldown - extract(epoch from now() - p_last)))::int end
$$;

create or replace function app_private.vote_cooldown_left(p_guest uuid, p_cooldown integer)
returns integer language sql stable as $$
    select app_private.seconds_left(
        (select max(created_at) from public.votes where guest_id = p_guest), p_cooldown)
$$;

create or replace function app_private.leaderboard(p_event integer, p_guest uuid, p_include_hidden boolean)
returns jsonb language sql stable as $$
    select coalesce(jsonb_agg(row_to_json(b) order by b.played, b.votes desc, b.created_at), '[]'::jsonb)
    from (
        select r.id, r.status, r.requester_name, r.created_at, r.played_at,
               t.spotify_id, t.title, t.artist, t.album, t.artwork_url, t.duration_ms,
               (r.status = 'played') as played,
               count(v.id)::int as votes,
               coalesce(bool_or(v.guest_id = p_guest), false) as voted
        from public.song_requests r
        join public.tracks t on t.id = r.track_id
        left join public.votes v on v.request_id = r.id
        where r.event_id = p_event and (p_include_hidden or r.status <> 'hidden')
        group by r.id, t.id
    ) b
$$;

create or replace function app_private.cast_vote(p_event public.events, p_request integer, p_guest uuid)
returns jsonb language plpgsql as $$
declare
    req public.song_requests;
    wait integer;
begin
    if not p_event.voting_open then
        perform app_private.fail('voting_closed', 'Voting is closed for now.');
    end if;
    perform app_private.touch_guest(p_guest);

    select * into req from public.song_requests where id = p_request and event_id = p_event.id;
    if not found or req.status = 'hidden' then
        perform app_private.fail('not_found', 'That song is not on the list.');
    end if;
    if req.status <> 'queued' then
        perform app_private.fail('not_votable', 'That one has already been played.');
    end if;
    if exists (select 1 from public.votes where request_id = p_request and guest_id = p_guest) then
        perform app_private.fail('already_voted', 'You have already voted for that one.');
    end if;

    wait := app_private.vote_cooldown_left(p_guest, p_event.vote_cooldown_seconds);
    if wait > 0 then
        perform app_private.fail('vote_cooldown',
            'One vote at a time. Try again in ' || app_private.pretty(wait) || '.', wait);
    end if;

    begin
        insert into public.votes (request_id, guest_id) values (p_request, p_guest);
    exception when unique_violation then
        perform app_private.fail('already_voted', 'You have already voted for that one.');
    end;
    return jsonb_build_object('request_id', p_request, 'action', 'voted');
end $$;

-- ------------------------------------------------------ guest-facing RPCs --

create or replace function public.song_board()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    e public.events := app_private.the_event();
    me uuid := auth.uid();
    g public.guests;
begin
    select * into g from public.guests where id = me;
    return jsonb_build_object(
        'requests_open', e.requests_open,
        'voting_open', e.voting_open,
        'vote_cooldown_seconds', e.vote_cooldown_seconds,
        'vote_cooldown_remaining', case when me is null then 0
                                        else app_private.vote_cooldown_left(me, e.vote_cooldown_seconds) end,
        'me', jsonb_build_object('name', g.display_name, 'from_pass', g.pass_token is not null),
        'requests', (select coalesce(jsonb_agg(x - 'played' - 'played_at' - 'created_at'), '[]'::jsonb)
                       from jsonb_array_elements(app_private.leaderboard(e.id, me, false)) x)
    );
end $$;

create or replace function public.vote(p_request_id integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
    if auth.uid() is null then
        perform app_private.fail('no_session', 'Reload the page and try again.');
    end if;
    return app_private.cast_vote(app_private.the_event(), p_request_id, auth.uid());
end $$;

create or replace function public.set_display_name(p_name text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
    if auth.uid() is null then
        perform app_private.fail('no_session', 'Reload the page and try again.');
    end if;
    -- A pass name wins over a typed one.
    insert into public.guests (id, display_name) values (auth.uid(), nullif(left(trim(p_name), 60), ''))
    on conflict (id) do update
        set display_name = case when public.guests.pass_token is null
                                then excluded.display_name else public.guests.display_name end,
            last_seen = now();
end $$;

-- Links this phone to a printed boarding pass. Requests and votes then show
-- the guest's name ("Katarina K.") without them typing it.
create or replace function public.claim_pass(p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.passes; shown text;
begin
    if auth.uid() is null then
        perform app_private.fail('no_session', 'Reload the page and try again.');
    end if;
    select * into p from public.passes where token = trim(p_token);
    if not found then
        perform app_private.fail('unknown_pass', 'We could not find that boarding pass.');
    end if;
    shown := p.first_name || ' ' || left(p.last_name, 1) || '.';
    insert into public.guests (id, display_name, pass_token) values (auth.uid(), shown, p.token)
    on conflict (id) do update
        set display_name = excluded.display_name, pass_token = excluded.pass_token, last_seen = now();
    update public.song_requests set requester_name = shown
     where requested_by = auth.uid() and requester_name is distinct from shown;
    return jsonb_build_object('name', shown, 'first_name', p.first_name, 'table_number', p.table_number);
end $$;

-- ------------------------------------------- called by the Edge Function --

-- Filters Spotify search results through the block list, so a guest never
-- picks a song only to be refused.
create or replace function public.allowed_tracks(p_tracks jsonb)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(jsonb_agg(t order by n), '[]'::jsonb)
    from jsonb_array_elements(p_tracks) with ordinality as x(t, n)
    where app_private.blocked_reason(t->>'spotify_id', t->>'title', t->>'artist',
                                     coalesce((t->>'explicit')::boolean, false)) is null
$$;

-- Put a song on the board for p_guest. If it is already there, this is an
-- upvote instead: that is what the guest meant, and it keeps the board
-- free of duplicates.
create or replace function public.submit_request_as(p_guest uuid, p_track jsonb, p_requester_name text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    e public.events := app_private.the_event();
    v_title  text := nullif(trim(p_track->>'title'), '');
    v_artist text := nullif(trim(p_track->>'artist'), '');
    v_sid    text := nullif(trim(p_track->>'spotify_id'), '');
    v_reason text;
    v_track  integer;
    v_req    public.song_requests;
    v_name   text;
    v_count  integer;
    wait     integer;
begin
    if not e.requests_open then
        perform app_private.fail('requests_closed', 'Song requests are closed for now.');
    end if;
    if v_title is null or v_artist is null then
        perform app_private.fail('incomplete_track', 'Give both a song title and an artist.');
    end if;

    perform app_private.touch_guest(p_guest, case when (select pass_token from public.guests where id = p_guest) is null
                                                  then p_requester_name end);

    v_reason := app_private.blocked_reason(v_sid, v_title, v_artist,
                                           coalesce((p_track->>'explicit')::boolean, false));
    if v_reason is not null then
        perform app_private.fail('blocked', v_reason);
    end if;

    if v_sid is not null then
        insert into public.tracks (spotify_id, title, artist, album, artwork_url, duration_ms, explicit, preview_url)
        values (v_sid, v_title, v_artist, p_track->>'album', p_track->>'artwork_url',
                (p_track->>'duration_ms')::int, coalesce((p_track->>'explicit')::boolean, false),
                p_track->>'preview_url')
        on conflict (spotify_id) do update
            set title = excluded.title, artist = excluded.artist,
                album = excluded.album, artwork_url = excluded.artwork_url
        returning id into v_track;
    else
        select id into v_track from public.tracks
         where spotify_id is null and lower(artist) = lower(v_artist) and lower(title) = lower(v_title);
        if v_track is null then
            insert into public.tracks (title, artist) values (v_title, v_artist)
            on conflict (lower(artist), lower(title)) where spotify_id is null do nothing
            returning id into v_track;
            if v_track is null then
                select id into v_track from public.tracks
                 where spotify_id is null and lower(artist) = lower(v_artist) and lower(title) = lower(v_title);
            end if;
        end if;
    end if;

    select * into v_req from public.song_requests where event_id = e.id and track_id = v_track;
    if found then
        if v_req.status = 'hidden' then
            perform app_private.fail('blocked', 'That song is not available to request.');
        end if;
        return app_private.cast_vote(e, v_req.id, p_guest) || jsonb_build_object('action', 'voted');
    end if;

    select count(*) into v_count from public.song_requests
     where requested_by = p_guest and event_id = e.id and status <> 'hidden';
    if e.max_requests_per_guest > 0 and v_count >= e.max_requests_per_guest then
        perform app_private.fail('request_cap',
            'You have already put in ' || e.max_requests_per_guest || ' songs. Upvote someone else''s instead!');
    end if;

    wait := app_private.seconds_left(
        (select max(created_at) from public.song_requests where requested_by = p_guest and event_id = e.id),
        e.request_cooldown_seconds);
    if wait > 0 then
        perform app_private.fail('request_cooldown',
            'Give it ' || app_private.pretty(wait) || ' before adding another song.', wait);
    end if;

    select display_name into v_name from public.guests where id = p_guest;
    insert into public.song_requests (event_id, track_id, requested_by, requester_name)
    values (e.id, v_track, p_guest, v_name)
    on conflict (event_id, track_id) do nothing
    returning * into v_req;
    if v_req.id is null then
        -- Someone else requested it a moment ago: same as the branch above.
        select * into v_req from public.song_requests where event_id = e.id and track_id = v_track;
        return app_private.cast_vote(e, v_req.id, p_guest) || jsonb_build_object('action', 'voted');
    end if;

    -- The requester's own vote. It counts toward their vote cooldown, so adding
    -- a song and immediately upvoting another one isn't free.
    insert into public.votes (request_id, guest_id) values (v_req.id, p_guest) on conflict do nothing;
    return jsonb_build_object('request_id', v_req.id, 'action', 'created');
end $$;

-- ------------------------------------------------------------- DJ RPCs --

create or replace function public.admin_board(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.events;
begin
    perform app_private.require_admin(p_key);
    e := app_private.the_event();
    return jsonb_build_object(
        'event', to_jsonb(e),
        'requests', app_private.leaderboard(e.id, null, true),
        'rules', (select coalesce(jsonb_agg(to_jsonb(r) order by r.kind, lower(r.pattern)), '[]'::jsonb)
                    from public.block_rules r)
    );
end $$;

create or replace function public.admin_set_status(p_key text, p_request_id integer, p_status text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_admin(p_key);
    if p_status not in ('queued', 'played', 'hidden') then
        perform app_private.fail('bad_status', 'Unknown status.');
    end if;
    update public.song_requests
       set status = p_status,
           played_at = case when p_status = 'played' then now() else null end
     where id = p_request_id and event_id = (app_private.the_event()).id;
end $$;

-- p_settings: any of requests_open, voting_open, block_explicit (booleans) and
-- vote_cooldown_seconds, request_cooldown_seconds, max_requests_per_guest
-- (non-negative integers). Missing keys are left alone.
create or replace function public.admin_update_event(p_key text, p_settings jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_admin(p_key);
    update public.events set
        requests_open  = coalesce((p_settings->>'requests_open')::boolean, requests_open),
        voting_open    = coalesce((p_settings->>'voting_open')::boolean, voting_open),
        block_explicit = coalesce((p_settings->>'block_explicit')::boolean, block_explicit),
        vote_cooldown_seconds    = greatest(0, coalesce((p_settings->>'vote_cooldown_seconds')::int, vote_cooldown_seconds)),
        request_cooldown_seconds = greatest(0, coalesce((p_settings->>'request_cooldown_seconds')::int, request_cooldown_seconds)),
        max_requests_per_guest   = greatest(0, coalesce((p_settings->>'max_requests_per_guest')::int, max_requests_per_guest))
    where slug = 'wedding';
end $$;

create or replace function public.admin_add_block_rule(
    p_key text, p_kind text, p_pattern text, p_reason text default null, p_hide_request_id integer default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_admin(p_key);
    if nullif(trim(p_pattern), '') is null then
        perform app_private.fail('empty_pattern', 'A block rule needs something to match.');
    end if;
    if p_kind not in ('spotify_id', 'artist', 'title', 'keyword') then
        perform app_private.fail('bad_kind', 'Unknown kind of rule.');
    end if;
    insert into public.block_rules (kind, pattern, reason)
    values (p_kind, trim(p_pattern), nullif(trim(p_reason), ''))
    on conflict (kind, lower(pattern)) do update set active = true, reason = excluded.reason;
    if p_hide_request_id is not null then
        update public.song_requests set status = 'hidden', played_at = null
         where id = p_hide_request_id and event_id = (app_private.the_event()).id;
    end if;
end $$;

create or replace function public.admin_delete_block_rule(p_key text, p_rule_id integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_admin(p_key);
    delete from public.block_rules where id = p_rule_id;
end $$;

-- -------------------------------------------------------------- grants --

revoke all on all functions in schema app_private from public;
revoke all on function public.song_board(), public.vote(integer), public.set_display_name(text),
    public.claim_pass(text), public.allowed_tracks(jsonb), public.submit_request_as(uuid, jsonb, text),
    public.admin_board(text), public.admin_set_status(text, integer, text),
    public.admin_update_event(text, jsonb),
    public.admin_add_block_rule(text, text, text, text, integer),
    public.admin_delete_block_rule(text, integer)
    from public, anon, authenticated;

grant execute on function public.song_board() to anon, authenticated;
grant execute on function public.vote(integer), public.set_display_name(text),
    public.claim_pass(text) to authenticated;
grant execute on function public.allowed_tracks(jsonb), public.submit_request_as(uuid, jsonb, text)
    to service_role;
grant execute on function public.admin_board(text), public.admin_set_status(text, integer, text),
    public.admin_update_event(text, jsonb),
    public.admin_add_block_rule(text, text, text, text, integer),
    public.admin_delete_block_rule(text, integer) to anon, authenticated;
