-- The photo album: organizer uploads, guests see them after the reveal.
\set ON_ERROR_STOP 1

set role anon;
select t.expect_error($$select public.admin_album_reserve('a-long-dj-key-for-tests', 'a.jpg', 'jpg')$$, 'not_organizer');
select t.expect_error($$select public.admin_album_reserve('an-organizer-key-for-tests', 'a.heic', 'heic')$$, 'bad_type');
select public.admin_album_reserve('an-organizer-key-for-tests', 'DSC_0001.JPG', 'JPEG', ' Photos by Ana ') as a1 \gset
select public.admin_album_reserve('an-organizer-key-for-tests', 'sunset.png', 'png') as a2 \gset
reset role;
select t.check(:'a1'::jsonb->>'full_path' = (:'a1'::jsonb->>'id') || '/full.jpg', 'jpeg becomes jpg');
select t.check(:'a1'::jsonb->>'credit' = 'Photos by Ana', 'credit trimmed');
select t.check(:'a2'::jsonb->>'web_path' = (:'a2'::jsonb->>'id') || '/web.jpg', 'web copy path');
select t.check(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                            where n.nspname = 'public' and p.proname = 'album_paths'
                              and has_function_privilege('anon', p.oid, 'execute')), 'album_paths not for anon');

-- Not listed until both files are there.
set role anon;
select t.expect_error(format($$select public.admin_album_confirm('an-organizer-key-for-tests', %L)$$, :'a1'::jsonb->>'id'), 'not_uploaded');
reset role;
insert into storage.objects (bucket_id, name, metadata) values
    ('album', :'a1'::jsonb->>'full_path', '{"size": 9000000}'),
    ('album', :'a1'::jsonb->>'web_path', '{"size": 400000}'),
    ('album', :'a2'::jsonb->>'full_path', '{"size": 3000000}');
set role anon;
select t.expect_error(format($$select public.admin_album_confirm('an-organizer-key-for-tests', %L)$$, :'a2'::jsonb->>'id'), 'not_uploaded');
select t.check((public.admin_album_confirm('an-organizer-key-for-tests', (:'a1'::jsonb->>'id')::uuid)->>'bytes')::bigint = 9000000, 'confirmed with its size');
select t.check(jsonb_array_length(public.admin_album('an-organizer-key-for-tests')) = 1, 'organizer lists the uploaded one');
reset role;
set role service_role;
select t.check(jsonb_array_length(public.album_paths()) = 1, 'gallery gets it');
reset role;

-- Hide, show, delete.
set role anon;
select t.check((public.admin_album_hide('an-organizer-key-for-tests', (:'a1'::jsonb->>'id')::uuid, true)->>'hidden')::boolean, 'hidden');
reset role;
set role service_role;
select t.check(jsonb_array_length(public.album_paths()) = 0, 'hidden ones stay out of the gallery');
reset role;
set role anon;
select t.check(not (public.admin_album_hide('an-organizer-key-for-tests', (:'a1'::jsonb->>'id')::uuid, false)->>'hidden')::boolean, 'shown again');
select t.check(jsonb_array_length(public.admin_album_delete('an-organizer-key-for-tests', (:'a1'::jsonb->>'id')::uuid)) = 2, 'delete returns both paths');
select t.expect_error(format($$select public.admin_album_delete('an-organizer-key-for-tests', %L)$$, :'a1'::jsonb->>'id'), 'not_found');
select t.check(jsonb_array_length(public.admin_album('an-organizer-key-for-tests')) = 0, 'gone');
reset role;
\echo album ok
