-- Pin search_path on every helper in app_private.
--
-- Supabase's security advisor (lint 0011, function_search_path_mutable)
-- flags functions that resolve names through the caller's search_path. The
-- public-facing functions already pin theirs; the helpers they call did not.
-- Pinning means a helper can never pick up an object someone puts earlier in
-- the path. Functions added to app_private later should set it themselves.

do $$
declare f regprocedure;
begin
    for f in
        select p.oid::regprocedure
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app_private' and p.prokind = 'f'
    loop
        execute format('alter function %s set search_path = public, pg_temp', f);
    end loop;
end $$;
