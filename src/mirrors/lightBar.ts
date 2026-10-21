import * as THREE from 'three';

/**
 * What one mirror bar shows. Positions are fractions of the strip, 0 = inner end (towards the car).
 * - steer: rail + bar that follows the steering wheel + notch (target ± tolerance)
 * - count: segments that switch off one by one towards the point
 * - announce: dashed rail + notch, fading in (pre-announcement in the other mirror)
 */
export type BarView =
  | { kind: 'off' }
  | {
      kind: 'steer';
      fill: number;
      target: number | null; // null = no notch (autonomous)
      tol: number;
      inTarget: boolean;
      blinkStart: number | null; // confirmation blinks
    }
  | {
      kind: 'count';
      lit: number; // segments still on, 1 = only the last one
      total: number;
      reached: boolean; // last segment full + blinks
      blinkStart: number | null;
      overshoot: number; // 0..1, dashed blinking part past the point
    }
  | { kind: 'announce'; target: number; tol: number; alpha: number };

export interface BarStyle {
  color: string;
  brightness: number; // 0..1.5
  blinkCount: number;
  blinkOn: number; // s
  blinkOff: number; // s
}

export const DEFAULT_BAR_STYLE: BarStyle = { color: '#e3f1ff', brightness: 1, blinkCount: 2, blinkOn: 0.14, blinkOff: 0.11 };

const W = 1024;
const H = 64;
const X0 = 10;
const X1 = W - 10;
const OVER_BLINK_HZ = 3;

export class LightBar {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private lastKey = '';

  /** innerAtLeft: true when the strip's local -x end faces the car. */
  constructor(width: number, height: number, innerAtLeft: boolean, public style: BarStyle = DEFAULT_BAR_STYLE) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    if (!innerAtLeft) {
      this.texture.wrapS = THREE.RepeatWrapping;
      this.texture.repeat.x = -1;
      this.texture.offset.x = 1;
    }
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false }),
    );
    this.mesh.name = 'light-bar';
    this.draw({ kind: 'off' }, 0);
  }

  private blinkVisible(start: number | null, now: number) {
    if (start === null) return true;
    const { blinkCount, blinkOn, blinkOff } = this.style;
    const t = now - start;
    const period = blinkOn + blinkOff;
    if (t >= blinkCount * period || t < 0) return true;
    return t % period < blinkOn;
  }

  draw(v: BarView, now: number) {
    // Redraw only when something visible changes
    const blinking =
      (v.kind === 'steer' && (!this.blinkVisible(v.blinkStart, now) || v.fill > (v.target ?? 2) + v.tol)) ||
      (v.kind === 'count' && (v.blinkStart !== null || v.overshoot > 0));
    const key = JSON.stringify(v) + (blinking ? Math.floor(now * 20) : '') + this.style.color + this.style.brightness;
    if (key === this.lastKey) return;
    this.lastKey = key;

    const g = this.g;
    g.globalAlpha = 1;
    g.setLineDash([]);
    g.fillStyle = '#0b0d0f'; // unlit diffuser
    g.fillRect(0, 0, W, H);
    if (v.kind === 'off') return this.flush();

    const lit = this.litColor();
    const xAt = (f: number) => X0 + Math.max(0, Math.min(1, f)) * (X1 - X0);
    g.fillStyle = lit;
    g.strokeStyle = lit;

    if (v.kind === 'announce') {
      g.globalAlpha = v.alpha;
      g.lineWidth = 4;
      g.setLineDash([22, 14]);
      g.strokeRect(X0, 18, X1 - X0, 28); // rail
      g.strokeRect(xAt(v.target - v.tol), 4, xAt(v.target + v.tol) - xAt(v.target - v.tol), 56); // notch
      return this.flush();
    }

    if (v.kind === 'steer') {
      const showMain = this.blinkVisible(v.blinkStart, now);
      // Rail: outline of the full travel
      g.lineWidth = 3;
      g.strokeRect(X0, 18, X1 - X0, 28);
      const notchEnd = v.target === null ? Infinity : v.target + v.tol;
      // Bar up to the notch's far edge, solid
      if (showMain) g.fillRect(X0, 22, xAt(Math.min(v.fill, notchEnd)) - X0, 20);
      // Past the notch: dashed and blinking
      if (v.fill > notchEnd && Math.floor(now * OVER_BLINK_HZ * 2) % 2 === 0) {
        for (let x = xAt(notchEnd); x < xAt(v.fill); x += 26) g.fillRect(x + 4, 22, Math.min(14, xAt(v.fill) - x - 4), 20);
      }
      if (v.target !== null && showMain) {
        const a = xAt(v.target - v.tol);
        const b = xAt(v.target + v.tol);
        if (v.inTarget) {
          g.lineWidth = 9; // thicker notch
          g.strokeRect(a, 5, b - a, 54);
        } else {
          g.lineWidth = 4;
          g.strokeRect(a, 3, b - a, 58);
        }
      }
      return this.flush();
    }

    // count
    const n = v.total;
    const gap = 8;
    const cw = (X1 - X0 - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const x = X0 + i * (cw + gap);
      if (i === 0 && v.reached) {
        if (this.blinkVisible(v.blinkStart, now)) g.fillRect(x, 4, cw, 56); // last segment, full height
      } else if (i < v.lit) {
        g.fillRect(x, 18, cw, 28);
      }
    }
    if (v.overshoot > 0 && Math.floor(now * OVER_BLINK_HZ * 2) % 2 === 0) {
      // Past the point: dashed blinking stretch beyond the last segment, longer the further past
      const from = X0 + cw + gap;
      const to = from + v.overshoot * (X1 - from);
      for (let x = from; x < to; x += 26) g.fillRect(x, 22, Math.min(14, to - x), 20);
    }
    this.flush();
  }

  private litColor() {
    return new THREE.Color(this.style.color).multiplyScalar(this.style.brightness).getStyle();
  }

  private flush() {
    this.texture.needsUpdate = true;
  }
}
