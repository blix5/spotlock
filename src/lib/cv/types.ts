// The five states the attention state machine can be in. 'gaze_down'
// deliberately conflates phone / keyboard / desk: head pitch alone can't
// separate them, and telling them apart needs a second object-detection
// model for the sake of one event type. See docs/cv-plan.md.
export const ATTENTION_STATES = [
  "focused",
  "gaze_down",
  "looking_away",
  "absent",
  "asleep",
] as const;

export type AttentionState = (typeof ATTENTION_STATES)[number];

// One camera sample. Emitted at 1 fps, which is why blink *rate* isn't
// derivable here - blinks last 100-400ms and alias away at this cadence.
// `eyesClosed` is only useful sustained (10+ consecutive), which is enough
// for sleep detection.
export type RawSample = {
  at: number; // Date.now() at capture
  facePresent: boolean;
  // Degrees. null when no face was detected.
  yaw: number | null;
  pitch: number | null;
  roll: number | null;
  // Blendshape-derived closed-ness, 0..1. null if the blendshape categories
  // weren't found in the model output.
  blinkScore: number | null;
  // Eye-aspect-ratio, computed from landmarks. Lower = more closed. null
  // when no face. Kept alongside blinkScore so the debug readout can show
  // both and the more reliable one can be picked empirically.
  ear: number | null;
};

export type AttentionTransition = {
  from: AttentionState | null;
  to: AttentionState;
  at: number;
  // Samples accumulated in the state being left, for `sample_count`.
  samplesInPrevious: number;
};

export type AppState = {
  bundleId: string;
  appName: string | null;
  windowTitle: string | null;
};

export type PlaybackState = {
  trackId: string;
  trackName: string | null;
  artistNames: string | null;
  albumName: string | null;
  progressMs: number;
};
