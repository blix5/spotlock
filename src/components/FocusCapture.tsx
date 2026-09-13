"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { loadDetector, sample as runSample } from "@/lib/cv/detector";
import { AttentionStateMachine, DEFAULT_CONFIG } from "@/lib/cv/state-machine";
import type { AppState, AttentionState, PlaybackState, RawSample } from "@/lib/cv/types";
import { categorize } from "@/lib/focus/categories";
import { connectHelper } from "@/lib/focus/helper-client";
import { IntervalRecorder } from "@/lib/focus/recorder";

const SAMPLE_INTERVAL_MS = 1000;
// Track-level attribution is all this needs, so polling can be lazy - which
// is also why Spotify's rate limits stop being a design pressure. See
// docs/cv-plan.md §5.
const PLAYBACK_POLL_MS = 30_000;

type Status = "idle" | "starting" | "running" | "error";

type Debug = {
  sample: RawSample | null;
  state: AttentionState | null;
  pending: { candidate: AttentionState; count: number; needed: number } | null;
  app: AppState | null;
  playback: PlaybackState | null;
  helperConnected: boolean;
};

const EMPTY_DEBUG: Debug = {
  sample: null,
  state: null,
  pending: null,
  app: null,
  playback: null,
  helperConnected: false,
};

export function FocusCapture() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<Debug>(EMPTY_DEBUG);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const disconnectHelperRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const recordersRef = useRef<{
    attention: IntervalRecorder;
    app: IntervalRecorder;
    playback: IntervalRecorder;
  } | null>(null);
  const machineRef = useRef<AttentionStateMachine | null>(null);

  const stop = useCallback(async () => {
    timersRef.current.forEach(clearInterval);
    timersRef.current = [];

    disconnectHelperRef.current?.();
    disconnectHelperRef.current = null;

    // Stop every track explicitly - skipping this leaves the camera
    // indicator light on, which reads as a bug even when nothing is wrong.
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    const sessionId = sessionIdRef.current;
    if (sessionId) {
      // Close the in-progress attention interval here rather than letting the
      // server's sweep do it: the sweep only sets ended_at, so the last
      // interval of every session would keep sample_count 0 and read as
      // "no samples backed this" instead of "we stopped mid-interval".
      const machine = machineRef.current;
      const recorders = recordersRef.current;
      if (machine?.state && recorders) {
        await recorders.attention.close(Date.now(), machine.samplesInCurrent);
      }

      // Any remaining open intervals (app, playback) are swept server-side,
      // where sample_count doesn't apply.
      await fetch("/api/focus/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ended: true }),
      }).catch(() => {});
    }

    sessionIdRef.current = null;
    recordersRef.current = null;
    machineRef.current = null;
    setDebug(EMPTY_DEBUG);
    setStatus("idle");
  }, []);

  const start = useCallback(async () => {
    setStatus("starting");
    setError(null);

    try {
      // Requested behind an explicit click, never on mount: an unprompted
      // camera prompt on page load is hostile and more likely to be denied.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) throw new Error("video element not mounted");
      video.srcObject = stream;
      await video.play();

      // Permission can be revoked mid-session; the track ends rather than
      // erroring, so without this we'd silently record nothing forever.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        setError("Camera access ended (revoked or device disconnected).");
        void stop();
      });

      const detector = await loadDetector();

      const sessionRes = await fetch("/api/focus/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraEnabled: true, helperConnected: false }),
      });
      if (!sessionRes.ok) throw new Error(`could not start session (${sessionRes.status})`);
      const { sessionId } = await sessionRes.json();
      sessionIdRef.current = sessionId;

      const recorders = {
        attention: new IntervalRecorder("attention", sessionId),
        app: new IntervalRecorder("app", sessionId),
        playback: new IntervalRecorder("playback", sessionId),
      };
      recordersRef.current = recorders;

      const machine = new AttentionStateMachine(DEFAULT_CONFIG);
      machineRef.current = machine;

      // --- camera loop, 1 fps ---
      const cameraTimer = setInterval(() => {
        if (!videoRef.current || videoRef.current.readyState < 2) return;
        const at = Date.now();
        // MediaPipe's VIDEO mode rejects non-monotonic timestamps, so this
        // has to be performance.now() rather than wall clock.
        const raw = runSample(detector, videoRef.current, performance.now(), at);
        const transition = machine.push(raw);

        if (transition) {
          void recorders.attention.transition(
            { state: transition.to },
            transition.at,
            transition.samplesInPrevious
          );
        }

        setDebug((d) => ({ ...d, sample: raw, state: machine.state, pending: machine.pending }));
      }, SAMPLE_INTERVAL_MS);

      // --- app state, event-driven from the helper ---
      let lastBundleId: string | null = null;
      const disconnect = connectHelper({
        onApp: (app) => {
          setDebug((d) => ({ ...d, app }));
          if (app.bundleId === lastBundleId) return;
          lastBundleId = app.bundleId;
          void recorders.app.transition(
            {
              bundle_id: app.bundleId,
              app_name: app.appName,
              window_title: app.windowTitle,
              category: categorize(app),
            },
            Date.now()
          );
        },
        onStatus: (helperConnected) => {
          setDebug((d) => ({ ...d, helperConnected }));
          void fetch("/api/focus/session", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId, helperConnected }),
          }).catch(() => {});
          if (!helperConnected) {
            lastBundleId = null;
            void recorders.app.close();
          }
        },
      });
      disconnectHelperRef.current = disconnect;

      // --- playback poll ---
      let lastTrackId: string | null = null;
      const pollPlayback = async () => {
        try {
          const res = await fetch("/api/focus/playback");
          if (!res.ok) return;
          const { playing } = await res.json();

          if (!playing || !playing.isPlaying) {
            setDebug((d) => ({ ...d, playback: null }));
            if (lastTrackId) {
              lastTrackId = null;
              void recorders.playback.close();
            }
            return;
          }

          setDebug((d) => ({ ...d, playback: playing }));
          if (playing.trackId === lastTrackId) return;
          lastTrackId = playing.trackId;

          void recorders.playback.transition(
            {
              spotify_track_id: playing.trackId,
              track_name: playing.trackName,
              artist_names: playing.artistNames,
              album_name: playing.albumName,
              start_progress_ms: playing.progressMs,
            },
            Date.now()
          );
        } catch {
          // Transient network failure; the next poll picks it up.
        }
      };
      void pollPlayback();
      const playbackTimer = setInterval(pollPlayback, PLAYBACK_POLL_MS);

      timersRef.current = [cameraTimer, playbackTimer];
      setStatus("running");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to start capture");
      setStatus("error");
      await stop();
    }
  }, [stop]);

  // Teardown only - starting is driven by the button, which avoids
  // StrictMode's double-invoke starting two capture sessions.
  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearInterval);
      disconnectHelperRef.current?.();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const sessionId = sessionIdRef.current;
      if (sessionId) {
        navigator.sendBeacon?.(
          "/api/focus/session",
          new Blob([JSON.stringify({ sessionId, ended: true })], { type: "application/json" })
        );
      }
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <button
          onClick={status === "running" ? stop : start}
          disabled={status === "starting"}
          className="rounded-full bg-[#1DB954] px-5 py-2 font-medium text-black disabled:opacity-50"
        >
          {status === "running" ? "Stop capture" : status === "starting" ? "Starting…" : "Start capture"}
        </button>
        <StatusDot label="camera" on={status === "running"} />
        <StatusDot label="helper" on={debug.helperConnected} />
        <StatusDot label="spotify" on={!!debug.playback} />
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div className="flex flex-col gap-4 sm:flex-row">
        <video
          ref={videoRef}
          muted
          playsInline
          className="w-64 rounded-lg bg-zinc-200 dark:bg-zinc-800"
        />
        <DebugReadout debug={debug} />
      </div>
    </div>
  );
}

