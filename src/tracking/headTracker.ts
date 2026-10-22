import { OneEuro } from './oneEuro';
import type { HeadSample, HeadSource } from './headSource';

export type TrackStatus = 'off' | 'starting' | 'calibrating' | 'tracking' | 'lost' | 'error';

export interface TrackerSettings {
  minCutoff: number; // One Euro, Hz
  beta: number;
  invertYaw: boolean; // safety net if a camera reports the opposite sign
  invertPitch: boolean;
}

// From the first driving test: a bit more reactive than the classic 1.0 / 0.02
export const DEFAULT_TRACKER: TrackerSettings = { minCutoff: 1.2, beta: 0.18, invertYaw: false, invertPitch: false };

const LOST_AFTER = 500; // ms without a face
const CALIBRATION = 1500; // ms looking straight ahead

/**
 * Head pose for the driver view: calibrated (straight ahead = 0), smoothed, with its status.
 * Angles in degrees, yaw > 0 head turned right, pitch > 0 head up.
 */
export class HeadTracker {
  status: TrackStatus = 'off';
  yaw = 0;
  pitch = 0;
  roll = 0;
  confidence = 0; // 1 while the face is seen, falls to 0 when lost
  lastSeen = 0; // ms
  error = '';
  /** Remaining calibration time (ms), for the on-screen countdown. */
  calibrationLeft = 0;
  onStatus: (s: TrackStatus, prev: TrackStatus) => void = () => {};

  private zero = { yaw: 0, pitch: 0, roll: 0 };
  private calib: HeadSample[] = [];
  private calibUntil = 0;
  private fYaw: OneEuro;
  private fPitch: OneEuro;
  private source: HeadSource | null = null;

  constructor(public settings: TrackerSettings = { ...DEFAULT_TRACKER }) {
    this.fYaw = new OneEuro(settings.minCutoff, settings.beta);
    this.fPitch = new OneEuro(settings.minCutoff, settings.beta);
  }

  get video() {
    return this.source?.video ?? null;
  }

  get active() {
    return this.status !== 'off' && this.status !== 'error';
  }

  async start(source: HeadSource) {
    this.stop();
    this.source = source;
    this.error = '';
    this.setStatus('starting');
    try {
      await source.start();
      if (this.source !== source) return; // stopped meanwhile
      this.calibrate();
    } catch (e) {
      source.stop();
      this.source = null;
      this.error = describeError(e);
      this.setStatus('error');
    }
  }

  stop() {
    this.source?.stop();
    this.source = null;
    if (this.status !== 'error') this.setStatus('off');
    this.yaw = this.pitch = this.roll = 0;
    this.confidence = 0;
  }

  /** Straight ahead for CALIBRATION ms: the mean pose becomes zero. */
  calibrate() {
    if (!this.source) return;
    this.calib = [];
    this.calibUntil = performance.now() + CALIBRATION;
    this.setStatus('calibrating');
  }

  /** Once per frame. */
  update(now = performance.now()) {
    if (!this.source) return;
    this.fYaw.minCutoff = this.fPitch.minCutoff = this.settings.minCutoff;
    this.fYaw.beta = this.fPitch.beta = this.settings.beta;
    const s = this.source.take();
    if (s) {
      const yaw = this.settings.invertYaw ? -s.yaw : s.yaw;
      const pitch = this.settings.invertPitch ? -s.pitch : s.pitch;
      this.lastSeen = s.t;
      this.confidence = 1;
      if (this.status === 'calibrating') {
        this.calib.push({ ...s, yaw, pitch });
      } else {
        this.yaw = this.fYaw.filter(yaw - this.zero.yaw, s.t / 1000);
        this.pitch = this.fPitch.filter(pitch - this.zero.pitch, s.t / 1000);
        this.roll = s.roll - this.zero.roll;
        if (this.status === 'lost' || this.status === 'starting') this.setStatus('tracking');
      }
    }
    if (this.status === 'calibrating') {
      this.calibrationLeft = Math.max(0, this.calibUntil - now);
      if (now >= this.calibUntil) {
        if (this.calib.length >= 5) {
          const mean = (k: 'yaw' | 'pitch' | 'roll') => this.calib.reduce((a, c) => a + c[k], 0) / this.calib.length;
          this.zero = { yaw: mean('yaw'), pitch: mean('pitch'), roll: mean('roll') };
          this.fYaw.reset();
          this.fPitch.reset();
          this.setStatus('tracking');
        } else {
          // No face during calibration: try again
          this.calibrate();
        }
      }
      return;
    }
    if (this.status === 'tracking' && now - this.lastSeen > LOST_AFTER) this.setStatus('lost');
    if (this.status === 'lost') {
      // Face not seen: the view drifts slowly back to the centre
      const k = Math.exp(-(1 / 60) * 2);
      this.yaw *= k;
      this.pitch *= k;
      this.confidence = 0;
    }
  }

  private setStatus(s: TrackStatus) {
    if (s === this.status) return;
    const prev = this.status;
    this.status = s;
    this.onStatus(s, prev);
  }
}

function describeError(e: unknown) {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Permesso della webcam negato';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Nessuna webcam trovata';
  if (name === 'NotReadableError') return 'Webcam occupata da un\'altra applicazione';
  return `Tracciamento non disponibile (${(e as Error)?.message ?? e})`;
}
