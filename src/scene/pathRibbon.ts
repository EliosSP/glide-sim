import * as THREE from 'three';
import { DEBUG_LAYER } from '../views/cameras';
import type { AutoRun } from '../modes/autonomous';
import { VEHICLE } from '../config';

const MAX_POINTS = 700;
const WIDTH = 0.5;
const FADE = 5; // 1/s

/**
 * Video, outside view: the stretch the car is about to drive (the next drive step of the autonomous
 * timeline, from where it is now), as a blue ribbon on the asphalt, traced by the bumper that leads. Seen only by the outside cameras.
 * Each new stretch is drawn anew; the ribbon is eaten away as the car drives it.
 */
export class PathRibbon {
  private pos = new Float32Array(MAX_POINTS * 6 * 3);
  private geo = new THREE.BufferGeometry();
  private mesh: THREE.Mesh;
  private mat = new THREE.MeshBasicMaterial({ color: 0x4aa3ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 });
  private opacity = 0;
  private stretch = -1;
  private point = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.layers.set(DEBUG_LAYER);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(run: AutoRun | null, show: boolean, dt: number) {
    let n = 0;
    let stretch = -1;
    if (run && show) {
      const tl = run.timeline;
      stretch = tl.steps.findIndex((s) => s.kind === 'drive' && s.t0 + s.dur > run.t);
      if (stretch >= 0) {
        const st = tl.steps[stretch];
        if (st.kind === 'drive') {
          // The path of the bumper that leads (front going forward, rear going backward): it stays visible beyond the car
          const lead = st.dir > 0 ? VEHICLE.wheelbase + VEHICLE.frontOverhang : -VEHICLE.rearOverhang;
          const from = Math.max(run.t, st.t0);
          const to = st.t0 + st.dur;
          let prev: THREE.Vector3 | null = null;
          for (let t = from; t <= to + 1e-6 && n < MAX_POINTS - 1; t += 0.1) {
            const p = tl.sample(Math.min(t, to)).pose;
            const q = this.point.set(p.x + Math.cos(p.heading) * lead, 0, p.z + Math.sin(p.heading) * lead).clone();
            if (prev) n = this.segment(n, prev, q);
            prev = q;
          }
        }
      }
    }
    if (stretch !== this.stretch) {
      this.stretch = stretch;
      this.opacity = Math.min(this.opacity, 0.1); // a new stretch is drawn anew
    }
    this.opacity += ((n > 0 ? 1 : 0) - this.opacity) * Math.min(1, dt * FADE);
    this.mat.opacity = 0.85 * this.opacity;
    this.mesh.visible = this.opacity > 0.01;
    this.geo.setDrawRange(0, n * 6);
    this.geo.attributes.position.needsUpdate = true;
  }

  /** Quad along a → b on the ground; returns the next segment index. */
  private segment(i: number, a: THREE.Vector3, b: THREE.Vector3) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    const nx = (-dz / l) * (WIDTH / 2);
    const nz = (dx / l) * (WIDTH / 2);
    const y = 0.07;
    const v = [a.x + nx, y, a.z + nz, a.x - nx, y, a.z - nz, b.x + nx, y, b.z + nz, b.x + nx, y, b.z + nz, a.x - nx, y, a.z - nz, b.x - nx, y, b.z - nz];
    this.pos.set(v, i * 18);
    return i + 1;
  }
}

/**
 * Translucent blue fill over a mirror, for the outside view (same blue as the path ribbon): lit when that mirror's
 * light is lit. Seen only by the outside cameras.
 */
export class MirrorGlows {
  private sprites: Record<'left' | 'right', THREE.Sprite>;
  private level = { left: 0, right: 0 };

  constructor(mirrors: Record<'left' | 'right', THREE.Object3D>) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 160;
    const g = c.getContext('2d')!;
    // Rounded fill with a firmer edge and a soft halo
    g.shadowColor = 'rgba(74,163,255,0.9)';
    g.shadowBlur = 22;
    g.fillStyle = 'rgba(74,163,255,0.5)';
    g.strokeStyle = 'rgba(74,163,255,0.95)';
    g.lineWidth = 5;
    g.beginPath();
    g.roundRect(30, 30, 196, 100, 34);
    g.fill();
    g.stroke();
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    const make = (m: THREE.Object3D) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
      s.scale.set(0.62, 0.39, 1);
      s.position.set(-0.06, 0, 0);
      s.layers.set(DEBUG_LAYER);
      s.renderOrder = 6;
      m.add(s);
      return s;
    };
    this.sprites = { left: make(mirrors.left), right: make(mirrors.right) };
  }

  /** brightness: 0..1 per mirror (its light). */
  update(brightness: { left: number; right: number }, dt: number) {
    for (const side of ['left', 'right'] as const) {
      this.level[side] += (brightness[side] - this.level[side]) * Math.min(1, dt * 8);
      this.sprites[side].material.opacity = this.level[side];
      this.sprites[side].visible = this.level[side] > 0.01;
    }
  }
}
