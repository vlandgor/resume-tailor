-- Resume Tailor: database schema.
-- Run once in Supabase → SQL Editor → New query → paste → Run. Safe to re-run.
--
-- Every row belongs to one user (user_id). Row-level security makes sure a signed-in user
-- can only ever read or write their own rows; signed-out visitors (anon) get nothing.

-- One row per user: settings (without API keys), base resume, and the encrypted key vault.
create table if not exists public.user_state (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  resume     jsonb not null default '{}'::jsonb,
  key_vault  jsonb,          -- { v, salt, iv, ct }: encrypted in the browser, the server can't read it
  updated_at timestamptz not null default now()
);

-- One row per job application. The whole application object lives in `data`.
create table if not exists public.applications (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists applications_user_id_idx on public.applications (user_id);

-- Uploaded DOCX style templates (base64), stored once per content hash.
create table if not exists public.templates (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  b64        text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Row-level security: only your own rows.
alter table public.user_state   enable row level security;
alter table public.applications enable row level security;
alter table public.templates    enable row level security;

drop policy if exists "own rows" on public.user_state;
drop policy if exists "own rows" on public.applications;
drop policy if exists "own rows" on public.templates;

create policy "own rows" on public.user_state   for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.applications for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows" on public.templates    for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Explicit grants (new Supabase projects no longer expose tables to the API automatically).
-- Signed-in users only; anonymous visitors get no access at all.
revoke all on public.user_state, public.applications, public.templates from anon;
grant select, insert, update, delete on public.user_state, public.applications, public.templates to authenticated;
