-- Just enough of Supabase to run the migrations on a plain Postgres for tests:
-- the API roles, auth.users and auth.uid(). Never apply this to Supabase.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema extensions;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase Storage, as far as the camera migration touches it.
create schema storage;
create table storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id),
    name text, metadata jsonb, created_at timestamptz default now()
);
