# Focus tracking: camera CV + app state, correlated to Spotify

**Status:** implemented, not yet run end-to-end. The code exists and builds; the
migration has not been applied and the thresholds in §2 have never seen a real face.
See *Running it* at the bottom.

This replaces an earlier draft of this file that was written before the goal was known. That
draft surveyed three eye-tracking approaches and modelled everything as point-in-time events.
Both of those are now resolved — see *Decisions* below.

## Goal

Measure how focused I am while working, and correlate it against what Spotify is playing.

The signals of interest:

- **From the camera** — looking away for extended periods, not being present at all, looking
  at a phone, sleeping.
- **From app state** — switching to something unproductive, checking notifications,
  messaging for unrelated reasons.

The payoff is the correlation: *which music actually keeps me focused.*

## Decisions

These are settled. They are recorded with reasoning so they don't get relitigated.

1. **Coarse, calibration-free signals only.** No screen-space gaze estimation, no WebGazer,
   no calibration step. Every target above is a *state of the person*, not a location on
   screen — knowing which pixel I'm looking at adds nothing here, and buys a large
   robustness and UX cost.
2. **Phone-looking is conflated into one `gaze_down` state for v1.** Head-pitch-down cannot
   be separated from looking at a keyboard, a desk, or a paper notebook using head pose
   alone. Distinguishing them needs a second object-detection model — real cost, for one
   event type. Accept the false positives for now.
3. **1 fps sampling** for both the camera and app state.
4. **App identity comes from a local macOS helper, not screen pixels.** No `getDisplayMedia`
   in v1 at all. Reasoning in §3 — it is not an optimisation, it's a correctness constraint.

### Two consequences of the 1 fps decision

**Blink-rate detection is gone.** Blinks last roughly 100–400 ms. At one sample per second
they are missed entirely or aliased into noise, so blink rate is dropped as a signal — it
cannot be recovered by tuning. This is a real loss: blink rate is a decent drowsiness proxy.

Sleep detection is *unaffected*, because it relies on eyes-closed-**sustained** rather than
blink frequency — ten consecutive closed samples is ten seconds, which is unambiguously not
a blink. If blink rate later turns out to matter, it needs its own high-framerate burst mode,
not a global framerate increase.

**1 fps also makes the cost question disappear.** Running face inference all workday at 30 fps
would be a genuine thermal problem on a laptop. At 1 fps it is negligible, which is why this
plan puts inference on the main thread and drops the Worker/OffscreenCanvas question the
earlier draft raised.

---

## §0 What the existing code constrains

Read before implementing. These are checked against the actual files, not assumed.

**`src/lib/spotify.ts`** — `SPOTIFY_SCOPES` currently requests `user-read-private`,
`user-read-email`, `user-top-read`, `user-read-recently-played`. It does **not** include
`user-read-playback-state` or `user-read-currently-playing`, and `/me/player/currently-playing`
is not wired up — only `/me/player/recently-played` is. Adding scopes forces one re-auth of
the owner account, so decide the final scope set once rather than adding them incrementally.

`getValidAccessToken()` already handles refresh-and-persist with a 60s expiry margin, and
`spotifyFetch()` takes an already-resolved token so parallel calls refresh at most once. Reuse
both; don't write new token handling.

**`src/lib/supabase-admin.ts`** — the service-role client, explicitly documented as never
importable from a Client Component. This is the single most structurally important constraint
here: **the browser cannot hold a Spotify token**, so playback polling must go through a
server-side Route Handler proxy. The capture island talks to our own API, never to Spotify.

**`src/lib/session.ts` / `src/lib/auth.ts`** — single-user app. An HMAC-signed cookie asserts
which `spotify_accounts` row the browser may act as; `getCurrentAccount()` resolves it. New
Route Handlers should gate on `getCurrentAccount()` the same way.

**`src/app/page.tsx`** — an async server component doing its Spotify fetches at render time.
Capture is inherently client-side and long-lived, so it must live in a `"use client"` island
rather than anywhere in this render path.

**`supabase/migrations/20260911004151_create_spotify_accounts.sql`** — the conventions new
migrations should match: explanatory comments above each table, `timestamptz` throughout,
`uuid primary key default gen_random_uuid()`, and RLS enabled with *no* policies so the
anon/authenticated keys can't read anything if they ever leak clientward. It also defines a
reusable `set_updated_at()` trigger function — reuse it, don't redefine it.

