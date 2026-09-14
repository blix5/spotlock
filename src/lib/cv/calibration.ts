import { ZERO_BASELINE } from "./types";
import type { GazeBaseline, RawSample } from "./types";

const STORAGE_KEY = "focus:gaze-baseline";

// 3 seconds at 10 Hz. The capture loop's own 1 fps would need half a minute
// to collect this many, which is far longer than anyone will hold still.
export const CALIBRATION_SAMPLE_MS = 100;
export const CALIBRATION_SAMPLES = 30;

// Below this the sample is too thin to be worth storing - the user looked
// away, or the face wasn't found for most of the window.
const MIN_USABLE_SAMPLES = 15;

// Hard ceiling on ticks, so the loop terminates even if takeSample never
// yields anything. Without it, stopping capture mid-calibration would leave
// the interval running forever waiting for samples that can no longer
// arrive. Twice the target leaves room for a few dropped frames.
const MAX_TICKS = CALIBRATION_SAMPLES * 2;

/**
 * Median, not mean: a blink or a glance away mid-calibration is a large
 * outlier on exactly the signals being measured, and the mean would carry
 * it into the baseline.
 */
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function medianOf(samples: RawSample[], pick: (s: RawSample) => number | null): number | null {
  return median(samples.map(pick).filter((v): v is number => v !== null));
}

/** Reduce a window of samples to a baseline. Null if too few were usable. */
export function baselineFrom(samples: RawSample[]): GazeBaseline | null {
  const usable = samples.filter((s) => s.facePresent);
  if (usable.length < MIN_USABLE_SAMPLES) return null;

  return {
    gazeVertical: medianOf(usable, (s) => s.gazeVertical) ?? 0,
    gazeHorizontal: medianOf(usable, (s) => s.gazeHorizontal) ?? 0,
    irisVertical: medianOf(usable, (s) => s.irisVertical) ?? 0,
    irisHorizontal: medianOf(usable, (s) => s.irisHorizontal) ?? 0,
    pitch: medianOf(usable, (s) => s.pitch) ?? 0,
  };
}

/**
 * Collect a calibration window. `takeSample` is called every
 * CALIBRATION_SAMPLE_MS; the caller owns the detector and is responsible for
 * making sure nothing else drives it concurrently - MediaPipe's VIDEO mode
 * rejects timestamps that don't strictly increase.
 */
export function measureBaseline(takeSample: () => RawSample | null): Promise<GazeBaseline | null> {
  return new Promise((resolve) => {
    const samples: RawSample[] = [];
    let ticks = 0;

    const timer = setInterval(() => {
      ticks++;
      const sample = takeSample();
      if (sample) samples.push(sample);

      if (samples.length >= CALIBRATION_SAMPLES || ticks >= MAX_TICKS) {
        clearInterval(timer);
        // baselineFrom returns null on a short window, so giving up early
        // reports "couldn't calibrate" rather than storing a thin baseline.
        resolve(baselineFrom(samples));
      }
    }, CALIBRATION_SAMPLE_MS);
  });
}

// Storage access is wrapped throughout: it throws outright in some contexts
// (private windows, site data blocked), and an unusable baseline should
// degrade to zeros rather than take capture down.
export function loadBaseline(): GazeBaseline {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return ZERO_BASELINE;

    const parsed = JSON.parse(raw);
    const keys = Object.keys(ZERO_BASELINE) as (keyof GazeBaseline)[];
    if (keys.some((k) => typeof parsed?.[k] !== "number")) return ZERO_BASELINE;

    return Object.fromEntries(keys.map((k) => [k, parsed[k]])) as unknown as GazeBaseline;
  } catch {
    return ZERO_BASELINE;
  }
}

export function saveBaseline(baseline: GazeBaseline) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(baseline));
  } catch {
    // Baseline just won't survive the reload; capture is unaffected.
  }
}
