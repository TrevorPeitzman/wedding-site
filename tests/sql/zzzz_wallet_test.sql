-- Wallet passes. Runs last; reuses pass 'pass-token-dddd' (zola-d), claimed by guest d1.
\set ON_ERROR_STOP 1

select t.check((select count(*) from storage.buckets where id = 'wallet' and not public
                and allowed_mime_types = array['application/vnd.apple.pkpass']) = 1, 'private wallet bucket');

set role anon;
select t.expect_error($$select public.my_pass_card()$$, '<42501: permission denied for function my_pass_card>');
reset role;

set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000c1');
select t.expect_error($$select public.wallet_file_as('pass-token-dddd')$$, '<42501: permission denied for function wallet_file_as>');
reset role;
insert into auth.users (id) values ('00000000-0000-0000-0000-0000000000e1');
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000e1');
select t.check(not (public.my_pass_card()->>'has_pass')::boolean, 'no pass claimed: no card');

select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.check(public.my_pass_card()->>'first_name' = 'Dora', 'card shows the claimed pass');
select t.check(public.my_pass_card()->>'token' = 'pass-token-dddd', 'card carries the token for the Wallet link');
select t.check(not (public.my_pass_card()->>'apple_ready')::boolean, 'Apple pass not uploaded yet');
reset role;

set role service_role;
select t.expect_error($$select public.wallet_file_as('pass-token-dddd')$$, 'not_ready');
select t.expect_error($$select public.wallet_file_as('nope')$$, 'unknown_pass');
reset role;

-- Upload the file: now it's served.
insert into storage.objects (bucket_id, name, metadata) values ('wallet', 'zola-d.pkpass', '{"size": 41000}');
set role service_role;
select t.check(public.wallet_file_as('pass-token-dddd') = 'zola-d.pkpass', 'file served for the token');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.check((public.my_pass_card()->>'apple_ready')::boolean, 'card says Apple pass ready');
reset role;

-- Wallet switched off: not served, and no Google link handed out.
update public.passes set google_save_url = 'https://pay.google.com/gp/v/save/x' where token = 'pass-token-dddd';
set role anon;
select public.admin_set_feature('an-organizer-key-for-tests', 'wallet', false, null, null);
reset role;
set role service_role;
select t.expect_error($$select public.wallet_file_as('pass-token-dddd')$$, 'feature_closed');
reset role;
set role authenticated;
select t.as_guest('00000000-0000-0000-0000-0000000000d1');
select t.check(public.my_pass_card()->>'google_save_url' is null, 'no Google link while wallet is off');
select t.check(public.my_pass_card()->>'wallet_state' = 'off', 'card reports wallet off');
reset role;

select 'ok' as wallet_test;
