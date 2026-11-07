-- Song details for the DJ: length (already stored), BPM and genre.
--
-- Spotify no longer gives new apps audio features (BPM), so the `songs` Edge
-- Function looks each Spotify track up on Deezer's public API by its ISRC
-- (bpm, and the album's genre), falling back to Spotify's artist genres.
-- It fills them in shortly after a request, and whenever the DJ view loads
-- (action "details"). Either can be missing: Deezer reports 0 BPM for some
-- songs, and manual entries have nothing to look up.

alter table public.tracks add column if not exists isrc text;
alter table public.tracks add column if not exists bpm numeric(5,1);
alter table public.tracks add column if not exists genre text;
alter table public.tracks add column if not exists details_checked_at timestamptz;

-- The board now carries bpm and genre too (the guest page ignores them).
create or replace function app_private.leaderboard(p_event integer, p_guest uuid, p_include_hidden boolean)
returns jsonb language sql stable set search_path = public, pg_temp as $$
    select coalesce(jsonb_agg(row_to_json(b) order by b.played, b.votes desc, b.created_at), '[]'::jsonb)
    from (
        select r.id, r.status, r.requester_name, r.created_at, r.played_at,
               t.spotify_id, t.title, t.artist, t.album, t.artwork_url, t.duration_ms, t.bpm, t.genre,
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

-- Spotify tracks on the board whose details haven't been looked up yet.
create or replace function public.track_details_todo(p_limit integer default 5)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'spotify_id', t.spotify_id) order by t.id), '[]'::jsonb)
      from (select t.id, t.spotify_id from public.tracks t
             where t.spotify_id is not null and t.details_checked_at is null
               and exists (select 1 from public.song_requests r where r.track_id = t.id)
             order by t.id limit least(greatest(p_limit, 0), 20)) t
$$;

create or replace function public.set_track_details(p_track_id integer, p_isrc text, p_bpm numeric, p_genre text)
returns void language sql security definer set search_path = public, pg_temp as $$
    update public.tracks
       set isrc = nullif(left(p_isrc, 20), ''),
           bpm = case when p_bpm > 20 and p_bpm < 300 then round(p_bpm, 1) end,
           genre = nullif(left(trim(p_genre), 60), ''),
           details_checked_at = now()
     where id = p_track_id
$$;

revoke all on function public.track_details_todo(integer), public.set_track_details(integer, text, numeric, text)
    from public, anon, authenticated;
grant execute on function public.track_details_todo(integer), public.set_track_details(integer, text, numeric, text)
    to service_role;
