import type { AttentionState, AttentionTransition, RawSample } from "./types";

export type StateMachineConfig = {
  /** |yaw| beyond this reads as looking away, in degrees. */
  yawThresholdDeg: number;
  /** pitch below this reads as gaze_down, in degrees (negative = head down). */
  pitchDownThresholdDeg: number;
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
  /** Consecutive samples of a candidate state required to commit to it. */
  enter: Record<AttentionState, number>;
};

// Starting points only. These MUST be tuned against the live debug readout -
// head pose depends on where the laptop sits relative to your face, so a
// threshold tuned at a desk will be wrong on a couch. See docs/cv-plan.md §2.
export const DEFAULT_CONFIG: StateMachineConfig = {
  yawThresholdDeg: 25,
  pitchDownThresholdDeg: -20,
  blinkScoreThreshold: 0.5,
  earThreshold: 0.18,
  asleepMaxYawDeg: 35,
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

/** Classify a single sample, before any debouncing. */
export function classify(sample: RawSample, cfg: StateMachineConfig): AttentionState {
  if (!sample.facePresent) return "absent";

  const yaw = sample.yaw ?? 0;
  const pitch = sample.pitch ?? 0;

  // Checked before pose so a head-down doze doesn't read as gaze_down, but
  // suppressed at extreme yaw where the eye landmarks aren't trustworthy.
  if (eyesClosed(sample, cfg) && Math.abs(yaw) < cfg.asleepMaxYawDeg) return "asleep";

  if (pitch < cfg.pitchDownThresholdDeg) return "gaze_down";
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

  constructor(private cfg: StateMachineConfig = DEFAULT_CONFIG) {}

  get state(): AttentionState | null {
    return this.current;
  }

  /** Feed one sample. Returns a transition if this sample caused one. */
  push(sample: RawSample): AttentionTransition | null {
    const candidate = classify(sample, this.cfg);

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
