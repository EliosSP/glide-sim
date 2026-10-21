import type { DriveInput } from './kinematics';

const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'F1']);

/** Keyboard state for driving + edge-triggered commands. */
export class Keyboard {
  private down = new Set<string>();
  private handlers = new Map<string, () => void>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.handlers.get(e.code)?.();
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  on(code: string, fn: () => void) {
    this.handlers.set(code, fn);
  }

  drive(): DriveInput {
    return {
      throttle: this.down.has('ArrowUp'),
      brake: this.down.has('ArrowDown'),
      hardBrake: this.down.has('Space'),
      steerLeft: this.down.has('ArrowLeft'),
      steerRight: this.down.has('ArrowRight'),
    };
  }
}