---

## §1 Camera capture (1 fps)

A `"use client"` component owning the whole camera lifecycle.

- **Permission** — behind an explicit button, never on mount. `getUserMedia` prompts on first
  call, and an un-prompted prompt on page load is both hostile and more likely to be denied.
- **Secure context** — `getUserMedia` requires one. `http://127.0.0.1:3000` (what this app
  already runs on, per the login error copy in `page.tsx`) is treated as a secure context, so
  local dev works with no TLS setup. Any non-localhost deploy needs real HTTPS.
- **Constraints** — request modestly: `{ width: 640, height: 480 }`, no framerate constraint.
  We sample at 1 fps regardless of stream framerate, and landmark detection does not benefit
  from more pixels. Lower resolution also means faster inference.
- **Sampling** — a `setInterval` at 1000ms drawing the current video frame to an offscreen
  `<canvas>`, then handing that to the detector. Deliberately *not*
  `requestVideoFrameCallback`, which is designed to fire per decoded frame; we want a fixed
  slow cadence decoupled from stream framerate.
- **Cleanup** — `track.stop()` on every track on unmount, and clear the interval. Forgetting
  this leaves the camera indicator light on, which is alarming and looks like a bug.
- **Revocation** — permission can be revoked mid-session; the stream's tracks fire `ended`.
  Listen for it and drop back to the un-permissioned UI rather than silently recording nothing.
- **Device switching** — `enumerateDevices()` for a picker. Low priority; note that device
  labels are empty strings until permission has been granted once.

---

## §2 Attention signals

MediaPipe `FaceLandmarker` from `@mediapipe/tasks-vision`, one inference pass per sample.
Initialise with `outputFaceBlendshapes: true` and `outputFacialTransformationMatrixes: true`,
in `VIDEO` running mode.

Host the `.task` model file and the WASM assets in `public/` rather than loading them from a
CDN — a personal tool that breaks when a CDN is unreachable is worse than one extra setup
step, and it keeps this working offline. Both are gitignored (~38MB, and both reproducible);
`npm run setup:assets` restores them.

Three raw signals per sample:

| Signal | Source |
|---|---|
| Face present / absent | number of detected faces |
| Eyes open / closed | `eyeBlinkLeft` / `eyeBlinkRight` blendshape scores, thresholded |
| Head pose (yaw/pitch/roll) | euler decomposition of the facial transformation matrix |

*Unverified:* the exact blendshape category names above are from general knowledge of the
MediaPipe blendshape set, not confirmed against this version's output. Log one real result
before writing threshold logic. If blendshapes prove awkward, the fallback is a computed
eye-aspect-ratio over the eye landmark ring — a well-established technique, slightly more
code, no model-version coupling.

### State machine

Raw per-sample signals are too noisy to store directly. A state machine converts them into
durable states, with **asymmetric hysteresis** — slow to leave `focused`, fast to return —
so one bad sample (a stretch, a sip of coffee) doesn't register as a distraction, while
genuinely returning to work is credited immediately.

| State | Entry condition (consecutive 1 fps samples) |
|---|---|
| `focused` | ~2 × face present, pose within thresholds |
| `looking_away` | ~5 × yaw beyond threshold |
| `gaze_down` | ~5 × pitch below threshold — phone/keyboard/desk, deliberately conflated |
| `absent` | ~5 × no face detected |
| `asleep` | ~10 × eyes closed while face present |

All counts and angle thresholds above are **starting points to tune empirically**, not
settled values. Head pose in particular depends on how the laptop sits relative to the face —
a threshold tuned at a desk will be wrong on a couch. Expect to build a small live debug
readout showing current yaw/pitch and the running state before any of these numbers are
trustworthy.

`asleep` is intentionally a longer window than the others: it is the highest-consequence
misfire, and ten seconds of continuously closed eyes is a signal nothing else produces.

---

## §3 App state via a local helper

### Why not screen capture

**A browser page cannot see which application you are in.** `getDisplayMedia` yields pixels
and nothing else — no window title, no app name, no process identity. This is a deliberate
privacy boundary, not an oversight or a gap to work around.
`track.getSettings().displaySurface` distinguishes *monitor* vs *window* vs *browser tab*,
but not *which* window or *which* app.

