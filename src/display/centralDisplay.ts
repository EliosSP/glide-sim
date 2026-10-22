import * as THREE from 'three';
import type { CameraGuide, DisplayModel } from '../modes/flow';
import { BarPainter } from '../mirrors/lightBar';
import type { RearCamera } from './rearCamera';
import type { ReconView } from './recon';

/** Text pinned to a point of the reconstruction (critical points of the autonomous preview). */
export interface ReconLabel {
  position: THREE.Vector3;
  text: string;
}

const W = 1024;
const H = 640;
// Viewport for the 3D reconstruction / rear camera, in canvas pixels
const VP = { x: 24, y: 76, w: 600, h: 540 };
const PANEL_X = 652;

const C = {
  bg: '#07090b',
  text: '#eef2f5',
  dim: '#8b96a0',
  faint: '#3a444c',
  line: '#1c2228',
  accent: '#7cc4ff',
  fits: '#2f7fd8',
  noFit: '#3b4149',
  card: '#10151a',
};
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Central touchscreen: canvas UI, plus a viewport plane (reconstruction or rear camera) and an overlay. */
export class CentralDisplay {
  private canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private texture: THREE.CanvasTexture;
  private viewport: THREE.Mesh;
  private overlayCanvas = document.createElement('canvas');
  private og: CanvasRenderingContext2D;
  private overlayTex: THREE.CanvasTexture;
  private overlay: THREE.Mesh;
  private barPainter = new BarPainter();
  private last = '';

