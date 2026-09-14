import { ZERO_BASELINE } from "./types";
import type { AttentionState, AttentionTransition, GazeBaseline, RawSample } from "./types";

/**
 * Gaze thresholds for one measurement source. Blendshape scores and iris
 * offsets measure the same thing on completely unrelated scales - roughly
 * 0..1 against a fraction of eye width - so they cannot share numbers. One
 * set each, so the fallback path still actually fires.
 */
export type GazeThresholds = {
  /** Baseline-relative eye-down that reads as gaze_down on its own. */
  down: number;
  /** Lower bar, which only counts when the head has dipped too. */
  downSoft: number;
  /** Baseline-relative |horizontal| that reads as looking_away. */
  side: number;
};

export type StateMachineConfig = {
  /** |yaw| beyond this reads as looking away, in degrees. */
  yawThresholdDeg: number;
  /** pitch below this reads as gaze_down on head pose alone, in degrees. */
  pitchDownThresholdDeg: number;
  /**
   * The much smaller head dip that pairs with eyes-down, in degrees. Looking
   * at a phone on the desk is mostly an eye movement with a dip well short
   * of pitchDownThresholdDeg, so neither signal crosses its own bar alone.
   */
  pitchSoftDownDeg: number;
  /** Blendshape closed-ness above this counts as a closed eye. */
  blinkScoreThreshold: number;
  /** EAR below this counts as a closed eye. Used when blendshapes are absent. */
  earThreshold: number;
  /**
   * Beyond this |yaw|, eye landmarks are too foreshortened to trust, so
   * 'asleep' is suppressed. Without this, turning away from the screen reads
   * as closed eyes and eventually as sleeping.
   */
  asleepMaxYawDeg: number;
  /**
   * Beyond this |yaw| the eye signals are too foreshortened to trust, so
   * gaze is ignored and classification falls back to head pose alone. Same
   * reasoning as asleepMaxYawDeg, and deliberately a touch tighter: gaze is
   * a finer measurement off the same foreshortened landmarks.
   */
  gazeMaxYawDeg: number;
  /** Thresholds for the eyeLook* blendshapes, the preferred source. */
  blendshapeGaze: GazeThresholds;
  /** Thresholds for the iris-offset fallback. */
  irisGaze: GazeThresholds;
  /** Consecutive samples of a candidate state required to commit to it. */
  enter: Record<AttentionState, number>;
};

// Starting points only. These MUST be tuned against the live debug readout -
// head pose depends on where the laptop sits relative to your face, so a
// threshold tuned at a desk will be wrong on a couch. See docs/cv-plan.md §2.
export const DEFAULT_CONFIG: StateMachineConfig = {
  yawThresholdDeg: 25,
  pitchDownThresholdDeg: -20,
  pitchSoftDownDeg: -8,
  blinkScoreThreshold: 0.5,
  earThreshold: 0.18,
  asleepMaxYawDeg: 35,
  gazeMaxYawDeg: 30,
  blendshapeGaze: { down: 0.35, downSoft: 0.2, side: 0.35 },
  // An order of magnitude smaller because the unit is a fraction of eye
  // width, not a 0..1 score. Tune against the `iris` row of the readout.
  irisGaze: { down: 0.06, downSoft: 0.035, side: 0.06 },
  enter: {
    // Asymmetric on purpose: slow to leave focused, fast to return. One bad
    // sample (a stretch, a sip of coffee) shouldn't register as distraction,
    // but actually getting back to work should be credited immediately.
    focused: 2,
    looking_away: 5,
    gaze_down: 5,
    absent: 5,
    // Longest window of the five: a misfire here is the highest-consequence
    // one, and 10s of continuously closed eyes is a signal nothing else
    // produces. At 1 fps this is also what separates sleep from a blink.
    asleep: 10,
  },
};

function eyesClosed(sample: RawSample, cfg: StateMachineConfig): boolean {
  if (sample.blinkScore !== null) return sample.blinkScore > cfg.blinkScoreThreshold;
  if (sample.ear !== null) return sample.ear < cfg.earThreshold;
  return false;
}

/**
 * Baseline-corrected gaze, with the thresholds that go with whichever source
 * produced it. Prefers the blendshapes and falls back to iris geometry,
 * exactly as eyesClosed() prefers blinkScore over ear. Null means neither
 * source was available and the caller should use head pose alone.
 */
