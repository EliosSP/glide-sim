import * as THREE from 'three';
import { VEHICLE } from '../config';
import type { CarRig } from '../vehicle/carModel';

/** Rear-view camera on the tailgate, rendered to a texture (shown mirrored, as in real cars). */
export class RearCamera {
  readonly camera: THREE.PerspectiveCamera;
  readonly target: THREE.WebGLRenderTarget;

  constructor(rig: CarRig, width: number, height: number) {
    this.camera = new THREE.PerspectiveCamera(88, width / height, 0.05, 120);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(-0.55, Math.PI / 2, 0); // looking backwards, tilted down
    this.camera.position.set(-VEHICLE.rearOverhang - 0.02, 0.95, 0);
    rig.root.add(this.camera);
    this.target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 2 });
    const t = this.target.texture;
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = -1;
    t.offset.x = 1;
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(prev);
  }

  /** World point → overlay pixel (mirrored like the image), or null if behind the camera. */
  project(p: THREE.Vector3, w: number, h: number): [number, number] | null {
    const v = p.clone().project(this.camera);
    if (v.z < -1 || v.z > 1) return null;
    return [(1 - (v.x + 1) / 2) * w, (1 - (v.y + 1) / 2) * h];
  }
}