That rules out reading any of the target events — "switched to something unproductive",
"checking notifications" — directly off a screen stream. The alternatives were classifying
frames with a vision model, or periodic OCR of window chrome. Both are indirect, expensive,
and brittle against fullscreen apps and theme changes.

Verify this empirically before building anything on top of it. In DevTools, share a window
and inspect the track settings:

```js
(await navigator.mediaDevices.getDisplayMedia({video:true})).getVideoTracks()[0].getSettings()
```

If there is no app-identifying field in that object — there shouldn't be — the helper below
is the path.

### The helper

A small process outside the Next app, reporting the frontmost application at 1 Hz over a
localhost WebSocket to the capture island. This is *more* minimal than screen capture, not
less: no video decode, no OCR dependency, no screen-share permission prompt, and the answer
is exact rather than inferred.

**v1: a Node script**, since Node is already a dependency and this needs no build step. Poll
once a second via `osascript`, serve over `ws`:

```bash
osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
```

**Upgrade path: a Swift binary** compiled with a bare `swiftc helper.swift` — no Xcode project
needed. `NSWorkspace.shared.frontmostApplication` gives the bundle identifier directly with no
subprocess spawn, and `NSWorkspace.didActivateApplicationNotification` makes it event-driven,
removing the polling loop entirely. Strictly better if the Swift toolchain is available.

### Bundle ID is free; window title is not

Worth knowing before designing around it: the frontmost app's **bundle identifier and name
need no special permission**. The **window title** does — it requires Accessibility (or on
newer macOS, Screen Recording) permission to read.

That matters because some of the target events live *inside* one app. "Checking notifications"
and "messaging for unrelated purposes" might both be Slack; only the window title separates
them. So there's a real tradeoff: bundle ID alone is permission-free and probably sufficient
for "switched to something unproductive", while per-conversation granularity costs a
permission grant.

**Start with bundle ID only.** Add title capture later if app-level granularity proves too
coarse. The schema below allows `window_title` to be null for exactly this reason.

### Categorisation

A `bundle_id → category` map (`productive` / `distracting` / `neutral`), stored as editable
config rather than hardcoded — it is inherently personal, and the same app is productive or
distracting depending on the week. Anything unmapped is `unknown` rather than being forced
into a bucket; `unknown` showing up a lot is itself useful feedback about the map.

### Constraint this introduces

The helper ties capture to the local machine. A `ws://` connection from an `https://` page is
blocked by browsers, so if this app is ever deployed behind TLS, the helper story needs
rethinking. Fine for a local personal tool — just don't build toward a deploy assuming it
carries over.

---

## §4 Event model: intervals, not points

The earlier draft modelled everything as point events — one row, one instant. That is the
wrong shape. Focus is made of **intervals**: "looked away for four minutes" has a start and an
end, and every question worth asking ("what percentage of this album was I focused?") is a
duration query. Point events force you to reconstruct intervals at read time, every time.

Three **independent** interval streams, joined at analysis time rather than pre-correlated at
write time:

1. **attention** — from §2's state machine
2. **app** — from §3's helper
3. **playback** — from §5's poller

Keeping them independent matters. They change at different rates for unrelated reasons, and
pre-joining them would mean a track change spuriously splitting an attention interval. Join
them in SQL when asking a question, not on the way in.

The client opens an interval on a state transition and closes it on the next one, POSTing
both to a Route Handler. On page unload, close all open intervals — and on startup, close any
intervals left open by a previous session that crashed.

### Why `capture_sessions` exists

Without a session table, **absence of data is ambiguous**: "not at the computer" and "the app
wasn't running" look identical in an interval table. That ambiguity would silently corrupt
every focus percentage ever computed, in the flattering direction. A session row records when
capture was genuinely active, so analysis can scope to observed time.

It also records whether the camera and helper were each connected — a session with the helper
down should not be read as "never used a distracting app."

---

## §5 Playback correlation

**The precision requirement collapsed.** The earlier draft agonised over hundreds-of-
milliseconds sync accuracy. For "was I focused during this track", track-level attribution is
entirely sufficient. That is a large simplification, and it cascades: polling can be lazy, so
rate limits stop being a design pressure.