function resolveGaze(
  sample: RawSample,
  cfg: StateMachineConfig,
  baseline: GazeBaseline
): { vertical: number; horizontal: number; t: GazeThresholds } | null {
  if (sample.gazeVertical !== null && sample.gazeHorizontal !== null) {
    return {
      vertical: sample.gazeVertical - baseline.gazeVertical,
      horizontal: sample.gazeHorizontal - baseline.gazeHorizontal,
      t: cfg.blendshapeGaze,
    };
  }
  if (sample.irisVertical !== null && sample.irisHorizontal !== null) {
    return {
      vertical: sample.irisVertical - baseline.irisVertical,
      horizontal: sample.irisHorizontal - baseline.irisHorizontal,
      t: cfg.irisGaze,
    };
  }
  return null;
}

/** Classify a single sample, before any debouncing. */
export function classify(
  sample: RawSample,
  cfg: StateMachineConfig,
  baseline: GazeBaseline = ZERO_BASELINE
): AttentionState {
  if (!sample.facePresent) return "absent";

  const yaw = sample.yaw ?? 0;
  const pitch = sample.pitch ?? 0;

  // Checked before pose so a head-down doze doesn't read as gaze_down, but
  // suppressed at extreme yaw where the eye landmarks aren't trustworthy.
  if (eyesClosed(sample, cfg) && Math.abs(yaw) < cfg.asleepMaxYawDeg) return "asleep";

  const gaze = Math.abs(yaw) < cfg.gazeMaxYawDeg ? resolveGaze(sample, cfg, baseline) : null;

  if (gaze) {
    if (gaze.vertical > gaze.t.down) return "gaze_down";
    // The case head pitch alone misses, and the reason gaze is here at all:
    // glancing at a phone is a small dip *plus* eyes down, with neither
    // crossing its own threshold.
    if (pitch - baseline.pitch < cfg.pitchSoftDownDeg && gaze.vertical > gaze.t.downSoft) {
      return "gaze_down";
    }
  }

  // Head pose is still checked unconditionally, so behaviour degrades to
  // what it was before gaze existed if the eye signals ever go missing.
  if (pitch < cfg.pitchDownThresholdDeg) return "gaze_down";

  if (gaze && Math.abs(gaze.horizontal) > gaze.t.side) return "looking_away";
  if (Math.abs(yaw) > cfg.yawThresholdDeg) return "looking_away";

  return "focused";
}

/**
 * Debounces per-sample classifications into durable states. Raw 1 fps
 * classifications are far too noisy to store directly - this is what turns
 * them into the intervals that actually get written.
 */
export class AttentionStateMachine {
  private current: AttentionState | null = null;
  private candidate: AttentionState | null = null;
  private candidateCount = 0;
  private samplesInCurrentCount = 0;

  constructor(
    private cfg: StateMachineConfig = DEFAULT_CONFIG,
    private baseline: GazeBaseline = ZERO_BASELINE
  ) {}

  get state(): AttentionState | null {
    return this.current;
  }

  /** Swap in a freshly measured baseline without restarting the session. */
  setBaseline(baseline: GazeBaseline) {
    this.baseline = baseline;
  }

  /** Feed one sample. Returns a transition if this sample caused one. */
  push(sample: RawSample): AttentionTransition | null {
    const candidate = classify(sample, this.cfg, this.baseline);

    if (candidate === this.current) {
      this.candidate = null;
      this.candidateCount = 0;
      this.samplesInCurrentCount++;
      return null;
    }

    if (candidate === this.candidate) {
      this.candidateCount++;
    } else {
      this.candidate = candidate;
      this.candidateCount = 1;
    }

    if (this.candidateCount < this.cfg.enter[candidate]) {
      // Still accumulating evidence - the current state keeps the sample.
      this.samplesInCurrentCount++;
      return null;
    }

    const transition: AttentionTransition = {
      from: this.current,
      to: candidate,
      at: sample.at,
      samplesInPrevious: this.samplesInCurrentCount,
    };

    this.current = candidate;
    this.candidate = null;
    this.candidateCount = 0;
    this.samplesInCurrentCount = 1;

    return transition;
  }

  /**
   * Samples accumulated in the current state. Needed when capture stops
   * mid-interval: without this the final interval of every session closes
   * with sample_count 0, which reads as "no samples backed this" rather
   * than "we stopped before the next transition".
   */
  get samplesInCurrent(): number {
    return this.samplesInCurrentCount;
  }

  /** For the debug readout: what's currently building toward a transition. */
  get pending(): { candidate: AttentionState; count: number; needed: number } | null {
    if (!this.candidate) return null;
    return {
      candidate: this.candidate,
      count: this.candidateCount,
      needed: this.cfg.enter[this.candidate],
    };
  }
}
