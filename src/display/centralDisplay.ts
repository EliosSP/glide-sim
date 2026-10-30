import * as THREE from 'three';
import type { CameraGuide, DisplayModel } from '../modes/flow';
import { BarPainter } from '../mirrors/lightBar';
import type { RearCamera } from './rearCamera';
import type { ReconView } from './recon';

const W = 1024;
const H = 640;
// Viewports in canvas pixels: the reconstruction is wide with a button strip under it; the rear camera has a panel on its right
const VP_RECON = { x: 24, y: 76, w: 976, h: 400 };
const VP_CAM = { x: 24, y: 76, w: 600, h: 540 };
const PANEL_X = 652;
const STRIP_Y = 492; // under the wide reconstruction
type Rect = { x: number; y: number; w: number; h: number };

/** A viewport plane (the 3D picture) and the overlay plane drawn over it. */
interface Layer {
  vp: Rect;
  viewport: THREE.Mesh;
  overlay: THREE.Mesh;
  g: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
}

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
  private recon: Layer;
  private cam: Layer;
  private barPainter = new BarPainter();
  private last = '';

  private screenMesh: THREE.Mesh;
  private k = 0; // metres per canvas pixel

  constructor(screen: THREE.Mesh) {
    this.screenMesh = screen;
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
    this.k = k;
    const layer = (vp: Rect, toneMapped: boolean): Layer => {
      const place = (m: THREE.Mesh, dz: number) => {
        m.position.set((vp.x + vp.w / 2 - W / 2) * k, -(vp.y + vp.h / 2 - H / 2) * k, dz);
        m.visible = false;
        screen.add(m);
      };
      const viewport = new THREE.Mesh(new THREE.PlaneGeometry(vp.w * k, vp.h * k), new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped }));
      place(viewport, 0.0006);
      const c = document.createElement('canvas');
      c.width = vp.w;
      c.height = vp.h;
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const overlay = new THREE.Mesh(
        new THREE.PlaneGeometry(vp.w * k, vp.h * k),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
      );
      place(overlay, 0.0012);
      return { vp, viewport, overlay, g: c.getContext('2d')!, tex };
    };
    // The camera image is linear HDR, the reconstruction is already sRGB
    this.recon = layer(VP_RECON, false);
    this.cam = layer(VP_CAM, true);
  }

  /** World position of a canvas pixel of the display (for the video bubbles). */
  canvasToWorld(px: number, py: number, out: THREE.Vector3) {
    this.screenMesh.updateWorldMatrix(true, false);
    return this.screenMesh.localToWorld(out.set((px - W / 2) * this.k, -(py - H / 2) * this.k, 0));
  }

  /** World position, on the display, of a point of the map (null when it is not on the map). */
  mapToWorld(recon: ReconView, p: THREE.Vector3, out: THREE.Vector3) {
    const vp = this.recon.vp;
    const q = recon.project(p, vp.w, vp.h);
    return q ? this.canvasToWorld(vp.x + q[0], vp.y + q[1], out) : null;
  }

  /** Centre of the Start button of the preview, in canvas pixels. */
  static readonly START_BUTTON = { x: 442, y: STRIP_Y + 42 };

  /** Which picture the viewport needs this frame (so main renders only what is shown). */
  static viewportFor(m: DisplayModel): 'recon' | 'camera' | null {
    const s = m.screen;
    if (s.kind === 'approach' || s.kind === 'autoPreview' || s.kind === 'autoRunning' || s.kind === 'autoStopped') return 'recon';
    if (s.kind === 'inside' || (s.kind === 'assisted' && s.camera)) return 'camera';
    return null;
  }

  /** Video: label of the touch button shown as pressed (a finger tap on the display). */
  pressed: string | null = null;
  /** Video: a tap on this point of the map (the free space being chosen), drawn as an expanding ring. */
  tapWorld: THREE.Vector3 | null = null;

  update(m: DisplayModel, now: number, reconView: ReconView, cam: RearCamera, guide: CameraGuide | null) {
    const vp = CentralDisplay.viewportFor(m);
    for (const l of [this.recon, this.cam]) {
      const mat = l.viewport.material as THREE.MeshBasicMaterial;
      const tex = l === this.recon ? reconView.target.texture : cam.target.texture;
      if (mat.map !== tex) {
        mat.map = tex;
        mat.color.setHex(0xffffff);
        mat.needsUpdate = true;
      }
    }
    this.recon.viewport.visible = vp === 'recon';
    this.cam.viewport.visible = vp === 'camera';
    this.recon.overlay.visible = vp === 'recon' && this.tapWorld !== null;
    this.cam.overlay.visible = vp === 'camera';
    if (vp === 'camera') this.drawOverlay(cam, guide, now);
    else if (this.recon.overlay.visible) this.drawTap(reconView, now);

    const blinkOn = Math.floor(now * 3) % 2 === 0;
    const key = JSON.stringify({ ...m, speedKmh: Math.round(m.speedKmh) }) + (m.blinker ? blinkOn : '') + (this.pressed ?? '');
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
      case 'approach':
        this.viewportFrame(VP_RECON);
        this.centred(s.selected ? 'Press P to park' : 'Tap a free space', STRIP_Y + 58, 30, s.selected ? C.accent : C.dim, 500);
        break;
      case 'assisted':
        if (s.camera) {
          this.viewportFrame(VP_CAM);
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
        this.viewportFrame(VP_CAM);
        this.wrap('Inside the space', PANEL_X, 140, 40, C.text, 600, 340);
        this.wrap(s.line, PANEL_X, 190, 28, C.dim, 400, 340);
        this.sensors(PANEL_X + 90, 250, s.front, s.rear);
        break;
      case 'autoPreview':
        this.viewportFrame(VP_RECON);
        if (s.countdown !== null) {
          this.centred(`${s.title} · resuming in ${s.countdown} s`, STRIP_Y + 58, 30, C.accent, 600);
        } else {
          // Start, and a small cross to cancel (same as pressing P again)
          this.button(232, STRIP_Y + 12, 420, 'Start', 'Enter', true);
          this.crossButton(672, STRIP_Y + 12);
        }
        break;
      case 'autoRunning':
        this.viewportFrame(VP_RECON);
        this.centred('Parking · brake or turn the wheel to stop', STRIP_Y + 58, 28, C.dim, 500);
        break;
      case 'autoStopped': {
        this.viewportFrame(VP_RECON);
        this.text(s.title, 40, STRIP_Y + 34, 30, C.text, 600);
        this.text(s.line, 40, STRIP_Y + 66, 22, C.dim, 400);
        const bw = (W - 48 - 16 * (s.options.length - 1)) / s.options.length;
        s.options.forEach((o, i) => this.button(24 + i * (bw + 16), STRIP_Y + 84, bw, o.label, o.key, i === 0, 46, 21));
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

  private button(x: number, y: number, w: number, label: string, key: string, primary: boolean, h = 60, size = 25) {
    const g = this.g;
    const tapped = this.pressed === label;
    if (tapped) {
      g.fillStyle = C.accent;
      this.roundRect(x - 6, y - 6, w + 12, h + 12, 18);
      g.fill();
    }
    if (primary) {
      g.fillStyle = tapped ? C.accent : C.text;
      this.roundRect(x, y, w, h, 14);
      g.fill();
    } else {
      g.strokeStyle = C.dim;
      g.lineWidth = 3;
      this.roundRect(x, y, w, h, 14);
      g.stroke();
    }
    g.font = `600 ${size}px ${FONT}`;
    g.fillStyle = primary ? C.bg : C.text;
    g.fillText(label, x + 20, y + h / 2 + size * 0.36);
    g.font = `500 ${Math.round(size * 0.72)}px ${FONT}`;
    g.fillStyle = primary ? '#4a5560' : C.faint;
    const kw = g.measureText(key).width;
    g.fillText(key, x + w - 18 - kw, y + h / 2 + size * 0.3);
  }

  /** Small square cancel button, "×". */
  private crossButton(x: number, y: number) {
    const g = this.g;
    g.strokeStyle = C.dim;
    g.lineWidth = 3;
    this.roundRect(x, y, 60, 60, 14);
    g.stroke();
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(x + 20, y + 20);
    g.lineTo(x + 40, y + 40);
    g.moveTo(x + 40, y + 20);
    g.lineTo(x + 20, y + 40);
    g.stroke();
  }

  /** Video: ring expanding on the point being tapped. */
  private drawTap(recon: ReconView, now: number) {
    const { g, vp, tex } = this.recon;
    g.clearRect(0, 0, vp.w, vp.h);
    const q = this.tapWorld && recon.project(this.tapWorld, vp.w, vp.h);
    if (q) {
      const t = (now % 0.9) / 0.9;
      g.strokeStyle = `rgba(255,255,255,${1 - t})`;
      g.lineWidth = 5;
      g.beginPath();
      g.arc(q[0], q[1], 14 + 46 * t, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath();
      g.arc(q[0], q[1], 9, 0, Math.PI * 2);
      g.fill();
    }
    tex.needsUpdate = true;
  }

  private viewportFrame(vp: Rect) {
    const g = this.g;
    g.fillStyle = '#000';
    this.roundRect(vp.x - 2, vp.y - 2, vp.w + 4, vp.h + 4, 14);
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
    const { g, vp: VP, tex } = this.cam;
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
    tex.needsUpdate = true;
  }
}
