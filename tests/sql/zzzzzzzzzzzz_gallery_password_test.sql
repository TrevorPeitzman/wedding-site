-- The gallery's shared password: an alternative to a boarding pass.
\set ON_ERROR_STOP 1

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000f1'), ('00000000-0000-0000-0000-0000000000f2') on conflict do nothing;
update public.events set photos_reveal_at = now() - interval '1 minute' where slug = 'wedding';

-- No password set yet.
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000f1');
select t.check(not (public.gallery_status()->>'access')::boolean and not (public.gallery_status()->>'password_set')::boolean, 'no access, no password yet');
select t.expect_error($$select public.unlock_gallery('anything')$$, 'no_password');
reset role;
set role service_role;
select t.expect_error($$select public.gallery_paths_as('00000000-0000-0000-0000-0000000000f1')$$, 'no_access');
reset role;

-- The organizer sets it.
set role anon;
select t.expect_error($$select public.admin_gallery_password('a-long-dj-key-for-tests', 'KTwedding2026')$$, 'not_organizer');
select t.expect_error($$select public.admin_gallery_password('an-organizer-key-for-tests', 'abc')$$, 'too_short');
select t.check((public.admin_gallery_password('an-organizer-key-for-tests', 'KTwedding2026')->>'set')::boolean, 'set');
reset role;
select t.check((select gallery_password_hash not like '%wedding%' from app_private.settings), 'only a hash is stored');
select t.expect_error($$select app_private.set_gallery_password('ab')$$, 'password_too_short');

-- A guest without a pass.
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000f1');
select t.check(public.unlock_gallery('wrong')->>'code' = 'wrong_password', 'wrong password answered');
select t.check(not (public.gallery_status()->>'access')::boolean, 'still no access');
select t.check((public.unlock_gallery('  ktWEDDING2026 ')->>'access')::boolean, 'right password: case and spaces forgiven');
select t.check((public.gallery_status()->>'access')::boolean and not (public.gallery_status()->>'has_pass')::boolean, 'access without a pass');
reset role;
set role service_role;
select t.check(jsonb_typeof(public.gallery_paths_as('00000000-0000-0000-0000-0000000000f1')) = 'array', 'gallery opens for them');
reset role;

-- Ten wrong tries pause another phone; the right one is refused while paused.
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000f2');
select public.unlock_gallery('nope' || i) from generate_series(1, 10) i \g /dev/null
select t.expect_error($$select public.unlock_gallery('KTwedding2026')$$, 'too_many_tries');
reset role;

-- Not revealed yet: access, but no photos.
update public.events set photos_reveal_at = now() + interval '1 day' where slug = 'wedding';
set role service_role;
select t.expect_error($$select public.gallery_paths_as('00000000-0000-0000-0000-0000000000f1')$$, 'not_revealed');
reset role;
set role anon;
select t.check((public.admin_gallery_password('an-organizer-key-for-tests')->>'phones')::int >= 1, 'organizer sees phones let in');
reset role;
\echo gallery password ok
