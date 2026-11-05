-- Keys shorter than 16 characters are always refused at the door
-- (require_admin, require_organizer), but the setters used to accept them,
-- so a short key looked saved and then never worked. Now they refuse it.

create or replace function app_private.set_admin_key(p_key text)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
    if p_key is null or length(p_key) < 16 then
        raise exception 'Keys need at least 16 characters (this one has %). Nothing was changed.', coalesce(length(p_key), 0)
            using detail = 'key_too_short',
                  hint = 'Try a long random string, e.g. select encode(extensions.gen_random_bytes(18), ''base64'');';
    end if;
    update app_private.settings
       set admin_key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex');
end $$;

create or replace function app_private.set_organizer_key(p_key text)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
    if p_key is null or length(p_key) < 16 then
        raise exception 'Keys need at least 16 characters (this one has %). Nothing was changed.', coalesce(length(p_key), 0)
            using detail = 'key_too_short',
                  hint = 'Try a long random string, e.g. select encode(extensions.gen_random_bytes(18), ''base64'');';
    end if;
    update app_private.settings
       set organizer_key_hash = encode(extensions.digest(p_key, 'sha256'), 'hex');
end $$;

revoke all on function app_private.set_admin_key(text), app_private.set_organizer_key(text)
    from public, anon, authenticated;
