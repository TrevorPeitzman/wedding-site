-- Disposable camera (Phase 5).
--
-- Each guest's printed pass is good for `shots_per_pass` photos (12), shared by
-- every phone that claimed that pass. A photo first reserves a slot here
-- (reserve_shot), then the `camera` Edge Function hands the phone a signed
-- upload URL for that slot's path in the private `photos` bucket, then the
-- phone calls confirm_shot, which checks the file really is in storage.
-- A retry reuses its slot (same client_id), so it never costs a shot.
--
-- No peeking: guests never get their photos back before the reveal. After
-- `photos_reveal_at`, the Edge Function returns signed URLs for everyone's
-- uploaded photos to any phone holding a claimed pass.
--
-- Release early:  update public.events set photos_reveal_at = now();
-- Close camera:   update public.events set camera_open = false;

alter table public.events
    add column if not exists camera_open      boolean not null default true,
    add column if not exists shots_per_pass   integer not null default 12,
    add column if not exists photos_reveal_at timestamptz default '2026-11-22 23:00:00-08';

create table if not exists public.photos (
    id           uuid primary key default gen_random_uuid(),
    pass_token   text not null references public.passes (token) on delete cascade,
    guest_id     uuid references public.guests (id) on delete set null,
    client_id    uuid not null unique,         -- made on the phone; retries reuse it
    path         text not null unique,         -- object name in the photos bucket
    status       text not null default 'reserved'
                 check (status in ('reserved', 'uploaded', 'removed')),
    bytes        integer,
    reserved_at  timestamptz not null default now(),
    uploaded_at  timestamptz
);
create index if not exists idx_photos_pass on public.photos (pass_token);
create index if not exists idx_photos_uploaded on public.photos (uploaded_at) where status = 'uploaded';

alter table public.photos enable row level security;
revoke all on public.photos from anon, authenticated;

-- The bucket is also declared in supabase/config.toml (which the GitHub
-- integration deploys); this keeps a plain `db push` working too.
do $$
begin
    if to_regclass('storage.buckets') is not null then
        insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        values ('photos', 'photos', false, 8388608, array['image/jpeg'])
        on conflict (id) do nothing;
    end if;
end $$;

-- ---------------------------------------------------------------- helpers --

create or replace function app_private.my_pass()
returns public.passes language sql stable set search_path = public, pg_temp as $$
    select p.* from public.guests g join public.passes p on p.token = g.pass_token
    where g.id = auth.uid()
$$;

create or replace function app_private.shots_used(p_token text)
returns integer language sql stable set search_path = public, pg_temp as $$
    select count(*)::int from public.photos
    where pass_token = p_token and status in ('reserved', 'uploaded', 'removed')
$$;

-- ------------------------------------------------------- guest-facing RPCs --

create or replace function public.camera_status()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
    e public.events := app_private.the_event();
    p public.passes;
    used integer := 0;
begin
    if auth.uid() is not null then
        p := app_private.my_pass();
    end if;
    if p.token is not null then
        used := app_private.shots_used(p.token);
    end if;
    return jsonb_build_object(
        'open', e.camera_open,
        'has_pass', p.token is not null,
        'first_name', p.first_name,
        'shots_per_pass', e.shots_per_pass,
        'used', used,
        'left', greatest(0, e.shots_per_pass - used),
        'uploaded', (select count(*) from public.photos where pass_token = p.token and status = 'uploaded'),
        'reveal_at', e.photos_reveal_at,
        'revealed', e.photos_reveal_at is not null and now() >= e.photos_reveal_at,
        -- This pass's shots, oldest first: status only, never the photo.
        'shots', (select coalesce(jsonb_agg(jsonb_build_object('client_id', client_id, 'status', status)
                                  order by reserved_at), '[]'::jsonb)
                    from public.photos where pass_token = p.token)
    );
end $$;

