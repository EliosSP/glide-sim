import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ROAD, VEHICLE } from '../config';
import type { FreeSpace, ParkedCar } from '../scene/parkingLayout';
import type { Pose } from '../planner/geometry';

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
  private camInit = false;

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
  }

  setSpaceLook(id: string, look: SpaceLook) {
    const s = this.spaceMeshes.get(id);
    if (!s) return;
    (s.mesh.material as THREE.MeshBasicMaterial).color.setHex(COLORS[look]);
    s.outline.visible = look === 'chosen' || look === 'chosenNoFit';
  }

  render(renderer: THREE.WebGLRenderer, pose: Pose, dt: number) {
    const c = Math.cos(pose.heading);
    const s = Math.sin(pose.heading);
    const centre = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
    const cx = pose.x + c * centre;
    const cz = pose.z + s * centre;
    this.ego.position.set(cx, 0.72, cz);
    this.ego.rotation.y = -pose.heading;

    // Behind and above, following along the street only (calmer than following the heading)
    const target = new THREE.Vector3(cx - 9, 12, cz - 3.5);
    if (!this.camInit) {
      this.camPos.copy(target);
      this.camInit = true;
    }
    this.camPos.lerp(target, 1 - Math.exp(-dt * 3));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camPos.x + 9, 0, ROAD.curbZ - 2.6);

    const prev = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    renderer.toneMapping = prevTone;
  }
}