- **Poll every ~30s** through a server-side proxy at `src/app/api/playback/route.ts`, which
  gates on `getCurrentAccount()`, resolves a token via the existing `getValidAccessToken()`,
  and calls `/me/player/currently-playing`. The token never reaches the browser.
- **Between polls**, extrapolate position locally from the last anchor using
  `performance.now()`. This is now only needed to *detect track changes and seeks* between
  polls, not to achieve sync precision — a much weaker requirement than the earlier draft's.
- **Re-anchor** on every poll. Drift over a 30s window is irrelevant at this granularity.
- **Nothing playing** is a normal state, not an error. Close the open playback interval and
  leave a gap; attention intervals continue independently.

*Unverified:* Spotify's current rate limits and the precise scope-to-endpoint mapping are
asserted from general knowledge, not checked against their developer docs in this session.
Confirm both before finalising the cadence and the scope list — particularly since the scope
list forces a re-auth and should only be decided once.

---

## §6 Schema

Four tables, matching the existing migration's conventions.

```sql
-- One row per period where capture was actually running. Without this,
-- "not at the computer" and "the app wasn't open" are indistinguishable in
-- the interval tables below, which would silently inflate every focus
-- percentage. camera_enabled/helper_connected record which streams were
-- genuinely live, so a session with the helper down isn't misread as
-- "never opened a distracting app".
create table capture_sessions (
  id uuid primary key default gen_random_uuid(),
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

-- One row per contiguous run of a single attention state (see §2's state
-- machine). ended_at null means the interval is still open.
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

-- One row per contiguous run in a single frontmost app. window_title is
-- null unless Accessibility permission was granted (see §3) - bundle_id
-- alone needs no permission and is the v1 target.
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

-- One row per contiguous stretch of a single track playing. Denormalised
-- track/artist names so analysis doesn't need a Spotify round-trip, and so
-- history survives a track becoming unavailable later.
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

-- Service-role-only data, same as spotify_accounts.
alter table capture_sessions enable row level security;
alter table attention_intervals enable row level security;
alter table app_intervals enable row level security;
alter table playback_intervals enable row level security;

create index attention_intervals_during_idx on attention_intervals using gist (during);
create index app_intervals_during_idx on app_intervals using gist (during);
create index playback_intervals_during_idx on playback_intervals using gist (during);
```

**The `during` column** is a generated `tstzrange` mirroring `started_at`/`ended_at`, with a
GiST index. It makes overlap analysis a native `&&` join instead of four-way timestamp
comparisons. `started_at`/`ended_at` stay the stored truth because closing an interval is a
simple `update ... set ended_at`.

*Verify before applying:* generated columns require the expression to be `IMMUTABLE`. The
2-arg `tstzrange(timestamptz, timestamptz)` constructor should qualify, but this hasn't been
run against a real Postgres here. If the migration is rejected, drop the generated column and
index `(started_at, ended_at)` instead — the analysis queries get wordier, nothing else
changes.

**Open intervals and range arithmetic:** `tstzrange(t, null)` is *unbounded above*, so
`upper()` returns null and any duration arithmetic on it yields null. Analysis queries must
either filter `where ended_at is not null` or coalesce the end to `now()`. Closing intervals
reliably on unload and on next startup keeps this an edge case rather than a constant tax.

---

## §7 Analysis

Absent from the earlier draft, and the actual point of the feature.

Focus percentage per track, as an interval-overlap join:

```sql
select
  p.spotify_track_id,
  p.track_name,
  p.artist_names,
  sum(extract(epoch from (upper(a.during * p.during) - lower(a.during * p.during))))
    filter (where a.state = 'focused') as focused_seconds,
  sum(extract(epoch from (upper(a.during * p.during) - lower(a.during * p.during))))
    as observed_seconds
from playback_intervals p
join attention_intervals a
  on a.session_id = p.session_id
 and a.during && p.during
where p.ended_at is not null
  and a.ended_at is not null
group by 1, 2, 3
having sum(extract(epoch from (upper(a.during * p.during) - lower(a.during * p.during)))) > 300;
```

`*` is range intersection, `&&` is overlap. The same shape rolls up per artist, per album, or
per app category by swapping the grouping.