function StatusDot({ label, on }: { label: string; on: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-zinc-500">
      <span
        className={`h-2 w-2 rounded-full ${on ? "bg-green-500" : "bg-zinc-400 dark:bg-zinc-600"}`}
      />
      {label}
    </span>
  );
}

/**
 * The thresholds in state-machine.ts can't be picked from a document - head
 * pose depends on where the laptop sits relative to your face. This readout
 * is how they get tuned: watch yaw/pitch while moving, then set thresholds.
 */
function DebugReadout({ debug }: { debug: Debug }) {
  const s = debug.sample;
  const rows: [string, string][] = [
    ["state", debug.state ?? "—"],
    [
      "pending",
      debug.pending
        ? `${debug.pending.candidate} ${debug.pending.count}/${debug.pending.needed}`
        : "—",
    ],
    ["face", s ? (s.facePresent ? "yes" : "no") : "—"],
    ["yaw", s?.yaw != null ? `${s.yaw.toFixed(1)}°` : "—"],
    ["pitch", s?.pitch != null ? `${s.pitch.toFixed(1)}°` : "—"],
    ["roll", s?.roll != null ? `${s.roll.toFixed(1)}°` : "—"],
    ["blink", s?.blinkScore != null ? s.blinkScore.toFixed(3) : "— (no blendshape)"],
    ["ear", s?.ear != null ? s.ear.toFixed(3) : "—"],
    ["app", debug.app ? `${debug.app.appName ?? debug.app.bundleId}` : "—"],
    ["track", debug.playback ? `${debug.playback.trackName}` : "—"],
  ];

  return (
    <dl className="grid flex-1 grid-cols-[6rem_1fr] gap-x-4 gap-y-1 font-mono text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
