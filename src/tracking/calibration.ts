import type { HeadTracker } from './headTracker';
import type { MappingParams, MirrorGlance } from './headMapping';

type Step = 'idle' | 'center' | 'left' | 'right' | 'suggest' | 'done';

const STEP_TIMEOUT = 6000; // ms to snap onto a mirror before suggesting a lower threshold
const DONE_SHOWN = 1500; // ms

/**
 * Guided calibration: straight ahead (zero), then turn to the left and to the right mirror to check
 * that the snaps happen. If one does not, suggest a lower threshold from the turn actually reached.
 */
export class CalibrationGuide {
  step: Step = 'idle';
  private since = 0;
  private maxYaw = 0;
  private suggestion: { side: 'left' | 'right'; snapIn: number } | null = null;

  constructor(
    private tracker: HeadTracker,
    private params: MappingParams,
  ) {}

  get active() {
    return this.step !== 'idle';
  }

  start() {
    this.tracker.calibrate();
    this.go('center', performance.now());
  }

  cancel() {
    this.step = 'idle';
  }

  /** Y: accept the suggested threshold and try that side again. */
  acceptSuggestion() {
    if (this.step !== 'suggest' || !this.suggestion) return false;
    const gap = this.params.snapIn - this.params.snapOut;
    this.params.snapIn = this.suggestion.snapIn;
    this.params.snapOut = Math.max(2, this.suggestion.snapIn - gap);
    this.go(this.suggestion.side, performance.now());
    return true;
  }

  /** Once per frame; returns the message to show (null: nothing). */
  update(glance: MirrorGlance | null, now = performance.now()): string | null {
    const t = this.tracker;
    switch (this.step) {
      case 'idle':
        return null;
      case 'center':
        if (t.status === 'tracking') this.go('left', now);
        return t.status === 'calibrating' ? `Guarda dritto davanti a te… ${(t.calibrationLeft / 1000).toFixed(1)} s` : 'Cerco il tuo volto…';
      case 'left':
      case 'right': {
        const side = this.step;
        this.maxYaw = Math.max(this.maxYaw, side === 'left' ? -t.yaw : t.yaw);
        if (glance === side) {
          this.go(side === 'left' ? 'right' : 'done', now);
          return null;
        }
        if (now - this.since > STEP_TIMEOUT) {
          const snapIn = Math.max(6, Math.floor(this.maxYaw * 0.85));
          if (snapIn < this.params.snapIn) {
            this.suggestion = { side, snapIn };
            this.go('suggest', now);
          } else {
            this.go(side, now); // the turn was wide enough: just try again
          }
          return null;
        }
        return `Gira la testa verso lo specchietto ${side === 'left' ? 'sinistro' : 'destro'}…`;
      }
      case 'suggest': {
        const s = this.suggestion!;
        if (now - this.since > STEP_TIMEOUT * 2) {
          this.go('done', now);
          return null;
        }
        return `Lo specchietto ${s.side === 'left' ? 'sinistro' : 'destro'} non è scattato (hai girato fino a ${Math.round(this.maxYaw)}°). ` +
          `Premi Y per abbassare la soglia da ${this.params.snapIn}° a ${s.snapIn}°.`;
      }
      case 'done':
        if (now - this.since > DONE_SHOWN) this.step = 'idle';
        return 'Calibrazione completata';
    }
  }

  private go(step: Step, now: number) {
    this.step = step;
    this.since = now;
    this.maxYaw = 0;
  }
}
