import type { HeadTracker } from './headTracker';

const DONE_SHOWN = 1500; // ms

/** Guided calibration: look straight ahead; that pose becomes zero. */
export class CalibrationGuide {
  private step: 'idle' | 'center' | 'done' = 'idle';
  private since = 0;

  constructor(private tracker: HeadTracker) {}

  get active() {
    return this.step !== 'idle';
  }

  start() {
    this.tracker.calibrate();
    this.step = 'center';
  }

  cancel() {
    this.step = 'idle';
  }

  /** Once per frame; returns the message to show (null: nothing). */
  update(now = performance.now()): string | null {
    const t = this.tracker;
    if (this.step === 'center') {
      if (t.status === 'tracking') {
        this.step = 'done';
        this.since = now;
      }
      return t.status === 'calibrating' ? `Guarda dritto davanti a te… ${(t.calibrationLeft / 1000).toFixed(1)} s` : 'Cerco il tuo volto…';
    }
    if (this.step === 'done') {
      if (now - this.since > DONE_SHOWN) this.step = 'idle';
      return 'Calibrazione completata';
    }
    return null;
  }
}
