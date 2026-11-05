-- The photo album: pictures from other cameras (a photographer, friends),
-- uploaded from /admin/ and shown to guests with everyone's photos after
-- the reveal, full size to save.
--
-- Each photo is two files in the private `album` bucket: the original
-- (<id>/full.<ext>, kept as uploaded) and a 2048px JPEG made in the browser
-- (<id>/web.jpg) for the grid. The `camera` Edge Function signs the uploads
-- and the links; these functions hold the rules. Organizer key throughout.

do $$
begin
    if to_regclass('storage.buckets') is not null then
        insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
        values ('album', 'album', false, 41943040, array['image/jpeg', 'image/png', 'image/webp'])
        on conflict (id) do nothing;
    end if;
end $$;

create table if not exists public.album_photos (
    id            uuid primary key default gen_random_uuid(),
    ext           text not null check (ext in ('jpg', 'png', 'webp')),
    original_name text,
    credit        text,
    bytes         bigint,
    status        text not null default 'reserved' check (status in ('reserved', 'uploaded', 'hidden')),
    created_at    timestamptz not null default now(),
    uploaded_at   timestamptz
);
alter table public.album_photos enable row level security;
revoke all on public.album_photos from anon, authenticated;

create or replace function app_private.album_json(a public.album_photos)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
    select jsonb_build_object('id', a.id, 'full_path', a.id || '/full.' || a.ext, 'web_path', a.id || '/web.jpg',
                              'ext', a.ext, 'name', a.original_name, 'credit', a.credit, 'bytes', a.bytes,
                              'hidden', a.status = 'hidden', 'uploaded_at', a.uploaded_at)
$$;

create or replace function public.admin_album_reserve(p_key text, p_name text, p_ext text, p_credit text default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.album_photos;
begin
    perform app_private.require_organizer(p_key);
    if p_ext is null or lower(p_ext) not in ('jpg', 'jpeg', 'png', 'webp') then
        perform app_private.fail('bad_type', 'JPEG, PNG or WebP photos only.');
    end if;
    insert into public.album_photos (ext, original_name, credit)
    values (case lower(p_ext) when 'jpeg' then 'jpg' else lower(p_ext) end,
            left(p_name, 200), nullif(left(trim(p_credit), 120), ''))
    returning * into a;
    return app_private.album_json(a);
end $$;

-- Both files must be in Storage before a photo counts as uploaded.
create or replace function public.admin_album_confirm(p_key text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.album_photos; size bigint;
begin
    perform app_private.require_organizer(p_key);
    select * into a from public.album_photos where id = p_id;
    if not found then
        perform app_private.fail('not_found', 'We couldn''t find that photo.');
    end if;
    select (o.metadata->>'size')::bigint into size
      from storage.objects o where o.bucket_id = 'album' and o.name = a.id || '/full.' || a.ext;
    if not found or not exists (select 1 from storage.objects o
                                 where o.bucket_id = 'album' and o.name = a.id || '/web.jpg') then
        perform app_private.fail('not_uploaded', 'That photo hasn''t finished uploading yet.');
    end if;
    update public.album_photos
       set status = case when status = 'hidden' then 'hidden' else 'uploaded' end,
           bytes = size, uploaded_at = coalesce(uploaded_at, now())
     where id = p_id returning * into a;
    return app_private.album_json(a);
end $$;

create or replace function public.admin_album(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_organizer(p_key);
    return (select coalesce(jsonb_agg(app_private.album_json(a) order by a.uploaded_at desc), '[]'::jsonb)
              from public.album_photos a where a.status in ('uploaded', 'hidden'));
end $$;

create or replace function public.admin_album_hide(p_key text, p_id uuid, p_hidden boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.album_photos;
begin
    perform app_private.require_organizer(p_key);
    update public.album_photos set status = case when p_hidden then 'hidden' else 'uploaded' end
     where id = p_id and status in ('uploaded', 'hidden') returning * into a;
    if a.id is null then
        perform app_private.fail('not_found', 'We couldn''t find that photo.');
    end if;
    return app_private.album_json(a);
end $$;

-- Deletes the row; returns the two paths for the Edge Function to remove.
create or replace function public.admin_album_delete(p_key text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.album_photos;
begin
    perform app_private.require_organizer(p_key);
    delete from public.album_photos where id = p_id returning * into a;
    if a.id is null then
        perform app_private.fail('not_found', 'We couldn''t find that photo.');
    end if;
    return jsonb_build_array(a.id || '/full.' || a.ext, a.id || '/web.jpg');
end $$;

-- For the gallery, after gallery_paths_as has checked the pass and the
-- reveal. Service role only (the camera Edge Function).
create or replace function public.album_paths()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(jsonb_agg(app_private.album_json(a) order by a.uploaded_at), '[]'::jsonb)
      from public.album_photos a where a.status = 'uploaded'
$$;

revoke all on function app_private.album_json(public.album_photos) from public, anon, authenticated;
revoke all on function public.admin_album_reserve(text, text, text, text), public.admin_album_confirm(text, uuid),
    public.admin_album(text), public.admin_album_hide(text, uuid, boolean), public.admin_album_delete(text, uuid),
    public.album_paths() from public, anon, authenticated;
grant execute on function public.admin_album_reserve(text, text, text, text), public.admin_album_confirm(text, uuid),
    public.admin_album(text), public.admin_album_hide(text, uuid, boolean), public.admin_album_delete(text, uuid)
    to anon, authenticated;
grant execute on function public.album_paths() to service_role;
