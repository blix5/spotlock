import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { RawSample } from "./types";

// Eye landmark rings in MediaPipe's 468-point face mesh, ordered for the
// eye-aspect-ratio formula: [outer, top1, top2, inner, bottom2, bottom1].
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];

// Blendshape categories for eye closure. NOTE: these names come from the
// standard MediaPipe blendshape set but are NOT verified against this
// package version's output - if they're absent, blinkScore comes back null
// and the EAR path below is used instead. Check the debug readout.
const BLINK_CATEGORIES = ["eyeBlinkLeft", "eyeBlinkRight"];

type Point = { x: number; y: number };

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Soukupova & Cech's eye-aspect-ratio: the ratio of eye height to width.
// Scale-invariant, so it doesn't need normalising against face size.
function eyeAspectRatio(landmarks: Point[], ring: number[]): number | null {
  const p = ring.map((i) => landmarks[i]);
  if (p.some((q) => !q)) return null;
  const width = dist(p[0], p[3]);
  if (width === 0) return null;
  return (dist(p[1], p[5]) + dist(p[2], p[4])) / (2 * width);
}

// Decompose a rotation matrix to intrinsic XYZ euler angles. MediaPipe's
// facial transformation matrix is a flattened 4x4 in column-major order, so
// element (row, col) lives at data[col * 4 + row].
//
// Pitch is negated: validated against a live camera, the raw decomposition
// came out inverted (looking *up* produced the negative values that
// state-machine.ts reads as gaze_down). Negating here rather than flipping
// the threshold keeps the documented convention true - negative pitch means
// head down - so the thresholds stay readable.
//
// Yaw and roll signs have NOT been separately validated; yaw is only ever
// used via Math.abs(), so its sign doesn't currently matter, and roll isn't
// used for classification at all.
function eulerFromMatrix(data: number[]): { yaw: number; pitch: number; roll: number } {
  const m = (row: number, col: number) => data[col * 4 + row];

  const sy = Math.hypot(m(0, 0), m(1, 0));
  const degenerate = sy < 1e-6;

  const pitch = -(degenerate ? Math.atan2(-m(1, 2), m(1, 1)) : Math.atan2(m(2, 1), m(2, 2)));
  const yaw = Math.atan2(-m(2, 0), sy);
  const roll = degenerate ? 0 : Math.atan2(m(1, 0), m(0, 0));

  const deg = (r: number) => (r * 180) / Math.PI;
  return { yaw: deg(yaw), pitch: deg(pitch), roll: deg(roll) };
}

// Turn one FaceLandmarker result into a RawSample. Everything downstream
// works off this shape, so the MediaPipe types don't leak past here.
export function toRawSample(result: FaceLandmarkerResult, at: number): RawSample {
  const landmarks = result.faceLandmarks?.[0];

  if (!landmarks || landmarks.length === 0) {
    return { at, facePresent: false, yaw: null, pitch: null, roll: null, blinkScore: null, ear: null };
  }

  const matrix = result.facialTransformationMatrixes?.[0];
  const pose = matrix ? eulerFromMatrix(matrix.data) : null;

  const categories = result.faceBlendshapes?.[0]?.categories ?? [];
  const blinkScores = BLINK_CATEGORIES.map(
    (name) => categories.find((c) => c.categoryName === name)?.score
  ).filter((s): s is number => typeof s === "number");

  const leftEar = eyeAspectRatio(landmarks, LEFT_EYE);
  const rightEar = eyeAspectRatio(landmarks, RIGHT_EYE);
  const ears = [leftEar, rightEar].filter((e): e is number => e !== null);

  return {
    at,
    facePresent: true,
    yaw: pose?.yaw ?? null,
    pitch: pose?.pitch ?? null,
    roll: pose?.roll ?? null,
    // Average both eyes: one eye occluded by head turn shouldn't read as a
    // blink on its own.
    blinkScore: blinkScores.length ? blinkScores.reduce((a, b) => a + b, 0) / blinkScores.length : null,
    ear: ears.length ? ears.reduce((a, b) => a + b, 0) / ears.length : null,
  };
}
