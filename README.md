# spotifything

A single-user tool that measures how focused you are while working and correlates it
against what Spotify is playing. A webcam classifies attention state once a second and that
is lined up against playback history to answer the actual question: **which music keeps me
focused.**

Everything runs in the browser. Nothing is installed and nothing else runs on the machine.

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

```bash
npm run dev
```

Then open **http://127.0.0.1:3000/focus**, click *Start capture*, and click *Calibrate*
once while looking at the centre of the screen.

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

### Things that look like errors but aren't

- `INFO: Created TensorFlow Lite XNNPACK delegate for CPU.` — an informational log MediaPipe
  writes via `console.error`, which Next's dev overlay promotes to an error card. Harmless,
  and absent from production builds.

---

## How it works

Two **independent** interval streams, deliberately not correlated on write. They change at
unrelated rates, so joining them on the way in would let a track change spuriously split an
attention interval. They're joined by time overlap at query time instead.

| Stream | Source | Table |
|---|---|---|
| Attention | webcam, 1 fps | `attention_intervals` |
| Playback | Spotify poll, 30s | `playback_intervals` |

Both are scoped to a row in `capture_sessions`, which records when capture was actually
running — without it, "away from the computer" and "nothing was recorded" are
indistinguishable, and every focus percentage would be inflated.

**Attention states:** `focused`, `looking_away`, `gaze_down`, `absent`, `asleep`. A state
machine debounces raw per-sample classifications with asymmetric hysteresis — slow to leave
`focused`, fast to return — so one stretch or sip of coffee isn't recorded as distraction.

`gaze_down` and `looking_away` read **the eyes, not just the head**. The `eyeLook*`
blendshapes give eye rotation relative to the head, which is exactly the component head pose
cannot see — glancing at a phone is mostly an eye movement with a head dip far too small to
cross a pitch threshold. Head pose is still checked unconditionally, so classification
degrades to head-only if the eye signals ever go missing. Iris landmarks (this is the
478-point refined mesh) provide the same measurement geometrically, as a fallback and a
cross-check.

`gaze_down` still deliberately conflates phone, keyboard, and desk. Separating them needs a
second object-detection model for the sake of one event type.

**At 1 fps, blink *rate* is not detectable** — blinks last 100–400ms and alias away. Sleep
detection works because it uses sustained eye closure (10 consecutive samples), not blink
frequency. Gaze is subject to the same limit: saccades alias away too, so what is measured
is sustained gaze direction, which is what the states are about anyway.

### Why there is no app tracking

Earlier versions recorded which app was frontmost, via a small macOS helper process polling
`osascript` over a localhost WebSocket. That was removed so this can be a website you just
open.

A browser page **cannot** see which application is frontmost — `getDisplayMedia` returns
pixels and nothing else, no window title, no app identity, deliberately, as a privacy
boundary. A local helper was the only way to get it, and browsers block `ws://` from an
`https://` page, so it could never have survived being hosted. Nothing browser-only
substitutes for it: the Idle Detection API gives idle/locked but not app identity, and an
extension is still an install.

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
    FocusCapture.tsx             The client island: camera loop, calibration, polling, debug UI
  lib/
    cv/
      detector.ts                MediaPipe FaceLandmarker setup, memoised
      signals.ts                 Landmarks -> yaw/pitch/roll, gaze, iris, EAR, blink score
      state-machine.ts           Debounced attention states + tuning thresholds
      calibration.ts             Resting-gaze baseline: measure, persist, restore
      types.ts
    focus/
      recorder.ts                Interval open/close lifecycle
    spotify.ts                   OAuth, token refresh, API calls
    supabase-admin.ts            Service-role client (server-only)
    session.ts / auth.ts         HMAC session cookie
```

---

## Tuning

Thresholds in [src/lib/cv/state-machine.ts](src/lib/cv/state-machine.ts) are starting points.
Head pose and resting gaze are both relative to where the laptop sits, so values tuned at a
desk will be wrong on a couch.

*Calibrate* handles the resting point: three seconds at 10 Hz looking at the centre of the
screen, median-filtered so a blink doesn't skew it, stored in `localStorage` and subtracted
before any threshold is applied. It's worth redoing when you move the machine. Uncalibrated
sessions still classify — the baseline just defaults to zeros.

The debug readout on `/focus` shows live `yaw`, `pitch`, `roll`, `blink`, `ear`, `gaze v/h`,
`iris v/h` and the active `baseline` alongside the committed state and what's pending. Watch
it while you move:

- Turn your head until `looking_away` fires — adjust `yawThresholdDeg`.
- Look down; `gaze_down` should fire. (The raw matrix decomposition came out inverted, so
  `signals.ts` negates pitch. If it ever reads backwards again, that's the line.)
- Look down **with your eyes only**, head still; `gaze_down` should still fire. Adjust
  `blendshapeGaze.down` — too low and reading the bottom of the screen trips it.
- Check the gaze signs before trusting any of it: looking down should drive `gaze v` positive.
  If it reads backwards, negate it in `signals.ts`, the way pitch already is.
- `blendshapeGaze` and `irisGaze` have separate thresholds on purpose: one is a 0..1 score,
  the other a fraction of eye width. They are not interchangeable numbers.
- If `blink` or `gaze v/h` shows `—` rather than a number, the blendshape category names in
  `signals.ts` don't match the model, and `ear` / `iris v/h` are driving classification.

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
