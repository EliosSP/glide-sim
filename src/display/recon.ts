import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ROAD, VEHICLE } from '../config';
import type { FreeSpace, ParkedCar } from '../scene/parkingLayout';
import type { Pose } from '../planner/geometry';
import type { ReconInfo } from '../modes/flow';
import type { AutoTimeline } from '../modes/autonomous';
import type { ActorMarker } from '../actors/actors';

export type SpaceLook = 'fits' | 'noFit' | 'chosen' | 'chosenNoFit';

const COLORS: Record<SpaceLook, number> = {
  fits: 0x2f7fd8,
  noFit: 0x3b4149,
  chosen: 0x7cc4ff,
  chosenNoFit: 0x6b737c,
};

/**
 * Tesla-style reconstruction for the central display: a separate, stylised scene
 * (grey cars, coloured free spaces) rendered to a texture from behind and above the car.
 */
export class ReconView {
  readonly target: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private ego: THREE.Mesh;
  private spaceMeshes = new Map<string, { mesh: THREE.Mesh; outline: THREE.LineSegments }>();
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private camInit = false;

  // Autonomous preview: trajectory ribbon (consumed as the car drives it), fastest stretch, critical points, ghost
  private previewGroup = new THREE.Group();
  private ribbon: THREE.Mesh;
  private fastRibbon: THREE.Mesh;
  private rings: THREE.Mesh[] = [];
  private ghost: THREE.Mesh;
  private shownPreview: ReconInfo['preview'] | null = null;
  private objects = new Map<string, THREE.Object3D>();
  private actors = new Map<string, THREE.Mesh>();
  private actorGeo = {
    car: new RoundedBoxGeometry(VEHICLE.length, 1.35, VEHICLE.width, 3, 0.35),
    bike: new RoundedBoxGeometry(1.7, 1.4, 0.5, 2, 0.2),
    person: new THREE.CylinderGeometry(0.25, 0.25, 1.7, 12),
  };
  private actorMat = {
    car: new THREE.MeshStandardMaterial({ color: 0x8c949d, roughness: 0.6 }),
    // Vulnerable road users stand out
    bike: new THREE.MeshStandardMaterial({ color: 0xe8c547, roughness: 0.6 }),
    person: new THREE.MeshStandardMaterial({ color: 0xe8c547, roughness: 0.6 }),
  };

