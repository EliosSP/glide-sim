import type { HeadTracker } from './headTracker';

const W = 200;
const H = 150;

/** Dead zone drawn on the preview (degrees of head yaw). */
export interface PreviewMarks {
  deadZone: number;
}

/**
 * Small webcam preview (mirrored, like a selfie) with the head angles and the dead zone.
 * Shown only on request or during calibration, never in test mode. Frames are drawn and discarded.
 */
export class TrackingPreview {
  private box = document.createElement('div');
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private dot = document.createElement('div');

  constructor() {
    this.box.className = 'head-preview hidden';
    this.canvas.width = W;
    this.canvas.height = H + 64;
    this.g = this.canvas.getContext('2d')!;
    this.box.append(this.canvas);
    this.dot.className = 'head-dot hidden';
    document.body.append(this.box, this.dot);
  }

  /** Full preview, or (test mode) only a dot: green when tracked, grey otherwise. */
  draw(t: HeadTracker, mode: 'full' | 'dot' | 'none', marks: PreviewMarks, message: string | null) {
    this.box.classList.toggle('hidden', mode !== 'full');
    this.dot.classList.toggle('hidden', mode !== 'dot' || t.status === 'off');
    this.dot.classList.toggle('on', t.status === 'tracking');
    if (mode !== 'full') return;

    const g = this.g;
    g.fillStyle = '#0d1014';
    g.fillRect(0, 0, W, H + 64);
    const v = t.video;
    if (v && v.readyState >= 2) {
      g.save();
      g.translate(W, 0);
      g.scale(-1, 1);
      g.drawImage(v, 0, 0, W, H);
      g.restore();
    }

    // Yaw scale −30…+30°: dead zone and current value
    const y0 = H + 14;
    const x = (deg: number) => W / 2 + (Math.max(-30, Math.min(30, deg)) / 30) * (W / 2 - 8);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.fillRect(x(-marks.deadZone), y0 - 6, x(marks.deadZone) - x(-marks.deadZone), 12);
    g.setLineDash([]);
    g.fillStyle = t.status === 'tracking' ? '#6fe08a' : '#9aa3ab';
    g.beginPath();
    g.arc(x(t.yaw), y0, 4, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#e8eef2';
    g.font = '11px ui-monospace, Menlo, monospace';
    g.fillText(`yaw ${fmt(t.yaw)}°  pitch ${fmt(t.pitch)}°`, 6, H + 36);
    g.fillText(message ?? statusText(t), 6, H + 54);
  }
}

function fmt(v: number) {
  return (v >= 0 ? '+' : '') + v.toFixed(1);
}

function statusText(t: HeadTracker) {
  switch (t.status) {
    case 'starting': return 'Avvio webcam…';
    case 'calibrating': return `Guarda dritto davanti a te… ${(t.calibrationLeft / 1000).toFixed(1)} s`;
    case 'tracking': return 'Tracciamento attivo';
    case 'lost': return 'Volto non visibile';
    case 'error': return t.error;
    default: return 'Spento';
  }
}
