import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { poseFromMatrix } from './headPose';

/** One head-pose measurement, raw (not calibrated). Degrees: yaw > 0 head turned right, pitch > 0 up. */
export interface HeadSample {
  yaw: number;
  pitch: number;
  roll: number;
  t: number; // ms, performance.now() at capture
}

/** Where head poses come from: the webcam, or a script (tests, fixed-step mode). */
export interface HeadSource {
  start(): Promise<void>;
  stop(): void;
  /** Latest sample, or null when no face has been seen since the last call. */
  take(): HeadSample | null;
  /** Video element for the preview (webcam only). Frames are never stored or sent anywhere. */
  readonly video: HTMLVideoElement | null;
}

const DETECT_HZ = 30;

/**
 * Webcam + MediaPipe Face Landmarker, all local: model and WASM from public/mediapipe/,
 * detection at a fixed rate on the main thread (independent of the render loop).
 */
export class WebcamHeadSource implements HeadSource {
  video: HTMLVideoElement | null = null;
  /** Average time of one detection (ms) and detections per second, for the latency estimate. */
  stats = { detectMs: 0, rate: 0 };
  private count = 0;
  private countSince = 0;
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private timer: number | null = null;
  private latest: HeadSample | null = null;
  private lastVideoTime = -1;

  async start() {
    const base = import.meta.env.BASE_URL;
    const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe/wasm`);
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}mediapipe/face_landmarker.task`, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
      outputFaceBlendshapes: false,
    });
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.srcObject = this.stream;
    await v.play();
    this.video = v;
    this.timer = window.setInterval(() => this.detect(), 1000 / DETECT_HZ);
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.latest = null;
  }

  take() {
    const s = this.latest;
    this.latest = null;
    return s;
  }

  private detect() {
    const v = this.video;
    if (!v || !this.landmarker || v.readyState < 2 || v.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = v.currentTime;
    const now = performance.now();
    const res = this.landmarker.detectForVideo(v, now);
    const took = performance.now() - now;
    this.stats.detectMs = this.stats.detectMs ? this.stats.detectMs * 0.9 + took * 0.1 : took;
    this.count++;
    if (now - this.countSince >= 1000) {
      this.stats.rate = (this.count * 1000) / (now - this.countSince);
      this.count = 0;
      this.countSince = now;
    }
    const m = res.facialTransformationMatrixes?.[0];
    if (m) this.latest = { ...poseFromMatrix(m.data), t: now };
  }
}

/** Scripted head motion (tests, fixed-step mode): angles as a function of time. */
export class ScriptedHeadSource implements HeadSource {
  readonly video = null;
  private t0 = 0;
  private running = false;

  constructor(
    private script: (tSeconds: number) => { yaw: number; pitch: number } | null,
    private clock: () => number = () => performance.now(),
  ) {}

  async start() {
    this.t0 = this.clock();
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  take(): HeadSample | null {
    if (!this.running) return null;
    const now = this.clock();
    const a = this.script((now - this.t0) / 1000);
    return a ? { yaw: a.yaw, pitch: a.pitch, roll: 0, t: now } : null;
  }
}
