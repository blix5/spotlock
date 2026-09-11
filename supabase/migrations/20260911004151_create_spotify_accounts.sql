-- One row per connected Spotify account. Spotify's own user id is the
-- natural identity here, so there's no separate `users` table for now --
-- if/when other login providers are added later, this is where that
-- indirection would get introduced.
create table spotify_accounts (
  id uuid primary key default gen_random_uuid(),
  spotify_user_id text not null unique,
  display_name text,
  access_token text not null,
  refresh_token text not null,
  token_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only the server (service_role key) ever touches this table, but RLS is
-- enabled with no policies so the anon/authenticated keys can't read tokens
-- if they're ever exposed to the client by mistake.
alter table spotify_accounts enable row level security;

create function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger spotify_accounts_set_updated_at
  before update on spotify_accounts
  for each row
  execute function set_updated_at();
