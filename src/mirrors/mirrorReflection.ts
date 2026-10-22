import * as THREE from 'three';

const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();
const _pc = new THREE.Vector3();
const _m = new THREE.Vector3();
const _n = new THREE.Vector3();
const _e = new THREE.Vector3();
const _vr = new THREE.Vector3();
const _vu = new THREE.Vector3();
const _vn = new THREE.Vector3();
const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _vc = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/**
 * Real reflection on a mirror glass: a secondary camera at the eye mirrored across the glass plane,
 * with an off-axis frustum fitted to the glass rectangle (generalised perspective projection).
 * `convex` < 1 pulls the virtual eye towards the glass, widening the field like a convex mirror.
 */
export class MirrorReflection {
  readonly camera = new THREE.PerspectiveCamera();
  readonly target: THREE.WebGLRenderTarget;
  private w: number;
  private h: number;

  /** Objects hidden while rendering the reflection (the mirror housings themselves). */
  hide: THREE.Object3D[] = [];

  /** corner: radius of the glass corners as a fraction of its height (0 = square). */
  constructor(readonly glass: THREE.Mesh, public convex = 1, resolution = 512, corner = 0) {
    const p = (glass.geometry as THREE.PlaneGeometry).parameters;
    this.w = p.width;
    this.h = p.height;
    this.target = new THREE.WebGLRenderTarget(resolution, Math.round((resolution * this.h) / this.w), {
      type: THREE.HalfFloatType,
      samples: 4,
      // Mipmaps: no shimmering when the mirror is small on screen
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    const tex = this.target.texture;
    tex.anisotropy = 8;
    // Seen from the virtual eye the glass is viewed from behind: flip horizontally
    tex.repeat.x = -1;
    tex.offset.x = 1;
    tex.wrapS = THREE.RepeatWrapping;
    glass.material = new THREE.MeshBasicMaterial({ map: tex, color: 0xd6d9dc });
    if (corner > 0) {
      const m = glass.material as THREE.MeshBasicMaterial;
      m.alphaMap = roundedMask(this.w / this.h, corner);
      m.alphaTest = 0.5;
    }
  }

  setResolution(resolution: number) {
    this.target.setSize(resolution, Math.round((resolution * this.h) / this.w));
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, eye: THREE.Vector3) {
    const g = this.glass;
    g.updateWorldMatrix(true, false);
    const mw = g.matrixWorld;
    // Corners as seen from behind the glass: lower-left, lower-right, upper-left
    _pa.set(this.w / 2, -this.h / 2, 0).applyMatrix4(mw);
    _pb.set(-this.w / 2, -this.h / 2, 0).applyMatrix4(mw);
    _pc.set(this.w / 2, this.h / 2, 0).applyMatrix4(mw);
    _m.setFromMatrixPosition(mw);
    _n.set(0, 0, 1).transformDirection(mw);

    // Eye in front of the glass only; otherwise there is nothing to reflect
    const side = _e.copy(eye).sub(_m).dot(_n);
    if (side <= 0.01) return;
    // Virtual eye: mirrored across the plane, then pulled towards it for convex glass
    _e.copy(eye).addScaledVector(_n, -2 * side).sub(_m).multiplyScalar(this.convex).add(_m);

    _vr.subVectors(_pb, _pa).normalize();
    _vu.subVectors(_pc, _pa).normalize();
    _vn.crossVectors(_vr, _vu).normalize();
    _va.subVectors(_pa, _e);
    _vb.subVectors(_pb, _e);
    _vc.subVectors(_pc, _e);
    const d = -_va.dot(_vn);
    if (d <= 1e-4) return;
    const near = d; // near plane on the glass: everything behind it (housing, door) is clipped
    const far = 400;

    const cam = this.camera;
    cam.position.copy(_e);
    _basis.makeBasis(_vr, _vu, _vn);
    cam.quaternion.setFromRotationMatrix(_basis);
    cam.updateMatrixWorld(true);
    cam.projectionMatrix.makePerspective(_vr.dot(_va), _vr.dot(_vb), _vu.dot(_vc), _vu.dot(_va), near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();

    const hidden = [g, ...this.hide];
    for (const o of hidden) o.visible = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    for (const o of hidden) o.visible = true;
  }
}

/** White rounded rectangle on black, used as alpha mask for the glass corners. */
function roundedMask(aspect: number, corner: number) {
  const h = 128;
  const w = Math.round(h * aspect);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.beginPath();
  g.roundRect(0, 0, w, h, corner * h);
  g.fill();
  return new THREE.CanvasTexture(c);
}

/**
 * Aims a mirror so that, from the driver's eye, it looks backwards along the car's flank.
 * The housing takes the yaw (so the glass sits flush in it), the glass keeps the residual pitch.
 * Vectors are in the car body frame.
 */
export function aimMirror(group: THREE.Object3D, glass: THREE.Object3D, eye: THREE.Vector3, viewDir: THREE.Vector3) {
  const m = group.position.clone().add(glass.position);
  const toEye = eye.clone().sub(m).normalize();
  const n = toEye.add(viewDir.clone().normalize()).normalize();
  // Housing back face is local -X: rotate it towards the horizontal part of n
  group.rotation.y = Math.atan2(n.z, -n.x);
  const nLocal = n.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -group.rotation.y);
  const x = new THREE.Vector3(0, 1, 0).cross(nLocal).normalize();
  const y = nLocal.clone().cross(x);
  glass.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, nLocal));
}
