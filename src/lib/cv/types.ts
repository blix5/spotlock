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
  // Gaze direction from the eyeLook* blendshapes, signed, roughly -1..1.
  // Positive vertical = looking down. null if those categories are absent.
  //
  // These are eye rotation *relative to the head*, not gaze in world space -
  // which is the point: head pitch already covers the head's contribution,
  // and this covers the part it can't see. A phone glance is mostly this.
  //
  // At 1 fps these read sustained gaze direction only. Saccades alias away
  // exactly as blink rate does.
  gazeVertical: number | null;
  gazeHorizontal: number | null;
  // Iris centre offset within the eye, as a fraction of eye width. Same
  // quantity as above by a different route (landmark geometry rather than a
  // trained blendshape head), kept for the same reason `ear` sits beside
  // `blinkScore`: pick between them from the live readout, not from a doc.
  irisVertical: number | null;
  irisHorizontal: number | null;
};

/**
 * Per-person, per-machine resting values, subtracted before thresholding.
 *
 * A laptop sits below eye line, so resting gazeVertical is not zero - it
 * varies with where the machine is, the same problem the head-pose
 * thresholds have. Without this, the eye-down threshold would have to be
 * re-tuned every time the laptop moves.
 */
export type GazeBaseline = {
  gazeVertical: number;
  gazeHorizontal: number;
  irisVertical: number;
  irisHorizontal: number;
  pitch: number;
};

export const ZERO_BASELINE: GazeBaseline = {
  gazeVertical: 0,
  gazeHorizontal: 0,
  irisVertical: 0,
  irisHorizontal: 0,
  pitch: 0,
};

export type AttentionTransition = {
  from: AttentionState | null;
  to: AttentionState;
  at: number;
  // Samples accumulated in the state being left, for `sample_count`.
  samplesInPrevious: number;
};

export type PlaybackState = {
  trackId: string;
  trackName: string | null;
  artistNames: string | null;
  albumName: string | null;
  progressMs: number;
};