**The `having` clause is not optional.** Without a minimum-observed-duration floor, a track
you heard for eight seconds while focused reads as "100% focused" and tops every ranking.
Ratios over tiny samples are the main way this analysis produces confident nonsense.

Worth adding once there's real data: a baseline. "72% focused during this album" means
nothing without knowing the overall average — the interesting quantity is the *deviation*,
not the raw percentage.

---

## §8 Open questions

Genuinely open. The eye-tracking approach, the phone/gaze-down conflation, the screen-capture
approach, and the sync-precision target are all **decided** above and shouldn't be reopened
without a new reason.

1. **EAR/blendshape and head-pose threshold *values*** still need empirical tuning against
   the live debug readout — they depend on physical setup. (The pitch *sign* is settled: it
   needed negating, and `signals.ts` does that now.)
2. **Blendshape category names** in §2 are unverified against this version of
   `@mediapipe/tasks-vision`. Log one real result before writing threshold logic.
3. **`tstzrange` immutability** for the generated column (§6) — verify before applying the
   migration; fallback noted.
4. **Spotify rate limits and the exact scope list** (§5) are unverified. Settle the final
   scope set in one pass, since adding scopes forces a re-auth each time.
5. **The bundle-id → category map** is personal config with no correct default. Needs a first
   pass from real `unknown` data rather than being guessed up front.
6. **Window titles** (§3) — deferred pending whether bundle-id granularity proves too coarse.
   Costs an Accessibility permission grant.
7. **Retention.** At 1 fps with debouncing this is maybe a few hundred interval rows a day,
   so storage is a non-issue for a long time — but nothing here ever deletes anything, and
   that should be a deliberate choice rather than an oversight.

## Build order

Each step is independently verifiable, which matters because the thresholds in §2 can't be
tuned without something running.

1. §6 migration, applied locally.
2. §1 camera island with a live debug readout — raw yaw/pitch/EAR on screen, nothing stored.
3. §2 state machine, tuned against that readout, writing `attention_intervals`.
4. §3 helper, writing `app_intervals`.
5. §5 playback proxy and poller, writing `playback_intervals`.
6. §7 analysis, once there's a few days of real data to test queries against.


---

## Running it

Three things have to be in place, and none are automatic.

**1. MediaPipe assets.** Neither the WASM runtime nor the model is committed — see the
README. One command restores both:

```
npm run setup:assets
```

Until the model exists, "Start capture" fails at detector load.

**2. The migration.** `supabase/migrations/20260911160000_create_focus_tracking.sql` has
**not** been applied. This project is linked to a hosted Supabase project, so `supabase db
push` writes to the real database — run it deliberately.

The `tstzrange` generated columns are the thing most likely to be rejected (see §6). If the
push fails on them, drop the three `during` columns and their GiST indexes, index
`(started_at, ended_at)` instead, and rewrite `focus_by_track` to compare timestamps
directly.

**3. Re-auth.** `SPOTIFY_SCOPES` gained `user-read-playback-state` and
`user-read-currently-playing`. Existing tokens don't carry them, so log out and back in once
or `/api/focus/playback` returns 403.

Then, in two terminals:

```
npm run dev
node helper/focus-helper.js
```

Visit `/focus` and hit **Start capture**. The three status dots (camera / helper / spotify)
show what's actually connected — the helper dot stays grey until `focus-helper.js` is
running, and that's a normal state, not an error.

### Tuning the thresholds

This is the part that can't be skipped. The debug readout shows live `yaw`, `pitch`, `roll`,
`blink` and `ear` alongside the committed state and what's pending. Watch it while you move:

- Turn your head until `looking_away` fires. If that angle feels wrong, change
  `yawThresholdDeg` in `src/lib/cv/state-machine.ts`.
- Look down at your lap; `gaze_down` should fire. The raw matrix decomposition came out
  inverted here (looking *up* triggered `gaze_down`), so `signals.ts` now negates pitch.
  That's been validated against a live camera — if it ever reads backwards again, that
  negation is the place to look.
- Check whether `blink` shows a number or `— (no blendshape)`. If it's the latter, the
  blendshape category names in `signals.ts` don't match this model version and the `ear`
  column is what's driving sleep detection.

Thresholds tuned at a desk will be wrong on a couch, because head pose is relative to where
the laptop sits.
