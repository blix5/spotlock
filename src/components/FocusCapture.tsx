"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import {
  CALIBRATION_SAMPLES,
  CALIBRATION_SAMPLE_MS,
  loadBaseline,
  measureBaseline,
  saveBaseline,
} from "@/lib/cv/calibration";
import { loadDetector, sample as runSample } from "@/lib/cv/detector";
import { AttentionStateMachine, DEFAULT_CONFIG } from "@/lib/cv/state-machine";
import { ZERO_BASELINE } from "@/lib/cv/types";
import type { AttentionState, GazeBaseline, PlaybackState, RawSample } from "@/lib/cv/types";
import { IntervalRecorder } from "@/lib/focus/recorder";

const SAMPLE_INTERVAL_MS = 1000;
const CALIBRATION_MS = CALIBRATION_SAMPLES * CALIBRATION_SAMPLE_MS;
// Track-level attribution is all this needs, so polling can be lazy - which
// is also why Spotify's rate limits stop being a design pressure. See
// docs/cv-plan.md §5.
const PLAYBACK_POLL_MS = 30_000;

type Status = "idle" | "starting" | "running" | "error";

type Debug = {
  sample: RawSample | null;
  state: AttentionState | null;
  pending: { candidate: AttentionState; count: number; needed: number } | null;
  playback: PlaybackState | null;
  baseline: GazeBaseline;
};

const EMPTY_DEBUG: Debug = {
  sample: null,
  state: null,
  pending: null,
  playback: null,
  baseline: ZERO_BASELINE,
};

export function FocusCapture() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<Debug>(EMPTY_DEBUG);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timersRef = useRef<ReturnType<typeof setInterval>[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const recordersRef = useRef<{
    attention: IntervalRecorder;
    playback: IntervalRecorder;
  } | null>(null);
  const machineRef = useRef<AttentionStateMachine | null>(null);
  const detectorRef = useRef<FaceLandmarker | null>(null);
  // Set while calibrating so the 1 fps loop stands down: MediaPipe's VIDEO
  // mode rejects timestamps that don't strictly increase, so exactly one
  // loop may drive the detector at a time.
  const calibratingRef = useRef(false);
  const [calibrating, setCalibrating] = useState(false);

  const stop = useCallback(async () => {
    timersRef.current.forEach(clearInterval);
    timersRef.current = [];

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

      // Any remaining open playback interval is swept server-side, where
      // sample_count doesn't apply.
      await fetch("/api/focus/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ended: true }),
      }).catch(() => {});
    }

    sessionIdRef.current = null;
    recordersRef.current = null;
    machineRef.current = null;
    detectorRef.current = null;
    // Keep the measured baseline on screen - it outlives the session.
    setDebug((d) => ({ ...EMPTY_DEBUG, baseline: d.baseline }));
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
      detectorRef.current = detector;

      const sessionRes = await fetch("/api/focus/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameraEnabled: true }),
      });
      if (!sessionRes.ok) throw new Error(`could not start session (${sessionRes.status})`);
      const { sessionId } = await sessionRes.json();
      sessionIdRef.current = sessionId;

      const recorders = {
        attention: new IntervalRecorder("attention", sessionId),
        playback: new IntervalRecorder("playback", sessionId),
      };
      recordersRef.current = recorders;

      // Whatever calibration last measured, or zeros - an uncalibrated
      // session still classifies, just against a less precise resting point.
      // Read here rather than on mount: localStorage doesn't exist during
      // SSR, so reading it into state any earlier means a hydration mismatch.
      const baseline = loadBaseline();
      const machine = new AttentionStateMachine(DEFAULT_CONFIG, baseline);
      machineRef.current = machine;
      setDebug((d) => ({ ...d, baseline }));

      // --- camera loop, 1 fps ---
      const cameraTimer = setInterval(() => {
        // Calibration owns the detector for its 3s window; those few samples
        // are dropped rather than interleaved.
        if (calibratingRef.current) return;
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

  /**
   * Measure where the eyes rest while looking at the screen. A laptop sits
   * below eye line, so resting gaze is not zero and moves with the machine -
   * without this the eye-down threshold would need re-tuning every time the
   * laptop does, which is the same trap the head-pose thresholds are in.
   */
  const calibrate = useCallback(async () => {
    const detector = detectorRef.current;
    if (!detector) return;

    setCalibrating(true);
    calibratingRef.current = true;

    try {
      const baseline = await measureBaseline(() => {
        const video = videoRef.current;
        if (!video || video.readyState < 2) return null;
        return runSample(detector, video, performance.now(), Date.now());
      });

      if (!baseline) {
        setError("Calibration needs a face in frame for the full three seconds.");
        return;
      }

      machineRef.current?.setBaseline(baseline);
      saveBaseline(baseline);
      setDebug((d) => ({ ...d, baseline }));
      setError(null);
    } finally {
      calibratingRef.current = false;
      setCalibrating(false);
    }
  }, []);

  // Teardown only - starting is driven by the button, which avoids
  // StrictMode's double-invoke starting two capture sessions.
  useEffect(() => {
    return () => {
      timersRef.current.forEach(clearInterval);
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
        <button
          onClick={calibrate}
          disabled={status !== "running" || calibrating}
          className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium disabled:opacity-40 dark:border-zinc-700"
        >
          {calibrating ? `Hold still… ${CALIBRATION_MS / 1000}s` : "Calibrate"}
        </button>
        <StatusDot label="camera" on={status === "running"} />
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
 * pose and resting gaze both depend on where the laptop sits relative to
 * your face. This readout is how they get tuned: watch yaw/pitch and
 * gaze v/h while moving, then set thresholds.
 *
 * It is also where the gaze *signs* get validated. Positive vertical is
 * meant to be looking down; if it reads the other way, negate it in
 * signals.ts rather than flipping the threshold, the way pitch already is.
 */
function fmtPair(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return "—";
  return `${a >= 0 ? "+" : ""}${a.toFixed(3)} / ${b >= 0 ? "+" : ""}${b.toFixed(3)}`;
}

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
    ["gaze v/h", fmtPair(s?.gazeVertical, s?.gazeHorizontal)],
    ["iris v/h", fmtPair(s?.irisVertical, s?.irisHorizontal)],
    [
      "baseline",
      `${fmtPair(debug.baseline.gazeVertical, debug.baseline.gazeHorizontal)} @ ${debug.baseline.pitch.toFixed(1)}°`,
    ],
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