  constructor(cars: ParkedCar[], opposite: ParkedCar[], spaces: FreeSpace[], width: number, height: number) {
    this.target = new THREE.WebGLRenderTarget(width, height, { samples: 4 });
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 200);
    this.scene.background = new THREE.Color(0x0d1014);
    this.scene.fog = new THREE.Fog(0x0d1014, 30, 60);
    this.scene.add(new THREE.HemisphereLight(0xdfe8f0, 0x20252b, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-10, 20, 8);
    this.scene.add(key);

    // Road, lane lines, curbs
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD.length, ROAD.curbZ * 2),
      new THREE.MeshBasicMaterial({ color: 0x171b20 }),
    );
    road.rotation.x = -Math.PI / 2;
    this.scene.add(road);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x4a525c });
    for (const z of [-ROAD.curbZ, -ROAD.laneWidth, 0, ROAD.laneWidth, ROAD.curbZ]) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-ROAD.length / 2, 0.01, z),
        new THREE.Vector3(ROAD.length / 2, 0.01, z),
      ]);
      this.scene.add(new THREE.Line(g, lineMat));
    }

    // Parked cars: rounded grey blocks
    const carMat = new THREE.MeshStandardMaterial({ color: 0x8c949d, roughness: 0.6 });
    for (const c of [...cars, ...opposite]) {
      const m = new THREE.Mesh(new RoundedBoxGeometry(c.length, 1.35, 1.75, 3, 0.35), carMat);
      m.position.set(c.x, 0.68, c.z);
      this.scene.add(m);
    }

    // Free spaces
    for (const s of spaces) {
      const len = s.xEnd - s.xStart;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(len - 0.3, 1.9),
        new THREE.MeshBasicMaterial({ color: COLORS.noFit, transparent: true, opacity: 0.85 }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((s.xStart + s.xEnd) / 2, 0.02, ROAD.curbZ - 1.05);
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.PlaneGeometry(len - 0.3, 1.9)),
        new THREE.LineBasicMaterial({ color: 0xffffff }),
      );
      outline.rotation.copy(mesh.rotation);
      outline.position.copy(mesh.position).setY(0.03);
      outline.visible = false;
      this.scene.add(mesh, outline);
      this.spaceMeshes.set(s.id, { mesh, outline });
    }

    // Ego car: white
    this.ego = new THREE.Mesh(
      new RoundedBoxGeometry(VEHICLE.length, 1.45, VEHICLE.width, 3, 0.35),
      new THREE.MeshStandardMaterial({ color: 0xf2f5f7, roughness: 0.4 }),
    );
    this.scene.add(this.ego);

    const ribbonMat = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), ribbonMat(0x7cc4ff, 0.55));
    this.fastRibbon = new THREE.Mesh(new THREE.BufferGeometry(), ribbonMat(0xffffff, 0.9));
    this.ribbon.renderOrder = 1;
    this.fastRibbon.renderOrder = 2;
    this.ghost = new THREE.Mesh(
      new RoundedBoxGeometry(VEHICLE.length, 1.45, VEHICLE.width, 3, 0.35),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.previewGroup.add(this.ribbon, this.fastRibbon, this.ghost);
    this.previewGroup.visible = false;
    this.scene.add(this.previewGroup);
  }

  /** Small object on the road (e.g. the obstacle of scenario I3). */
  setObject(id: string, pos: { x: number; z: number } | null) {
    const old = this.objects.get(id);
    if (old) this.scene.remove(old);
    this.objects.delete(id);
    if (!pos) return;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 1.0, 20), new THREE.MeshStandardMaterial({ color: 0xc9d1d9 }));
    m.position.set(pos.x, 0.5, pos.z);
    this.scene.add(m);
    this.objects.set(id, m);
  }

  /** Moving actors (other cars, cyclist, pedestrians), updated every frame. */
  syncActors(markers: ActorMarker[]) {
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      let mesh = this.actors.get(m.id);
      if (!mesh) {
        mesh = new THREE.Mesh(this.actorGeo[m.kind], this.actorMat[m.kind]);
        this.scene.add(mesh);
        this.actors.set(m.id, mesh);
      }
      mesh.position.set(m.x, m.kind === 'person' ? 1.0 : 0.7, m.z);
      mesh.rotation.y = -m.heading;
    }
    for (const [id, mesh] of this.actors) {
      if (seen.has(id)) continue;
      this.scene.remove(mesh);
      this.actors.delete(id);
    }
  }

  /** World point → pixel in the rendered image (for labels drawn on top). */
  project(p: THREE.Vector3, w: number, h: number): [number, number] | null {
    const v = p.clone().project(this.camera);
    if (v.z < -1 || v.z > 1) return null;
    return [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
  }

  private buildRibbon(mesh: THREE.Mesh, pts: THREE.Vector3[], width: number, y: number) {
    const pos: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      const nx = (-dz / l) * (width / 2);
      const nz = (dx / l) * (width / 2);
      pos.push(a.x + nx, y, a.z + nz, a.x - nx, y, a.z - nz, b.x + nx, y, b.z + nz);
      pos.push(b.x + nx, y, b.z + nz, a.x - nx, y, a.z - nz, b.x - nx, y, b.z - nz);
    }
    mesh.geometry.dispose();
    mesh.geometry = new THREE.BufferGeometry();
    mesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }

  private showPreview(info: ReconInfo | null, timeline: AutoTimeline | null) {
    this.previewGroup.visible = !!info;
    if (!info) {
      this.shownPreview = null;
      return;
    }
    const p = info.preview;
    if (p !== this.shownPreview) {
      this.shownPreview = p;
      this.buildRibbon(this.ribbon, p.path, 0.8, 0.04);
      const fastPts = p.fast ? p.path.filter((_, i) => p.pathTimes[i] >= p.fast!.from && p.pathTimes[i] <= p.fast!.to) : [];
      this.buildRibbon(this.fastRibbon, fastPts, 1.0, 0.05);
      for (const r of this.rings) this.previewGroup.remove(r);
      this.rings = p.points.map((cp) => {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.32, 0.46, 32),
          new THREE.MeshBasicMaterial({ color: cp.kind === 'sensor' ? 0xff6b6b : cp.kind === 'fast' ? 0xffffff : 0xffb454, side: THREE.DoubleSide, depthTest: false }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.copy(cp.position).setY(0.08);
        ring.renderOrder = 3;
        this.previewGroup.add(ring);
        return ring;
      });
    }
    // The trajectory is "consumed" as the car drives it
    const consumed = p.pathTimes.findIndex((t) => t >= info.progressT);
    this.ribbon.geometry.setDrawRange(Math.max(0, consumed) * 6, Infinity);
    this.ghost.visible = info.ghostT !== null && !!timeline;
    if (this.ghost.visible && timeline) {
      const g = timeline.sample(info.ghostT!).pose;
      const c = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
      this.ghost.position.set(g.x + Math.cos(g.heading) * c, 0.74, g.z + Math.sin(g.heading) * c);
      this.ghost.rotation.y = -g.heading;
    }
  }

  setSpaceLook(id: string, look: SpaceLook) {
    const s = this.spaceMeshes.get(id);
    if (!s) return;
    (s.mesh.material as THREE.MeshBasicMaterial).color.setHex(COLORS[look]);
    s.outline.visible = look === 'chosen' || look === 'chosenNoFit';
  }

  render(renderer: THREE.WebGLRenderer, pose: Pose, dt: number, auto: ReconInfo | null = null, timeline: AutoTimeline | null = null) {
    this.showPreview(auto, timeline);
    const c = Math.cos(pose.heading);
    const s = Math.sin(pose.heading);
    const centre = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
    const cx = pose.x + c * centre;
    const cz = pose.z + s * centre;
    this.ego.position.set(cx, 0.72, cz);
    this.ego.rotation.y = -pose.heading;

    // Approach: behind and above, following along the street only (calmer than following the heading).
    // Autonomous: higher overview centred on the whole trajectory.
    let target: THREE.Vector3;
    let look: THREE.Vector3;
    if (auto) {
      // Frame the whole trajectory: nearly top-down, height from its length
      const xs = auto.preview.path.map((v) => v.x);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      const span = Math.max(10, Math.max(...xs) - Math.min(...xs) + 6);
      const h = span * 1.25;
      target = new THREE.Vector3(mid - 1.5, h, ROAD.curbZ - 2.2 - h * 0.28);
      look = new THREE.Vector3(mid, 0, ROAD.curbZ - 2.2);
    } else {
      target = new THREE.Vector3(cx - 9, 12, cz - 3.5);
      look = new THREE.Vector3(cx, 0, ROAD.curbZ - 2.6);
    }
    if (!this.camInit) {
      this.camPos.copy(target);
      this.camTarget.copy(look);
      this.camInit = true;
    }
    const a = 1 - Math.exp(-dt * 3);
    this.camPos.lerp(target, a);
    this.camTarget.lerp(look, a);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

    const prev = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    renderer.toneMapping = prevTone;
  }
}
