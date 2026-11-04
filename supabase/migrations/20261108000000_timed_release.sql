-- Timed release and the organizer key (Phase 6).
--
-- feature_schedule holds, per feature, an on/off switch and an optional
-- opening and closing time. Pages read it through features() (anyone), and
-- the database enforces it for the features it serves: song requests and
-- votes, and the camera. Outside its window a feature is refused, not just
-- hidden. site/assets/features.js is the static fallback when Supabase is
-- unreachable.
--
-- The organizer key (separate from the DJ key) runs the admin screen:
-- feature switches and times, the camera and the photo reveal. It can also
-- do everything the DJ key can. Set it in the SQL editor:
--   select app_private.set_organizer_key('<long random string>');

create table if not exists public.feature_schedule (
    feature    text primary key check (feature in ('schedule', 'details', 'songs', 'camera', 'wallet')),
    is_on      boolean not null default true,
    opens_at   timestamptz,
    closes_at  timestamptz,
    updated_at timestamptz not null default now(),
    check (closes_at is null or opens_at is null or closes_at > opens_at)
);
insert into public.feature_schedule (feature) values
    ('schedule'), ('details'), ('songs'), ('camera'), ('wallet')
on conflict do nothing;
alter table public.feature_schedule enable row level security;
revoke all on public.feature_schedule from anon, authenticated;

alter table app_private.settings add column if not exists organizer_key_hash text;

-- ---------------------------------------------------------------- keys --

create or replace function app_private.set_organizer_key(p_key text)
returns void language sql set search_path = public, pg_temp as $$
    update app_private.settings
       set organizer_key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex')
$$;

create or replace function app_private.require_organizer(p_key text)
returns void language plpgsql stable set search_path = public, pg_temp as $$
declare want text;
begin
    select organizer_key_hash into want from app_private.settings;
    if want is null or p_key is null or length(p_key) < 16
       or encode(extensions.digest(p_key, 'sha256'), 'hex') <> want then
        perform app_private.fail('not_organizer', 'That organizer link is not valid.');
    end if;
end $$;

-- The DJ key, or the organizer key: the organizer can do everything the DJ can.
create or replace function app_private.require_admin(p_key text)
returns void language plpgsql stable set search_path = public, pg_temp as $$
declare s app_private.settings; h text;
begin
    select * into s from app_private.settings;
    h := case when p_key is null or length(p_key) < 16 then null
              else encode(extensions.digest(p_key, 'sha256'), 'hex') end;
    if h is null or h is distinct from coalesce(s.admin_key_hash, '-')
                    and h is distinct from coalesce(s.organizer_key_hash, '-') then
        perform app_private.fail('not_admin', 'That DJ link is not valid.');
    end if;
end $$;

-- ------------------------------------------------------------ schedule --

-- 'off' | 'soon' | 'open' | 'closed'. A feature with no row is open.
create or replace function app_private.feature_state(p_feature text)
returns text language sql stable set search_path = public, pg_temp as $$
    select coalesce((
        select case
            when not f.is_on then 'off'
            when f.opens_at is not null and now() < f.opens_at then 'soon'
            when f.closes_at is not null and now() >= f.closes_at then 'closed'
            else 'open' end
        from public.feature_schedule f where f.feature = p_feature), 'open')
$$;

-- Refuses unless the feature is open. p_name is how a guest would say it
-- ("Song requests", "The camera"); p_plural picks "open"/"opens".
create or replace function app_private.require_feature(p_feature text, p_name text, p_plural boolean)
returns void language plpgsql stable set search_path = public, pg_temp as $$
declare state text := app_private.feature_state(p_feature); f public.feature_schedule;
begin
    if state = 'open' then return; end if;
    select * into f from public.feature_schedule where feature = p_feature;
    if state = 'soon' then
        perform app_private.fail('feature_soon', p_name || case when p_plural then ' open at ' else ' opens at ' end
            || to_char(f.opens_at at time zone 'America/Los_Angeles', 'FMHH12:MI AM') || '.');
    end if;
    perform app_private.fail('feature_closed', p_name || case when p_plural then ' are closed.' else ' is closed.' end);
end $$;

-- What pages read at load: every feature's switch, times and state.
create or replace function public.features()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(jsonb_object_agg(feature, jsonb_build_object(
        'on', is_on, 'opens_at', opens_at, 'closes_at', closes_at,
        'state', app_private.feature_state(feature))), '{}'::jsonb)
    from public.feature_schedule
$$;

-- ------------------------------------------------- enforcement wrappers --
-- The existing functions move into app_private unchanged, and a public
-- wrapper with the same name and signature checks the schedule first.

