-- Rehearsal tools (Phase 7).
--
-- Test passes behave like real ones (camera, song names, Wallet card) but
-- their shots can be reset and their photos never reach the gallery. Before
-- the night, delete them and clear the song board from /admin/. All of this
-- is organizer-only. Photo files are removed from Storage by the `camera`
-- Edge Function (action "purge"), which calls these functions and deletes
-- the paths they return.
--
-- Also: indexes for the foreign keys Supabase's performance advisor flagged.

alter table public.passes add column if not exists is_test boolean not null default false;

create index if not exists idx_guests_pass_token on public.guests (pass_token);
create index if not exists idx_photos_guest on public.photos (guest_id);
create index if not exists idx_requests_track on public.song_requests (track_id);

-- Makes test passes until there are p_count of them. Returns them all.
create or replace function public.admin_make_test_passes(p_key text, p_count integer default 3)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare have integer; n integer;
begin
    perform app_private.require_organizer(p_key);
    select count(*) into have from public.passes where is_test;
    for n in have + 1 .. least(greatest(p_count, 0), 10) loop
        insert into public.passes (token, zola_guest_id, first_name, last_name, pass_name, strip_name,
                                   table_number, gate, destination_city, destination_code, cabin, seat, seq,
                                   ssr_remarks, bcbp, is_test)
        values (translate(encode(extensions.gen_random_bytes(12), 'base64'), '+/', '-_'),
                'test-' || n, 'Test', 'Guest ' || n, 'GUEST' || n || '/TEST', 'TEST G.',
                1, 'P01', 'Honolulu', 'HNL', 'F', lpad(n::text, 3, '0') || 'T', 900 + n,
                'Rehearsal pass: shots can be reset, photos stay out of the gallery.',
                rpad('M1GUEST' || n || '/TEST', 22) || 'ETEST0' || n || ' LGBHNLKT 1121 325F' || lpad(n::text, 3, '0') || 'T0' || (900 + n) || ' 000',
                true);
    end loop;
    return public.admin_rehearsal(p_key);
end $$;

-- What the rehearsal card shows.
create or replace function public.admin_rehearsal(p_key text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
    perform app_private.require_organizer(p_key);
    return jsonb_build_object(
        'test_passes', (select coalesce(jsonb_agg(jsonb_build_object(
                'token', p.token, 'name', p.first_name || ' ' || p.last_name,
                'shots_used', (select count(*) from public.photos f where f.pass_token = p.token),
                'phones', (select count(*) from public.guests g where g.pass_token = p.token))
                order by p.zola_guest_id), '[]'::jsonb)
            from public.passes p where p.is_test),
        'test_photos', (select count(*) from public.photos f join public.passes p on p.token = f.pass_token where p.is_test),
        'real_photos', (select count(*) from public.photos f join public.passes p on p.token = f.pass_token where not p.is_test),
        'song_requests', (select count(*) from public.song_requests),
        'votes', (select count(*) from public.votes));
end $$;

-- Gives a test pass its shots back. Returns the photo paths to remove from Storage.
create or replace function public.admin_reset_test_pass(p_key text, p_token text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare paths jsonb;
begin
    perform app_private.require_organizer(p_key);
    if not exists (select 1 from public.passes where token = p_token and is_test) then
        perform app_private.fail('not_test_pass', 'Only test passes can be reset.');
    end if;
    with gone as (delete from public.photos where pass_token = p_token returning path)
    select coalesce(jsonb_agg(path), '[]'::jsonb) into paths from gone;
    return paths;
end $$;

-- Deletes every test pass and its photos (phones that claimed one are
-- unlinked). Returns the photo paths to remove from Storage.
create or replace function public.admin_delete_test_passes(p_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare paths jsonb;
begin
    perform app_private.require_organizer(p_key);
    with gone as (
        delete from public.photos f using public.passes p
         where p.token = f.pass_token and p.is_test
        returning f.path)
    select coalesce(jsonb_agg(path), '[]'::jsonb) into paths from gone;
    delete from public.passes where is_test;
    return paths;
end $$;

-- Empties the song board (requests and their votes). p_confirm must be 'CLEAR'.
create or replace function public.admin_clear_songs(p_key text, p_confirm text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
    perform app_private.require_organizer(p_key);
    if p_confirm is distinct from 'CLEAR' then
        perform app_private.fail('not_confirmed', 'Type CLEAR to empty the song board.');
    end if;
    with gone as (delete from public.song_requests returning 1) select count(*) into n from gone;
    return jsonb_build_object('removed', n);
end $$;

-- The gallery never shows test passes' photos.
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
    return (select coalesce(jsonb_agg(f.path order by f.uploaded_at), '[]'::jsonb)
              from public.photos f join public.passes p on p.token = f.pass_token
             where f.status = 'uploaded' and not p.is_test);
end $$;

revoke all on function public.admin_make_test_passes(text, integer), public.admin_rehearsal(text),
    public.admin_reset_test_pass(text, text), public.admin_delete_test_passes(text),
    public.admin_clear_songs(text, text)
    from public, anon, authenticated;
grant execute on function public.admin_make_test_passes(text, integer), public.admin_rehearsal(text),
    public.admin_reset_test_pass(text, text), public.admin_delete_test_passes(text),
    public.admin_clear_songs(text, text)
    to anon, authenticated;
