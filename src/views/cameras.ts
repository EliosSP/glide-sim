import * as THREE from 'three';
import { ROAD, VEHICLE } from '../config';
import type { CarRig } from '../vehicle/carModel';

export type ViewName = 'driver' | 'chase' | 'top';
/** Layer for debug drawings: seen only by the outside cameras, never by the driver, the mirrors or the rear camera. */
export const DEBUG_LAYER = 1;
export const VIEW_LABELS: Record<ViewName, string> = { driver: 'Posto guida', chase: 'Esterna', top: 'Dall\'alto' };
const ORDER: ViewName[] = ['driver', 'chase', 'top'];

export const DRIVER_FOV = 78; // vertical, wider than default so both A-pillars and the display fit
const GLANCE_FOV = 30; // looking at a mirror narrows the view, like focusing on it (a monitor has far less resolution than the eye)
const DISPLAY_FOV = 24; // demo close-up of the central display
const HEAD_SPEED = 9; // 1/s, head-turn smoothing
export type Glance = 'left' | 'right' | 'rear' | 'display' | null; // 'display': used by the demo

const _m = new THREE.Vector3();

export class Views {
  readonly driver = new THREE.PerspectiveCamera(DRIVER_FOV, 1, 0.03, 600);
  readonly chase = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
  readonly top = new THREE.PerspectiveCamera(40, 1, 0.5, 300);
  current: ViewName = 'driver';
  split = false;

  /** Held glance key: the head turns towards that mirror. */
  glance: Glance = null;
  /** Demo: narrower field while glancing (zoom on a mirror), and outside close-up of a mirror in the chase view. */
  glanceZoom: number | null = null;
  closeUp: 'left' | 'right' | null = null;

  private head = new THREE.Object3D();
  // Mouse-controlled head direction, and the smoothed direction actually shown
  private yaw = 0;
  private pitch = -0.12;
  private curYaw = 0;
  private curPitch = -0.12;
  private glanceAngles: Record<NonNullable<Glance>, { yaw: number; pitch: number }>;
  private chasePos = new THREE.Vector3();
  private chaseInit = false;

  constructor(private rig: CarRig, dom: HTMLElement) {
    // Driver camera rides on the car: head at the eye point, camera turned to look along +X
    this.head.position.set(VEHICLE.eye.x, VEHICLE.eye.y, VEHICLE.eye.z);
    this.head.add(this.driver);
    this.driver.rotation.order = 'YXZ';
    rig.root.add(this.head);

    // Head angles that centre each mirror (car body frame; the body has no rotation of its own)
    const angles = (g: THREE.Object3D) => {
      const d = g.position.clone().sub(this.head.position);
      return { yaw: Math.atan2(-d.z, d.x), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
    };
    this.glanceAngles = {
      left: angles(rig.mirrors.left),
      right: angles(rig.mirrors.right),
      rear: rig.rearMirror ? angles(rig.rearMirror) : { yaw: -0.6, pitch: 0.1 },
      display: rig.displayMesh?.parent ? angles(rig.displayMesh.parent) : { yaw: -0.5, pitch: -0.2 },
    };

    this.top.up.set(0, 0, -1); // driving direction points right on screen, curb at the bottom
    this.chase.layers.enable(DEBUG_LAYER);
    this.top.layers.enable(DEBUG_LAYER);

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
    });
    dom.addEventListener('dblclick', () => {
      this.yaw = 0;
      this.pitch = -0.12;
    });
  }

  private updateHead(dt: number) {
    const target = this.glance ? this.glanceAngles[this.glance] : { yaw: this.yaw, pitch: this.pitch };
    const a = 1 - Math.exp(-dt * HEAD_SPEED);
    this.curYaw += (target.yaw - this.curYaw) * a;
    this.curPitch += (target.pitch - this.curPitch) * a;
    this.driver.rotation.set(this.curPitch, -Math.PI / 2 + this.curYaw, 0);
    const fov = this.glance && this.glanceZoom ? this.glanceZoom : this.glance === 'display' ? DISPLAY_FOV : this.glance ? GLANCE_FOV : DRIVER_FOV;
    if (Math.abs(this.driver.fov - fov) > 0.01) {
      this.driver.fov += (fov - this.driver.fov) * a;
      this.driver.updateProjectionMatrix();
    }
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
    this.updateHead(dt);
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
    if (this.closeUp) {
      // Behind the mirror and a little outside it: what the car behind or a cyclist sees
      const side = this.closeUp === 'left' ? -1 : 1;
      const m = this.rig.mirrors[this.closeUp].getWorldPosition(_m);
      this.chase.position.set(m.x - c * 1.0 - s * side * 0.3, m.y + 0.1, m.z - s * 1.0 + c * side * 0.3);
      this.chase.lookAt(m.x, m.y - 0.04, m.z);
    }
    const chaseFov = this.closeUp ? 28 : 55;
    if (this.chase.fov !== chaseFov) {
      this.chase.fov = chaseFov;
      this.chase.updateProjectionMatrix();
    }

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
