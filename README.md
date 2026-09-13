# spotifything

A single-user tool that measures how focused you are while working and correlates it
against what Spotify is playing. A webcam classifies attention state once a second, a small
macOS helper reports which app is frontmost, and both are lined up against playback history
to answer the actual question: **which music keeps me focused.**

Design rationale and the reasoning behind each decision live in [docs/cv-plan.md](docs/cv-plan.md).

---

## Setup

### 1. Install and fetch assets

```bash
npm install && npm run setup:assets
```

`setup:assets` copies the MediaPipe WASM runtime out of `node_modules` and downloads the
face-landmark model. Neither is committed — together they're ~38MB and both are
reproducible — so run this after a fresh clone. See [Assets](#assets) if you need the raw
`curl`.

### 2. Environment

Create `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3000/api/auth/callback
SPOTIFY_OWNER_USER_ID=

NEXT_PUBLIC_APP_URL=http://127.0.0.1:3000
SESSION_SECRET=
```

`SPOTIFY_REDIRECT_URI` must match a Redirect URI registered on your app at
[developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) **exactly**.
`SPOTIFY_OWNER_USER_ID` locks login to your account alone.

### 3. Database

```bash
supabase db push
```

Two migrations: `spotify_accounts` (OAuth tokens) and the focus-tracking tables.

---

## Running

Two processes:

```bash
npm run dev
```

```bash
node helper/focus-helper.js
```

Then open **http://127.0.0.1:3000/focus** and click *Start capture*.

> ### Use `127.0.0.1`, never `localhost`
>
> Spotify requires an exact redirect-URI match, so the app must be reached at `127.0.0.1`.
> But `next dev` treats `localhost` as its own origin, which makes `127.0.0.1` requests
> cross-origin — Next then blocks dev-only resources including HMR, **hydration silently
> fails, and no Client Component ever mounts**. The symptom is a page that looks fine where
> buttons do nothing at all.
>
> `allowedDevOrigins: ["127.0.0.1"]` in [next.config.ts](next.config.ts) is what makes this
> work. Don't remove it.

The helper is optional — without it the app records attention and playback, and the `helper`
status dot stays grey. That's a normal state, not an error.

### Things that look like errors but aren't

- `INFO: Created TensorFlow Lite XNNPACK delegate for CPU.` — an informational log MediaPipe
  writes via `console.error`, which Next's dev overlay promotes to an error card. Harmless,
  and absent from production builds.
- The `helper` dot staying grey — see above.

---

## How it works

Three **independent** interval streams, deliberately not correlated on write. They change at
unrelated rates, so joining them on the way in would let a track change spuriously split an
attention interval. They're joined by time overlap at query time instead.

| Stream | Source | Table |
|---|---|---|
| Attention | webcam, 1 fps | `attention_intervals` |
| App | macOS helper, 1 Hz | `app_intervals` |
| Playback | Spotify poll, 30s | `playback_intervals` |

All three are scoped to a row in `capture_sessions`, which records when capture was actually
running — without it, "away from the computer" and "app wasn't open" are indistinguishable,
and every focus percentage would be inflated.

**Attention states:** `focused`, `looking_away`, `gaze_down`, `absent`, `asleep`. A state
machine debounces raw per-sample classifications with asymmetric hysteresis — slow to leave
`focused`, fast to return — so one stretch or sip of coffee isn't recorded as distraction.

`gaze_down` deliberately conflates phone, keyboard, and desk. Head pitch alone can't separate
them, and doing so would need a second object-detection model for one event type.

**At 1 fps, blink *rate* is not detectable** — blinks last 100–400ms and alias away. Sleep
detection works because it uses sustained eye closure (10 consecutive samples), not blink
frequency.

---

## Structure

```
src/
  app/
    page.tsx                     Spotify stats (server component)
    focus/page.tsx               Capture UI + focus-by-track ranking
    api/auth/                    OAuth login, callback, logout
    api/focus/
      session/route.ts           Opens/closes capture sessions, sweeps orphans
      intervals/route.ts         Opens/closes interval rows for all three streams
      playback/route.ts          Server-side Spotify proxy (token never reaches browser)
  components/
    FocusCapture.tsx             The client island: camera loop, helper, polling, debug UI
  lib/
    cv/
      detector.ts                MediaPipe FaceLandmarker setup, memoised
      signals.ts                 Landmarks -> yaw/pitch/roll, EAR, blink score
      state-machine.ts           Debounced attention states + tuning thresholds
      types.ts
    focus/
      recorder.ts                Interval open/close lifecycle
      helper-client.ts           WebSocket client for the macOS helper
      categories.ts              bundle id -> productive/distracting/neutral
    spotify.ts                   OAuth, token refresh, API calls
    supabase-admin.ts            Service-role client (server-only)
    session.ts / auth.ts         HMAC session cookie
helper/
  focus-helper.js                Reports frontmost macOS app over localhost WebSocket
```

### Why a helper process exists

A browser page **cannot** see which application is frontmost. `getDisplayMedia` returns
pixels and nothing else — no window title, no app identity — deliberately, as a privacy
boundary. So screen capture can't answer "am I in Slack right now", and a 50-line local
helper can, with no vision involved at all.

Bundle id and app name need no macOS permission. Window titles need Accessibility, which is
why `window_title` is nullable and unused by default.

This ties capture to local development: browsers block `ws://` from an `https://` page, so a
TLS deploy would need a different transport.

---

## Tuning

Thresholds in [src/lib/cv/state-machine.ts](src/lib/cv/state-machine.ts) are starting points.
Head pose is relative to where the laptop sits, so values tuned at a desk will be wrong on a
couch.

The debug readout on `/focus` shows live `yaw`, `pitch`, `roll`, `blink` and `ear` alongside
the committed state and what's pending. Watch it while you move:

- Turn your head until `looking_away` fires — adjust `yawThresholdDeg`.
- Look down; `gaze_down` should fire. (The raw matrix decomposition came out inverted, so
  `signals.ts` negates pitch. If it ever reads backwards again, that's the line.)
- If `blink` shows `— (no blendshape)` rather than a number, the blendshape category names
  in `signals.ts` don't match the model and `ear` is driving sleep detection instead.

---

## Assets

`npm run setup:assets` handles both. To fetch the model alone:

```bash
curl -fL -o public/models/face_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

And the WASM runtime alone:

```bash
mkdir -p public/mediapipe/wasm && cp node_modules/@mediapipe/tasks-vision/wasm/* public/mediapipe/wasm/
```

Both are served from `public/` rather than a CDN so inference keeps working offline. Without
the model, *Start capture* fails at detector load.

---

## Scripts

| | |
|---|---|
| `npm run dev` | Dev server — open at `127.0.0.1:3000` |
| `npm run build` | Production build |
| `npm start` | Production server |
| `npm run lint` | ESLint |
| `npm run setup:assets` | Fetch MediaPipe model + WASM runtime |
