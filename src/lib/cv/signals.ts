import type { FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import type { RawSample } from "./types";

// Eye landmark rings in MediaPipe's face mesh, ordered for the
// eye-aspect-ratio formula: [outer, top1, top2, inner, bottom2, bottom1].
// p[0] and p[3] are the two corners, which the iris offsets below reuse.
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];

// Iris centres. This model is the 478-point refined mesh, not the bare 468:
// FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS is the ring {474,475,476,477} and
// RIGHT_IRIS is {469,470,471,472}, which leaves 473 and 468 as the centres.
const LEFT_IRIS_CENTRE = 473;
const RIGHT_IRIS_CENTRE = 468;

// Blendshape categories for eye closure. Verified present in the downloaded
// float16 face_landmarker.task, along with the full ARKit-52 set.
const BLINK_CATEGORIES = ["eyeBlinkLeft", "eyeBlinkRight"];

// Gaze blendshapes: eye rotation *relative to the head*, which is precisely
// the component head pitch cannot see. A phone glance is mostly this, with
// only a small head dip. 'In' means toward the nose, 'out' away from it, so
// a signed horizontal needs one of each per direction.
const GAZE_DOWN = ["eyeLookDownLeft", "eyeLookDownRight"];
const GAZE_UP = ["eyeLookUpLeft", "eyeLookUpRight"];
const GAZE_LEFTWARD = ["eyeLookOutLeft", "eyeLookInRight"];
const GAZE_RIGHTWARD = ["eyeLookInLeft", "eyeLookOutRight"];

type Point = { x: number; y: number };
type Category = { categoryName: string; score: number };

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
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

/**
 * Where the iris sits within its eye, as a fraction of eye width. A second,
 * geometric read on the same thing the gaze blendshapes report - kept for
 * the same reason `ear` is kept alongside `blinkScore`: two independent
 * measurements shown side by side in the debug readout, so the better one
 * can be picked empirically rather than argued about.
 *
 * Both axes are normalised by eye *width* rather than height. Width is
 * stable; height collapses when the user squints, which would make a squint
 * read as a large vertical gaze offset.
 */
function irisOffset(
  landmarks: Point[],
  ring: number[],
  centreIndex: number
): { x: number; y: number } | null {
  const outer = landmarks[ring[0]];
  const inner = landmarks[ring[3]];
  const iris = landmarks[centreIndex];
  if (!outer || !inner || !iris) return null;

  const width = dist(outer, inner);
  if (width === 0) return null;

  const midX = (outer.x + inner.x) / 2;
  const midY = (outer.y + inner.y) / 2;
  return { x: (iris.x - midX) / width, y: (iris.y - midY) / width };
}

function scoreFor(categories: Category[], names: string[]): number | null {
  return mean(
    names
      .map((name) => categories.find((c) => c.categoryName === name)?.score)
      .filter((s): s is number => typeof s === "number")
  );
}

// Opposing blendshape pairs collapsed into one signed value. Null unless at
// least one side was found, so a model without these categories falls
// through to the iris path rather than reporting a confident zero.
function signedGaze(
  categories: Category[],
  positive: string[],
  negative: string[]
): number | null {
  const pos = scoreFor(categories, positive);
  const neg = scoreFor(categories, negative);
  if (pos === null && neg === null) return null;
  return (pos ?? 0) - (neg ?? 0);
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

const ABSENT: RawSample = {
  at: 0,
  facePresent: false,
  yaw: null,
  pitch: null,
  roll: null,
  blinkScore: null,
  ear: null,
  gazeVertical: null,
  gazeHorizontal: null,
  irisVertical: null,
  irisHorizontal: null,
};

// Turn one FaceLandmarker result into a RawSample. Everything downstream
// works off this shape, so the MediaPipe types don't leak past here.
export function toRawSample(result: FaceLandmarkerResult, at: number): RawSample {
  const landmarks = result.faceLandmarks?.[0];

  if (!landmarks || landmarks.length === 0) return { ...ABSENT, at };

  const matrix = result.facialTransformationMatrixes?.[0];
  const pose = matrix ? eulerFromMatrix(matrix.data) : null;

  const categories = (result.faceBlendshapes?.[0]?.categories ?? []) as Category[];

  const leftIris = irisOffset(landmarks, LEFT_EYE, LEFT_IRIS_CENTRE);
  const rightIris = irisOffset(landmarks, RIGHT_EYE, RIGHT_IRIS_CENTRE);
  const irises = [leftIris, rightIris].filter((i): i is { x: number; y: number } => i !== null);

  return {
    at,
    facePresent: true,
    yaw: pose?.yaw ?? null,
    pitch: pose?.pitch ?? null,
    roll: pose?.roll ?? null,
    // Average both eyes throughout: one eye occluded by a head turn
    // shouldn't drag a two-eye signal on its own.
    blinkScore: scoreFor(categories, BLINK_CATEGORIES),
    ear: mean(
      [eyeAspectRatio(landmarks, LEFT_EYE), eyeAspectRatio(landmarks, RIGHT_EYE)].filter(
        (e): e is number => e !== null
      )
    ),
    gazeVertical: signedGaze(categories, GAZE_DOWN, GAZE_UP),
    gazeHorizontal: signedGaze(categories, GAZE_LEFTWARD, GAZE_RIGHTWARD),
    irisVertical: mean(irises.map((i) => i.y)),
    irisHorizontal: mean(irises.map((i) => i.x)),
  };
}