do $$
begin
    if to_regprocedure('app_private.submit_request_core(uuid, jsonb, text)') is null then
        alter function public.submit_request_as(uuid, jsonb, text) rename to submit_request_core;
        alter function public.submit_request_core(uuid, jsonb, text) set schema app_private;
    end if;
    if to_regprocedure('app_private.reserve_shot_core(uuid)') is null then
        alter function public.reserve_shot(uuid) rename to reserve_shot_core;
        alter function public.reserve_shot_core(uuid) set schema app_private;
    end if;
end $$;
revoke all on function app_private.submit_request_core(uuid, jsonb, text), app_private.reserve_shot_core(uuid)
    from public, anon, authenticated, service_role;

create or replace function public.submit_request_as(p_guest uuid, p_track jsonb, p_requester_name text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_feature('songs', 'Song requests', true);
    return app_private.submit_request_core(p_guest, p_track, p_requester_name);
end $$;

create or replace function public.vote(p_request_id integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
    if auth.uid() is null then
        perform app_private.fail('no_session', 'Reload the page and try again.');
    end if;
    perform app_private.require_feature('songs', 'Song requests', true);
    return app_private.cast_vote(app_private.the_event(), p_request_id, auth.uid());
end $$;

create or replace function public.reserve_shot(p_client_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
    -- A retry of a shot already reserved is always allowed: the photo exists.
    if exists (select 1 from public.photos where client_id = p_client_id) then
        return app_private.reserve_shot_core(p_client_id);
    end if;
    perform app_private.require_feature('camera', 'The camera', false);
    return app_private.reserve_shot_core(p_client_id);
end $$;

-- ---------------------------------------------------------- organizer --

create or replace function public.admin_features(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.events;
begin
    perform app_private.require_organizer(p_key);
    e := app_private.the_event();
    return jsonb_build_object(
        'features', public.features(),
        'camera', jsonb_build_object(
            'open', e.camera_open, 'shots_per_pass', e.shots_per_pass, 'reveal_at', e.photos_reveal_at,
            'uploaded', (select count(*) from public.photos where status = 'uploaded'),
            'reserved', (select count(*) from public.photos where status = 'reserved'),
            'passes_shooting', (select count(distinct pass_token) from public.photos),
            'bytes', (select coalesce(sum(bytes), 0) from public.photos where status = 'uploaded')),
        'passes', (select count(*) from public.passes),
        'passes_claimed', (select count(distinct pass_token) from public.guests where pass_token is not null));
end $$;

create or replace function public.admin_set_feature(
    p_key text, p_feature text, p_on boolean, p_opens_at timestamptz, p_closes_at timestamptz)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_organizer(p_key);
    if p_closes_at is not null and p_opens_at is not null and p_closes_at <= p_opens_at then
        perform app_private.fail('bad_times', 'The closing time has to be after the opening time.');
    end if;
    update public.feature_schedule
       set is_on = coalesce(p_on, is_on), opens_at = p_opens_at, closes_at = p_closes_at, updated_at = now()
     where feature = p_feature;
    if not found then
        perform app_private.fail('bad_feature', 'Unknown feature.');
    end if;
    return public.features();
end $$;

-- Camera settings move to the organizer: shots_per_pass, camera_open and
-- photos_reveal_at (a timestamp, or "now" to release the photos).
create or replace function public.admin_set_camera(p_key text, p_settings jsonb)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_organizer(p_key);
    update public.events set
        camera_open      = coalesce((p_settings->>'camera_open')::boolean, camera_open),
        shots_per_pass   = greatest(0, coalesce((p_settings->>'shots_per_pass')::int, shots_per_pass)),
        photos_reveal_at = case
            when p_settings->>'photos_reveal_at' = 'now' then now()
            when p_settings ? 'photos_reveal_at' then (p_settings->>'photos_reveal_at')::timestamptz
            else photos_reveal_at end
    where slug = 'wedding';
end $$;

-- The DJ's settings, without the camera ones (which the DJ key could set
-- since 20261107000000_camera).
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

-- -------------------------------------------------------------- grants --

revoke all on function app_private.set_organizer_key(text), app_private.require_organizer(text),
    app_private.feature_state(text), app_private.require_feature(text, text, boolean) from public;
revoke all on function public.features(), public.submit_request_as(uuid, jsonb, text),
    public.reserve_shot(uuid), public.admin_features(text),
    public.admin_set_feature(text, text, boolean, timestamptz, timestamptz),
    public.admin_set_camera(text, jsonb)
    from public, anon, authenticated;

grant execute on function public.features() to anon, authenticated;
grant execute on function public.submit_request_as(uuid, jsonb, text) to service_role;
grant execute on function public.reserve_shot(uuid) to authenticated;
grant execute on function public.admin_features(text),
    public.admin_set_feature(text, text, boolean, timestamptz, timestamptz),
    public.admin_set_camera(text, jsonb) to anon, authenticated;