-- Reserves (or, for a retry, returns) the slot for one photo.
create or replace function public.reserve_shot(p_client_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    e public.events := app_private.the_event();
    p public.passes;
    ph public.photos;
    used integer;
    new_id uuid;
begin
    if auth.uid() is null then
        perform app_private.fail('no_session', 'Reload the page and try again.');
    end if;
    p := app_private.my_pass();
    if p.token is null then
        perform app_private.fail('no_pass', 'Scan the QR on your boarding pass to use the camera.');
    end if;

    select * into ph from public.photos where client_id = p_client_id;
    if found then
        if ph.pass_token <> p.token then
            perform app_private.fail('not_yours', 'That photo belongs to another pass.');
        end if;
        return jsonb_build_object('photo_id', ph.id, 'path', ph.path, 'status', ph.status,
                                  'left', greatest(0, e.shots_per_pass - app_private.shots_used(p.token)));
    end if;

    if not e.camera_open then
        perform app_private.fail('camera_closed', 'The camera is closed right now.');
    end if;

    -- Serialize reservations per pass, so two phones can't both take shot 12.
    perform 1 from public.passes where token = p.token for update;
    used := app_private.shots_used(p.token);
    if used >= e.shots_per_pass then
        perform app_private.fail('out_of_shots',
            'That''s all ' || e.shots_per_pass || ' shots on this pass. Thank you!');
    end if;

    new_id := gen_random_uuid();
    insert into public.photos (id, pass_token, guest_id, client_id, path)
    values (new_id, p.token, auth.uid(), p_client_id, new_id::text || '.jpg')
    returning * into ph;

    return jsonb_build_object('photo_id', ph.id, 'path', ph.path, 'status', ph.status,
                              'left', e.shots_per_pass - used - 1);
end $$;

-- Marks a slot uploaded once its file is really in the photos bucket.
create or replace function public.confirm_shot(p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
    p public.passes;
    ph public.photos;
    size bigint;
begin
    if auth.uid() is null then
        perform app_private.fail('no_session', 'Reload the page and try again.');
    end if;
    p := app_private.my_pass();
    select * into ph from public.photos where id = p_photo_id;
    if not found or p.token is null or ph.pass_token <> p.token then
        perform app_private.fail('not_found', 'We couldn''t find that photo.');
    end if;
    if ph.status = 'uploaded' then
        return jsonb_build_object('photo_id', ph.id, 'status', ph.status);
    end if;

    select (o.metadata->>'size')::bigint into size
      from storage.objects o where o.bucket_id = 'photos' and o.name = ph.path;
    if not found then
        perform app_private.fail('not_uploaded', 'That photo hasn''t finished uploading yet.');
    end if;

    update public.photos set status = 'uploaded', bytes = size, uploaded_at = now()
     where id = ph.id returning * into ph;
    return jsonb_build_object('photo_id', ph.id, 'status', ph.status);
end $$;

-- ---------------------------------------------- called by the Edge Function --

-- The photo paths a guest may see: everyone's, but only after the reveal and
-- only for a phone holding a claimed pass.
create or replace function public.gallery_paths_as(p_guest uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.events := app_private.the_event();
begin
    if not exists (select 1 from public.guests where id = p_guest and pass_token is not null) then
        perform app_private.fail('no_pass', 'Scan the QR on your boarding pass to see the photos.');
    end if;
    if e.photos_reveal_at is null or now() < e.photos_reveal_at then
        perform app_private.fail('not_revealed', 'The photos aren''t out yet.');
    end if;
    return (select coalesce(jsonb_agg(path order by uploaded_at), '[]'::jsonb)
              from public.photos where status = 'uploaded');
end $$;

-- ------------------------------------------------------------- organizer --

create or replace function public.admin_camera(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.events;
begin
    perform app_private.require_admin(p_key);
    e := app_private.the_event();
    return jsonb_build_object(
        'open', e.camera_open, 'shots_per_pass', e.shots_per_pass, 'reveal_at', e.photos_reveal_at,
        'uploaded', (select count(*) from public.photos where status = 'uploaded'),
        'reserved', (select count(*) from public.photos where status = 'reserved'),
        'passes_shooting', (select count(distinct pass_token) from public.photos),
        'bytes', (select coalesce(sum(bytes), 0) from public.photos where status = 'uploaded'));
end $$;

-- admin_update_event gains the camera settings: camera_open (boolean),
-- shots_per_pass (integer), photos_reveal_at (timestamp, or "now").
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
        max_requests_per_guest   = greatest(0, coalesce((p_settings->>'max_requests_per_guest')::int, max_requests_per_guest)),
        camera_open      = coalesce((p_settings->>'camera_open')::boolean, camera_open),
        shots_per_pass   = greatest(0, coalesce((p_settings->>'shots_per_pass')::int, shots_per_pass)),
        photos_reveal_at = case
            when p_settings->>'photos_reveal_at' = 'now' then now()
            when p_settings ? 'photos_reveal_at' then (p_settings->>'photos_reveal_at')::timestamptz
            else photos_reveal_at end
    where slug = 'wedding';
end $$;

-- -------------------------------------------------------------- grants --

revoke all on function app_private.my_pass(), app_private.shots_used(text) from public;
revoke all on function public.camera_status(), public.reserve_shot(uuid), public.confirm_shot(uuid),
    public.gallery_paths_as(uuid), public.admin_camera(text)
    from public, anon, authenticated;

grant execute on function public.camera_status() to anon, authenticated;
grant execute on function public.reserve_shot(uuid), public.confirm_shot(uuid) to authenticated;
grant execute on function public.gallery_paths_as(uuid) to service_role;
grant execute on function public.admin_camera(text) to anon, authenticated;
