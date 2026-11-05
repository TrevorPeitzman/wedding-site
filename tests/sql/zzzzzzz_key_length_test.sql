-- Short keys are refused when set, and the old key keeps working.
\set ON_ERROR_STOP 1

select t.expect_error($$select app_private.set_organizer_key('woof')$$, 'key_too_short');
select t.expect_error($$select app_private.set_admin_key('short')$$, 'key_too_short');
select t.expect_error($$select app_private.set_organizer_key(null)$$, 'key_too_short');
set role anon;
select t.check(public.admin_features('an-organizer-key-for-tests') is not null, 'organizer key unchanged after a refused one');
select t.expect_error($$select public.admin_features('woof')$$, 'not_organizer');
reset role;
select t.expect_error($$select app_private.set_organizer_key('woof')$$, 'key_too_short');
select app_private.set_organizer_key('another-organizer-key-for-tests');
set role anon;
select t.check(public.admin_features('another-organizer-key-for-tests') is not null, 'a 16+ character key works');
reset role;
select app_private.set_organizer_key('an-organizer-key-for-tests');
\echo key length ok
