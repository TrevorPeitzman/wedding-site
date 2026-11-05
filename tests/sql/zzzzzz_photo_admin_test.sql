-- Organizer photo view. Runs last. By now: one real uploaded photo (pass dddd,
-- from the camera test), the reveal is out, the organizer key is set.
\set ON_ERROR_STOP 1

set role anon;
select t.expect_error($$select public.admin_photos('a-long-dj-key-for-tests')$$, 'not_organizer');
select public.admin_photos('an-organizer-key-for-tests') as photos \gset
reset role;
select t.check(jsonb_array_length(:'photos'::jsonb) = 1, 'one uploaded photo listed');
select t.check(:'photos'::jsonb->0->>'first_name' = 'Dora' and (:'photos'::jsonb->0->>'table_number') is null
               or :'photos'::jsonb->0->>'first_name' = 'Dora', 'with who took it');
select t.check(not (:'photos'::jsonb->0 ? 'pass_token') and not (:'photos'::jsonb->0 ? 'token'), 'no pass tokens in the list');
select (:'photos'::jsonb->0->>'id') as pid \gset

-- Reserved-but-not-uploaded shots are not listed.
select t.check((select count(*) from public.photos where uploaded_at is null) > 0, 'there are unconfirmed shots in the table');

-- Hide: out of the guest gallery, still listed for the organizer, still a shot.
set role anon;
select t.check((public.admin_hide_photo('an-organizer-key-for-tests', :'pid', true)->>'hidden')::boolean, 'hidden');
select t.check((public.admin_photos('an-organizer-key-for-tests')->0->>'hidden')::boolean, 'organizer still sees it, marked hidden');
reset role;
set role service_role;
select t.check(jsonb_array_length(public.gallery_paths_as('00000000-0000-0000-0000-0000000000d1')) = 0, 'gallery leaves it out');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.check((public.camera_status()->>'used')::int = 12, 'hiding does not give the shot back');
reset role;

-- Show again.
set role anon;
select t.check(not (public.admin_hide_photo('an-organizer-key-for-tests', :'pid', false)->>'hidden')::boolean, 'shown again');
select t.expect_error($$select public.admin_hide_photo('an-organizer-key-for-tests', gen_random_uuid(), true)$$, 'not_found');
reset role;
set role service_role;
select t.check(jsonb_array_length(public.gallery_paths_as('00000000-0000-0000-0000-0000000000d1')) = 1, 'back in the gallery');
reset role;

select 'ok' as photo_admin_test;
