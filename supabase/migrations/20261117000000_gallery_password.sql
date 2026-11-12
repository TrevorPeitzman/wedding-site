-- The photo gallery: a boarding pass on the phone, OR the one shared
-- password (the same one as our Zola site), for guests at home without
-- their paper pass. Set from /admin/ (or by SQL); only a bcrypt hash is
-- kept. Compared ignoring case and surrounding spaces, so a guest's
-- autocapitalised first letter doesn't lock them out.
--
-- A phone that gets it right is remembered (guests.gallery_unlocked_at,
-- on its anonymous session); ten wrong tries in 15 minutes pause it.

alter table app_private.settings add column if not exists gallery_password_hash text;
alter table public.guests add column if not exists gallery_unlocked_at timestamptz;

create table if not exists app_private.gallery_attempts (
    id       bigserial primary key,
    guest_id uuid not null,
    at       timestamptz not null default now()
);
create index if not exists idx_gallery_attempts on app_private.gallery_attempts (guest_id, at);

create or replace function app_private.set_gallery_password(p_password text)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
    if p_password is null or length(trim(p_password)) < 4 then
        raise exception 'The gallery password needs at least 4 characters. Nothing was changed.'
            using detail = 'password_too_short';
    end if;
    update app_private.settings
       set gallery_password_hash = extensions.crypt(lower(trim(p_password)), extensions.gen_salt('bf', 8))
     where id;
end $$;

create or replace function app_private.gallery_access(p_guest uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
    select exists (select 1 from public.guests
                    where id = p_guest and (pass_token is not null or gallery_unlocked_at is not null))
$$;

-- What the photos page needs to know before it asks for anything.
create or replace function public.gallery_status()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.events := app_private.the_event();
begin
    return jsonb_build_object(
        'has_pass', exists (select 1 from public.guests where id = auth.uid() and pass_token is not null),
        'access', auth.uid() is not null and app_private.gallery_access(auth.uid()),
        'password_set', (select gallery_password_hash is not null from app_private.settings),
        'reveal_at', e.photos_reveal_at,
        'revealed', e.photos_reveal_at is not null and now() >= e.photos_reveal_at);
end $$;

create or replace function public.unlock_gallery(p_password text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare want text; tries integer;
begin
    if auth.uid() is null then
        perform app_private.fail('no_session', 'Reload the page and try again.');
    end if;
    select gallery_password_hash into want from app_private.settings;
    if want is null then
        perform app_private.fail('no_password', 'The gallery isn''t open with a password yet. Scan the QR on your boarding pass instead.');
    end if;
    select count(*) into tries from app_private.gallery_attempts
     where guest_id = auth.uid() and at > now() - interval '15 minutes';
    if tries >= 10 then
        perform app_private.fail('too_many_tries', 'Too many tries. Wait 15 minutes, then try again.', 900);
    end if;
    -- A wrong try is answered, not raised: raising would roll back the
    -- record of the try, and the pause above would never come.
    if p_password is null or extensions.crypt(lower(trim(p_password)), want) <> want then
        insert into app_private.gallery_attempts (guest_id) values (auth.uid());
        return jsonb_build_object('access', false, 'code', 'wrong_password',
            'message', 'That isn''t the password. It''s the same one as our wedding website on Zola.');
    end if;
    perform app_private.touch_guest(auth.uid());
    update public.guests set gallery_unlocked_at = coalesce(gallery_unlocked_at, now()) where id = auth.uid();
    delete from app_private.gallery_attempts where guest_id = auth.uid();
    return jsonb_build_object('access', true);
end $$;

-- The organizer screen: set or change it, and see whether one is set.
create or replace function public.admin_gallery_password(p_key text, p_password text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_organizer(p_key);
    if p_password is not null then
        if length(trim(p_password)) < 4 then
            perform app_private.fail('too_short', 'The password needs at least 4 characters.');
        end if;
        perform app_private.set_gallery_password(p_password);
    end if;
    return jsonb_build_object(
        'set', (select gallery_password_hash is not null from app_private.settings),
        'phones', (select count(*) from public.guests where gallery_unlocked_at is not null));
end $$;

-- The gallery itself: a pass or the password, then the reveal.
create or replace function public.gallery_paths_as(p_guest uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare e public.events := app_private.the_event();
begin
    if not app_private.gallery_access(p_guest) then
        perform app_private.fail('no_access', 'Enter the password, or scan the QR on your boarding pass, to see the photos.');
    end if;
    if e.photos_reveal_at is null or now() < e.photos_reveal_at then
        perform app_private.fail('not_revealed', 'The photos aren''t out yet.');
    end if;
    return (select coalesce(jsonb_agg(f.path order by f.uploaded_at), '[]'::jsonb)
              from public.photos f join public.passes p on p.token = f.pass_token
             where f.status = 'uploaded' and not p.is_test);
end $$;

revoke all on function app_private.set_gallery_password(text), app_private.gallery_access(uuid) from public, anon, authenticated;
revoke all on function public.gallery_status(), public.unlock_gallery(text), public.admin_gallery_password(text, text)
    from public, anon, authenticated;
grant execute on function public.gallery_status(), public.admin_gallery_password(text, text) to anon, authenticated;
grant execute on function public.unlock_gallery(text) to authenticated;
revoke all on function public.gallery_paths_as(uuid) from public, anon, authenticated;
grant execute on function public.gallery_paths_as(uuid) to service_role;
