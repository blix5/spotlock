-- Focus tracking: three independent interval streams (attention, app, playback)
-- scoped to a capture session. They're deliberately NOT pre-correlated at write
-- time -- each changes at its own rate for unrelated reasons, so joining them
-- on the way in would make a track change spuriously split an attention
-- interval. They're joined by time overlap at analysis time instead.

-- One row per period where capture was actually running. Without this,
-- "not at the computer" and "the app wasn't open" are indistinguishable in
-- the interval tables below, which would silently inflate every focus
-- percentage in the flattering direction. camera_enabled/helper_connected
-- record which streams were genuinely live, so a session with the helper
-- down isn't misread as "never opened a distracting app".
create table capture_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references spotify_accounts(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  camera_enabled boolean not null default false,
  helper_connected boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger capture_sessions_set_updated_at
  before update on capture_sessions
  for each row
  execute function set_updated_at();

-- One row per contiguous run of a single attention state, as classified by
-- the debounced state machine in src/lib/cv/state-machine.ts. ended_at null
-- means the interval is still open. 'gaze_down' deliberately conflates
-- phone / keyboard / desk -- head pitch alone can't separate them.
create table attention_intervals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references capture_sessions(id) on delete cascade,
  state text not null check (state in ('focused','gaze_down','looking_away','absent','asleep')),
  started_at timestamptz not null,
  ended_at timestamptz,
  sample_count integer not null default 0,
  during tstzrange generated always as (tstzrange(started_at, ended_at)) stored,
  created_at timestamptz not null default now()
);

-- One row per contiguous run in a single frontmost app. window_title stays
-- null unless macOS Accessibility permission was granted -- bundle_id alone
-- needs no permission and is the v1 target. category is resolved from
-- user-editable config at write time, since the mapping is personal and
-- changes; 'unknown' is preserved rather than being forced into a bucket.
create table app_intervals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references capture_sessions(id) on delete cascade,
  bundle_id text not null,
  app_name text,
  window_title text,
  category text not null default 'unknown'
    check (category in ('productive','distracting','neutral','unknown')),
  started_at timestamptz not null,
  ended_at timestamptz,
  during tstzrange generated always as (tstzrange(started_at, ended_at)) stored,
  created_at timestamptz not null default now()
);

-- One row per contiguous stretch of a single track playing. Track and artist
-- names are denormalised so analysis needs no Spotify round-trip, and so
-- history survives a track later becoming unavailable.
create table playback_intervals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references capture_sessions(id) on delete cascade,
  spotify_track_id text not null,
  track_name text,
  artist_names text,
  album_name text,
  start_progress_ms integer,
  started_at timestamptz not null,
  ended_at timestamptz,
  during tstzrange generated always as (tstzrange(started_at, ended_at)) stored,
  created_at timestamptz not null default now()
);

-- Service-role-only data, same rationale as spotify_accounts: RLS on with no
-- policies so the anon/authenticated keys can't read any of it if they're
-- ever exposed to the client by mistake.
alter table capture_sessions enable row level security;
alter table attention_intervals enable row level security;
alter table app_intervals enable row level security;
alter table playback_intervals enable row level security;

-- GiST indexes on the generated range columns make the analysis queries a
-- native overlap join (&&) instead of four-way timestamp comparisons.
create index attention_intervals_during_idx on attention_intervals using gist (during);
create index app_intervals_during_idx on app_intervals using gist (during);
create index playback_intervals_during_idx on playback_intervals using gist (during);

create index attention_intervals_session_idx on attention_intervals (session_id);
create index app_intervals_session_idx on app_intervals (session_id);
create index playback_intervals_session_idx on playback_intervals (session_id);
create index capture_sessions_account_idx on capture_sessions (account_id);

-- Focus percentage per track, as a range-overlap join (&& finds overlapping
-- intervals, * intersects them). Open intervals are excluded rather than
-- coalesced to now(): tstzrange(t, null) is unbounded above, so upper() is
-- null and every duration below would come back null.
--
-- min_seconds is NOT optional in spirit: without a floor, a track heard for
-- eight seconds while focused reads as 100% and tops the ranking. Ratios
-- over tiny samples are the main way this analysis produces confident
-- nonsense.
create function focus_by_track(min_seconds double precision default 300)
returns table (
  spotify_track_id text,
  track_name text,
  artist_names text,
  focused_seconds double precision,
  observed_seconds double precision
) as $$
  select
    p.spotify_track_id,
    max(p.track_name) as track_name,
    max(p.artist_names) as artist_names,
    coalesce(
      sum(extract(epoch from (upper(a.during * p.during) - lower(a.during * p.during))))
        filter (where a.state = 'focused'),
      0
    ) as focused_seconds,
    sum(extract(epoch from (upper(a.during * p.during) - lower(a.during * p.during))))
      as observed_seconds
  from playback_intervals p
  join attention_intervals a
    on a.session_id = p.session_id
   and a.during && p.during
  where p.ended_at is not null
    and a.ended_at is not null
  group by p.spotify_track_id
  having sum(extract(epoch from (upper(a.during * p.during) - lower(a.during * p.during))))
         >= min_seconds
  order by 4 / nullif(sum(extract(epoch from (upper(a.during * p.during) - lower(a.during * p.during)))), 0) desc;
$$ language sql stable;
