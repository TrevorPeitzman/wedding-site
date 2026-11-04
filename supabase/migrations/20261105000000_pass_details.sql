-- Boarding pass details, from the KT 1121 merge workbook (PASSENGERS tab).
-- Loaded by scripts/import_passes.py; used by the Wallet passes (Phase 4)
-- and the camera (Phase 5). Still no grants: only functions read this table.

alter table public.passes
    add column if not exists side             text,      -- K or T
    add column if not exists household        text,
    add column if not exists pass_name        text,      -- PEITZMAN/TREVOR, as printed
    add column if not exists strip_name       text,      -- TREVOR P., the display board
    add column if not exists gate             text,
    add column if not exists destination_city text,
    add column if not exists destination_code text,
    add column if not exists cabin            text,
    add column if not exists seat             text,
    add column if not exists seq              integer,
    add column if not exists pnr              text,
    add column if not exists ssr_remarks      text,
    add column if not exists bcbp             text,      -- the 60-character IATA string
    add column if not exists updated_at       timestamptz not null default now();

create index if not exists idx_passes_table on public.passes (table_number);