  constructor(screen: THREE.Mesh) {
    this.canvas.width = W;
    this.canvas.height = H;
    this.g = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    screen.material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false });

    // Plane geometry of the screen gives metres per canvas pixel
    const p = (screen.geometry as THREE.PlaneGeometry).parameters;
    const k = p.width / W;
    const place = (m: THREE.Mesh, dz: number) => {
      m.position.set((VP.x + VP.w / 2 - W / 2) * k, -(VP.y + VP.h / 2 - H / 2) * k, dz);
      m.visible = false;
      screen.add(m);
    };
    this.viewport = new THREE.Mesh(new THREE.PlaneGeometry(VP.w * k, VP.h * k), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    place(this.viewport, 0.0006);

    this.overlayCanvas.width = VP.w;
    this.overlayCanvas.height = VP.h;
    this.og = this.overlayCanvas.getContext('2d')!;
    this.overlayTex = new THREE.CanvasTexture(this.overlayCanvas);
    this.overlayTex.colorSpace = THREE.SRGBColorSpace;
    this.overlay = new THREE.Mesh(
      new THREE.PlaneGeometry(VP.w * k, VP.h * k),
      new THREE.MeshBasicMaterial({ map: this.overlayTex, transparent: true, toneMapped: false }),
    );
    place(this.overlay, 0.0012);
  }

  /** Which picture the viewport needs this frame (so main renders only what is shown). */
  static viewportFor(m: DisplayModel): 'recon' | 'camera' | null {
    const s = m.screen;
    if (s.kind === 'approach' || s.kind === 'autoPreview' || s.kind === 'autoRunning' || s.kind === 'autoStopped') return 'recon';
    if (s.kind === 'inside' || (s.kind === 'assisted' && s.camera)) return 'camera';
    return null;
  }

  update(m: DisplayModel, now: number, reconView: ReconView, cam: RearCamera, guide: CameraGuide | null, labels: ReconLabel[] = []) {
    const recon = reconView.target.texture;
    const vp = CentralDisplay.viewportFor(m);
    this.viewport.visible = vp !== null;
    if (vp) {
      const mat = this.viewport.material as THREE.MeshBasicMaterial;
      const tex = vp === 'recon' ? recon : cam.target.texture;
      if (mat.map !== tex) {
        mat.map = tex;
        mat.color.setHex(0xffffff);
        mat.toneMapped = vp === 'camera'; // camera image is linear HDR, the reconstruction is already sRGB
        mat.needsUpdate = true;
      }
    }
    this.overlay.visible = vp === 'camera' || (vp === 'recon' && labels.length > 0);
    if (vp === 'camera') this.drawOverlay(cam, guide, now);
    else if (this.overlay.visible) this.drawLabels(reconView, labels);

    const blinkOn = Math.floor(now * 3) % 2 === 0;
    const key = JSON.stringify({ ...m, speedKmh: Math.round(m.speedKmh) }) + (m.blinker ? blinkOn : '');
    if (key === this.last) return;
    this.last = key;
    this.draw(m, blinkOn);
    this.texture.needsUpdate = true;
  }

  // ---------- canvas UI ----------

  private draw(m: DisplayModel, blinkOn: boolean) {
    const g = this.g;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.textBaseline = 'alphabetic';
    this.topBar(m, blinkOn);
    const s = m.screen;
    switch (s.kind) {
      case 'drive':
        this.text(String(Math.round(m.speedKmh)), 80, 330, 160, C.text, 600);
        this.text('km/h', 86, 390, 34, C.dim);
        break;
      case 'approach': {
        this.viewportFrame();
        let y = 130;
        if (s.evaluation) {
          const e = s.evaluation;
          y = this.wrap(e.title, PANEL_X, y, 46, C.text, 600, 340) + 50;
          y = this.wrap(e.line, PANEL_X, y, 28, C.dim, 400, 340) + 70;
        }
        this.wrap(s.hint, PANEL_X, Math.max(y, 300), 28, s.evaluation?.fits ? C.accent : C.dim, 500, 340);
        // Legend
        this.swatch(PANEL_X, 548, C.fits, 'Ci sta');
        this.swatch(PANEL_X + 150, 548, C.noFit, 'Non ci sta');
        break;
      }
      case 'choose':
        this.chooseScreen(s.recommended, s.reason);
        break;
      case 'assisted':
        if (s.camera) {
          this.viewportFrame();
          this.wrap(s.title, PANEL_X, 140, 46, C.text, 600, 340);
          this.wrap(s.line, PANEL_X, 200, 28, C.dim, 400, 340);
          if (s.mirror) this.mirrorIcon(PANEL_X + 4, 330, s.mirror, 0.8);
        } else {
          this.centred(s.title, 250, 58, C.text, 600);
          this.centred(s.line, 310, 32, C.dim, 400);
          if (s.mirror) this.mirrorIcon(W / 2 - 60, 380, s.mirror, 1);
        }
        break;
      case 'inside':
        this.viewportFrame();
        this.wrap('Dentro lo spazio', PANEL_X, 140, 40, C.text, 600, 340);
        this.wrap(s.line, PANEL_X, 190, 28, C.dim, 400, 340);
        this.sensors(PANEL_X + 90, 250, s.front, s.rear);
        break;
      case 'autoPreview': {
        this.viewportFrame();
        let y = this.wrap(s.title, PANEL_X, 130, 42, C.text, 600, 340) + 52;
        y = this.wrap('Io sterzo, accelero e freno.', PANEL_X, y, 26, C.text, 400, 340) + 34;
        y = this.wrap('Tu sorvegli: puoi fermarmi con volante o freno.', PANEL_X, y, 26, C.text, 400, 340) + 46;
        this.text(`Durata stimata ${Math.round(s.seconds)} s`, PANEL_X, y, 24, C.dim, 500);
        if (s.countdown !== null) {
          this.text(`Riparto tra ${s.countdown} s`, PANEL_X, 540, 30, C.accent, 600);
        } else {
          this.button(PANEL_X, 470, 340, 'Avvia', 'Invio', true);
          this.button(PANEL_X, 548, 340, "Passa all'assistito", 'A', false);
        }
        break;
      }
      case 'autoRunning':
        this.viewportFrame();
        this.wrap('Sto parcheggiando', PANEL_X, 140, 42, C.text, 600, 340);
        this.wrap('Frena o gira il volante per fermarmi', PANEL_X, 250, 28, C.dim, 400, 340);
        break;
      case 'autoStopped': {
        this.viewportFrame();
        let y = this.wrap(s.title, PANEL_X, 130, 38, C.text, 600, 340) + 44;
        y = this.wrap(s.line, PANEL_X, y, 25, C.dim, 400, 340);
        const top = Math.max(y + 30, H - 40 - s.options.length * 74);
        s.options.forEach((o, i) => this.button(PANEL_X, top + i * 74, 340, o.label, o.key, i === 0));
        break;
      }
      case 'done':
        this.check(W / 2, 210);
        this.centred(s.title, 340, 50, C.text, 600);
        s.lines.forEach((l, i) => this.centred(l, 400 + i * 46, 32, C.dim, 400));
        break;
    }
    if (m.toast) {
      g.font = `500 28px ${FONT}`;
      const tw = g.measureText(m.toast).width + 48;
      g.fillStyle = '#1d252d';
      this.roundRect((W - tw) / 2, H - 92, tw, 60, 30);
      g.fill();
      this.centred(m.toast, H - 52, 28, C.text, 500);
    }
  }

  private topBar(m: DisplayModel, blinkOn: boolean) {
    const g = this.g;
    ['P', 'R', 'D'].forEach((x, i) => this.text(x, 30 + i * 40, 48, 30, x === m.gear ? C.text : C.faint, 600));
    if (m.screen.kind !== 'drive') this.text(`${Math.round(m.speedKmh)} km/h`, 170, 48, 28, C.dim, 500);
    // Turn indicators
    for (const side of ['left', 'right'] as const) {
      const on = m.blinker === side && blinkOn;
      const x = side === 'left' ? W / 2 - 60 : W / 2 + 60;
      const d = side === 'left' ? -1 : 1;
      g.fillStyle = on ? '#57d68d' : C.faint;
      g.beginPath();
      g.moveTo(x + d * 22, 36);
      g.lineTo(x - d * 4, 18);
      g.lineTo(x - d * 4, 54);
      g.closePath();
      g.fill();
    }
    this.text('Glide', W - 110, 48, 28, C.dim, 600);
    g.fillStyle = C.line;
    g.fillRect(0, 66, W, 2);
  }

  private chooseScreen(rec: 'auto' | 'assisted', reason: string) {
    this.centred('Come vuoi parcheggiare?', 130, 40, C.text, 600);
    this.centred(`Consiglio ${rec === 'auto' ? 'Autonomo' : 'Assistito'} · ${reason}`, 180, 26, C.dim, 400);
    const cards = [
      { mode: 'auto', key: '2', name: 'Autonomo', glide: 'Sterzo, accelero e freno', you: 'Sorvegli: puoi fermarmi con volante o freno' },
      { mode: 'assisted', key: '1', name: 'Assistito', glide: 'Ti mostro negli specchietti quando e quanto sterzare', you: 'Sterzi, acceleri e freni' },
    ];
    // Recommended card first
    cards.sort((a) => (a.mode === rec ? -1 : 1));
    cards.forEach((c, i) => {
      const x = 40 + i * 482;
      const y = 214;
      const w = 462;
      const h = 380;
      const isRec = c.mode === rec;
      this.g.fillStyle = isRec ? '#16202a' : C.card;
      this.roundRect(x, y, w, h, 22);
      this.g.fill();
      if (isRec) {
        this.g.strokeStyle = C.text;
        this.g.lineWidth = 4;
        this.roundRect(x, y, w, h, 22);
        this.g.stroke();
        this.text('Consigliato', x + 30, y + 46, 22, C.accent, 600);
      }
      this.text(c.name, x + 30, y + 100, 42, C.text, 600);
      this.text('Glide', x + 30, y + 160, 22, C.dim, 600);
      let yy = this.wrap(c.glide, x + 30, y + 196, 27, C.text, 400, w - 60);
      this.text('Tu', x + 30, yy + 34, 22, C.dim, 600);
      this.wrap(c.you, x + 30, yy + 70, 27, C.text, 400, w - 60);
      this.text(`[${c.key}]`, x + w - 70, y + h - 26, 22, C.faint, 600);
    });
  }

  /** Touch button on the display; the key that simulates the touch is shown on the right. */
  private button(x: number, y: number, w: number, label: string, key: string, primary: boolean) {
    const g = this.g;
    const h = 60;
    if (primary) {
      g.fillStyle = C.text;
      this.roundRect(x, y, w, h, 14);
      g.fill();
    } else {
      g.strokeStyle = C.dim;
      g.lineWidth = 3;
      this.roundRect(x, y, w, h, 14);
      g.stroke();
    }
    g.font = `600 25px ${FONT}`;
    g.fillStyle = primary ? C.bg : C.text;
    g.fillText(label, x + 20, y + 39);
    g.font = `500 18px ${FONT}`;
    g.fillStyle = primary ? '#4a5560' : C.faint;
    const kw = g.measureText(key).width;
    g.fillText(key, x + w - 18 - kw, y + 38);
  }

  private drawLabels(recon: ReconView, labels: ReconLabel[]) {
    const g = this.og;
    g.clearRect(0, 0, VP.w, VP.h);
    g.font = `600 22px ${FONT}`;
    // Pills above their points, pushed apart so they never overlap
    const placed: { x: number; y: number; w: number; q: [number, number]; text: string }[] = [];
    for (const l of labels) {
      const q = recon.project(l.position, VP.w, VP.h);
      if (!q) continue;
      const w = g.measureText(l.text).width + 24;
      const x = Math.min(VP.w - w - 6, Math.max(6, q[0] - w / 2));
      let y = Math.max(6, q[1] - 70);
      for (const p of placed) {
        const overlapX = x < p.x + p.w && p.x < x + w;
        if (overlapX && Math.abs(y - p.y) < 42) y = p.y - 44 >= 6 ? p.y - 44 : p.y + 44;
      }
      placed.push({ x, y, w, q, text: l.text });
    }
    for (const p of placed) {
      g.strokeStyle = 'rgba(255,255,255,0.7)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(p.q[0], p.q[1] - 8);
      g.lineTo(Math.min(p.x + p.w - 10, Math.max(p.x + 10, p.q[0])), p.y + 36);
      g.stroke();
      g.fillStyle = 'rgba(10,14,18,0.9)';
      g.beginPath();
      g.roundRect(p.x, p.y, p.w, 36, 18);
      g.fill();
      g.fillStyle = '#eef2f5';
      g.fillText(p.text, p.x + 12, p.y + 26);
    }
    this.overlayTex.needsUpdate = true;
  }

  private viewportFrame() {
    const g = this.g;
    g.fillStyle = '#000';
    this.roundRect(VP.x - 2, VP.y - 2, VP.w + 4, VP.h + 4, 14);
    g.fill();
  }

  private mirrorIcon(x: number, y: number, side: 'left' | 'right', scale: number) {
    const g = this.g;
    g.save();
    g.translate(x, y);
    g.scale(scale, scale);
    g.fillStyle = '#1d252d';
    this.roundRect(0, 0, 120, 70, 18);
    g.fill();
    g.fillStyle = C.text;
    g.fillRect(14, 12, 92, 8); // the bar
    g.fillStyle = C.dim;
    g.font = `500 22px ${FONT}`;
    g.fillText(side === 'right' ? 'destro' : 'sinistro', 130, 46);
    g.restore();
  }

  private sensors(cx: number, top: number, front: number, rear: number) {
    const g = this.g;
    // Car outline, top view, front up
    g.strokeStyle = C.dim;
    g.lineWidth = 3;
    this.roundRect(cx - 34, top + 70, 68, 150, 18);
    g.stroke();
    const arc = (y: number, d: number, up: boolean) => {
      const near = Math.min(1, Math.max(0, 1 - d / 1.5));
      const n = Math.ceil(near * 4);
      for (let i = 0; i < 4; i++) {
        g.strokeStyle = i < n ? C.text : C.faint;
        g.lineWidth = 6;
        g.beginPath();
        const r = 30 + (3 - i) * 12;
        g.arc(cx, y, r, up ? Math.PI * 1.2 : Math.PI * 0.2, up ? Math.PI * 1.8 : Math.PI * 0.8);
        g.stroke();
      }
    };
    arc(top + 62, front, true);
    arc(top + 228, rear, false);
    const fmt = (d: number) => (d > 1.5 ? '—' : `${Math.round(d * 100)} cm`);
    this.text(fmt(front), cx + 90, top + 40, 28, C.text, 500);
    this.text(fmt(rear), cx + 90, top + 290, 28, C.text, 500);
  }

  private check(cx: number, cy: number) {
    const g = this.g;
    g.strokeStyle = C.text;
    g.lineWidth = 8;
    g.beginPath();
    g.arc(cx, cy, 56, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(cx - 24, cy + 2);
    g.lineTo(cx - 6, cy + 20);
    g.lineTo(cx + 26, cy - 16);
    g.stroke();
  }

  private swatch(x: number, y: number, color: string, label: string) {
    this.g.fillStyle = color;
    this.roundRect(x, y - 22, 30, 26, 6);
    this.g.fill();
    this.text(label, x + 40, y, 22, C.dim, 500);
  }

  private text(t: string, x: number, y: number, size: number, color: string, weight = 400) {
    this.g.font = `${weight} ${size}px ${FONT}`;
    this.g.fillStyle = color;
    this.g.fillText(t, x, y);
  }

  private centred(t: string, y: number, size: number, color: string, weight = 400) {
    this.g.font = `${weight} ${size}px ${FONT}`;
    this.g.fillStyle = color;
    this.g.fillText(t, (W - this.g.measureText(t).width) / 2, y);
  }

  /** Word-wrapped text; returns the baseline of the last line. */
  private wrap(t: string, x: number, y: number, size: number, color: string, weight: number, maxW: number) {
    const g = this.g;
    g.font = `${weight} ${size}px ${FONT}`;
    g.fillStyle = color;
    let line = '';
    for (const word of t.split(' ')) {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > maxW && line) {
        g.fillText(line, x, y);
        y += size * 1.25;
        line = word;
      } else {
        line = test;
      }
    }
    g.fillText(line, x, y);
    return y;
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const g = this.g;
    g.beginPath();
    g.roundRect(x, y, w, h, r);
  }

  // ---------- rear camera overlay: same targets as the mirrors ----------

  private drawOverlay(cam: RearCamera, guide: CameraGuide | null, now: number) {
    const g = this.og;
    g.clearRect(0, 0, VP.w, VP.h);
    if (guide) {
      const line = (pts: THREE.Vector3[]) => {
        g.beginPath();
        let started = false;
        for (const p of pts) {
          const q = cam.project(p, VP.w, VP.h);
          if (!q) continue;
          started ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]);
          started = true;
        }
        g.stroke();
      };
      g.strokeStyle = 'rgba(227,241,255,0.85)';
      g.lineWidth = 5;
      line(guide.left);
      line(guide.right);
      if (guide.target) {
        g.lineWidth = 9;
        g.strokeStyle = '#e3f1ff';
        line(guide.target);
      }
      // Same bar as in the mirror, at the bottom of the image
      this.barPainter.paint(guide.bar, now);
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillRect(40, VP.h - 70, VP.w - 80, 46);
      // Drawn as the driver sees that mirror: zero end towards the car
      g.save();
      if (guide.side === 'left') {
        g.translate(VP.w, 0);
        g.scale(-1, 1);
      }
      g.drawImage(this.barPainter.canvas, 50, VP.h - 64, VP.w - 100, 34);
      g.restore();
    }
    this.overlayTex.needsUpdate = true;
  }
}
