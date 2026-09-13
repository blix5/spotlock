import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { toRawSample } from "./signals";
import type { RawSample } from "./types";

// Both asset paths are served from public/ rather than a CDN: a personal
// tool that breaks when a CDN is unreachable is worse than a slightly
// larger repo, and this keeps working offline. The wasm/ files are copied
// from node_modules/@mediapipe/tasks-vision/wasm; the .task model has to be
// downloaded once (see README / docs/cv-plan.md).
const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/models/face_landmarker.task";

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

export function loadDetector(): Promise<FaceLandmarker> {
  // Memoised: the model is several MB and initialising twice in StrictMode's
  // double-effect would download and compile it twice.
  landmarkerPromise ??= (async () => {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATH, delegate: "GPU" },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  })();

  return landmarkerPromise;
}

/**
 * Run one inference pass. `timestampMs` must increase monotonically across
 * calls - MediaPipe's VIDEO mode rejects out-of-order timestamps, which is
 * why this takes performance.now() rather than deriving it internally.
 */
export function sample(
  landmarker: FaceLandmarker,
  video: HTMLVideoElement,
  timestampMs: number,
  at: number
): RawSample {
  const result = landmarker.detectForVideo(video, timestampMs);
  return toRawSample(result, at);
}
