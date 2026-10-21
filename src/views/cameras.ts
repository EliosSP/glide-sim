import * as THREE from 'three';
import { ROAD, VEHICLE } from '../config';
import type { CarRig } from '../vehicle/carModel';

export type ViewName = 'driver' | 'chase' | 'top';
export const VIEW_LABELS: Record<ViewName, string> = { driver: 'Posto guida', chase: 'Esterna', top: 'Dall\'alto' };
const ORDER: ViewName[] = ['driver', 'chase', 'top'];

export class Views {
  readonly driver = new THREE.PerspectiveCamera(70, 1, 0.03, 600);
  readonly chase = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
  readonly top = new THREE.PerspectiveCamera(40, 1, 0.5, 300);
  current: ViewName = 'driver';
  split = false;

  private head = new THREE.Object3D();
  private yaw = 0;
  private pitch = -0.12;
  private chasePos = new THREE.Vector3();
  private chaseInit = false;

  constructor(rig: CarRig, dom: HTMLElement) {
    // Driver camera rides on the car: head at the eye point, camera turned to look along +X
    this.head.position.set(VEHICLE.eye.x, VEHICLE.eye.y, VEHICLE.eye.z);
    this.head.add(this.driver);
    this.driver.rotation.order = 'YXZ';
    rig.root.add(this.head);
    this.applyHead();

    this.top.up.set(0, 0, -1); // driving direction points right on screen, curb at the bottom

    let dragging = false;
    dom.addEventListener('pointerdown', (e) => {
      dragging = true;
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointerup', () => (dragging = false));
    dom.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.yaw = THREE.MathUtils.clamp(this.yaw - e.movementX * 0.004, -2.6, 2.6);
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.004, -1.0, 0.8);
      this.applyHead();
    });
    dom.addEventListener('dblclick', () => {
      this.yaw = 0;
      this.pitch = -0.12;
      this.applyHead();
    });
  }

  private applyHead() {
    this.driver.rotation.set(this.pitch, -Math.PI / 2 + this.yaw, 0);
  }

  cycle() {
    this.current = ORDER[(ORDER.indexOf(this.current) + 1) % ORDER.length];
  }

  get active() {
    return this[this.current];
  }

  resetChase() {
    this.chaseInit = false;
  }

  update(x: number, z: number, heading: number, dt: number) {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const cx = x + c * 1.35; // car centre
    const cz = z + s * 1.35;

    // Chase: behind and above, smoothed
    // Stay between the building fronts even when the car is turned across the street
    const maxZ = ROAD.curbZ + ROAD.sidewalkWidth - 0.6;
    const target = new THREE.Vector3(cx - c * 7.5, 3.6, THREE.MathUtils.clamp(cz - s * 7.5, -maxZ, maxZ));
    if (!this.chaseInit) {
      this.chasePos.copy(target);
      this.chaseInit = true;
    }
    this.chasePos.lerp(target, 1 - Math.exp(-dt * 4));
    this.chase.position.copy(this.chasePos);
    this.chase.lookAt(cx + c * 3, 0.8, cz + s * 3);

    // Top: straight above, following along the street
    this.top.position.set(cx, 26, cz + 0.5);
    this.top.lookAt(cx, 0, cz + 0.5);
  }

  setAspect(name: ViewName, aspect: number) {
    const cam = this[name];
    if (cam.aspect !== aspect) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
  }
}
