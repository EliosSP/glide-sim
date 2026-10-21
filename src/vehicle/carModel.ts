import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { VEHICLE } from '../config';

// Side profile of the lower body (x forward from rear axle, y up), with wheel arches.
const ARCH_R = 0.4;
const ARCH_CY = 0.32;
function bodyProfile(): THREE.Vector2[] {
  const p: [number, number][] = [[-0.7, 0.3], [-0.62, 0.26], [-0.4, 0.26]];
  const arch = (cx: number) => {
    for (let i = 0; i <= 12; i++) {
      const a = Math.PI - (i / 12) * Math.PI;
      p.push([cx + ARCH_R * Math.cos(a), ARCH_CY + ARCH_R * Math.sin(a)]);
    }
  };
  arch(0);
  p.push([0.4, 0.26], [VEHICLE.wheelbase - 0.4, 0.26]);
  arch(VEHICLE.wheelbase);
  p.push(
    [3.0, 0.26], [3.3, 0.3], [3.42, 0.45], [3.4, 0.62], [3.25, 0.76],
    [2.5, 0.9], [1.85, 0.97], [0.0, 0.99], [-0.6, 0.98], [-0.7, 0.9], [-0.74, 0.6], [-0.72, 0.4],
  );
  return p.map(([x, y]) => new THREE.Vector2(x, y));
}

/** Sutherland–Hodgman clip of a polygon to xMin ≤ x ≤ xMax. */
function clipX(poly: THREE.Vector2[], xMin: number, xMax: number) {
  const clip = (pts: THREE.Vector2[], inside: (p: THREE.Vector2) => boolean, xEdge: number) => {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ia = inside(a);
      const ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const t = (xEdge - a.x) / (b.x - a.x);
        out.push(new THREE.Vector2(xEdge, a.y + t * (b.y - a.y)));
      }
    }
    return out;
  };
  let r = clip(poly, (p) => p.x >= xMin, xMin);
  r = clip(r, (p) => p.x <= xMax, xMax);
  return r;
}

function extrude(pts: THREE.Vector2[], width: number, bevel = 0.04) {
  const depth = Math.max(0.01, width - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.8,
    bevelSegments: 3,
    curveSegments: 4,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

/** Box between two points in the XY plane, at a given z. */
function beam(a: THREE.Vector2, b: THREE.Vector2, z: number, thick: number, depth: number, mat: THREE.Material) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.BoxGeometry(len, thick, depth), mat);
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, z);
  m.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
  m.castShadow = true;
  return m;
}

// ---------- shared resources ----------
const GLASS_POLY = [[-0.58, 0.97], [-0.47, 1.4], [1.36, 1.4], [1.88, 0.98]].map(([x, y]) => new THREE.Vector2(x, y));
const ROOF_POLY = [[-0.47, 1.4], [-0.45, 1.46], [1.15, 1.52], [1.36, 1.4]].map(([x, y]) => new THREE.Vector2(x, y));

let shared: ReturnType<typeof makeShared> | null = null;
function makeShared() {
  const profile = bodyProfile();
  return {
    bodyFull: extrude(profile, VEHICLE.width),
    bodyFront: extrude(clipX(profile, 1.62, 9), VEHICLE.width, 0.03),
    bodyRear: extrude(clipX(profile, -9, -0.35), VEHICLE.width, 0.03),
    door: extrude(clipX(profile, -0.35, 1.62), 0.07, 0.015),
    glass: extrude(GLASS_POLY, 1.46, 0.03),
    roof: extrude(ROOF_POLY, 1.44, 0.03),
    tire: new THREE.CylinderGeometry(VEHICLE.wheelRadius, VEHICLE.wheelRadius, VEHICLE.wheelWidth, 32, 1).rotateX(Math.PI / 2),
    rim: new THREE.CylinderGeometry(0.205, 0.205, VEHICLE.wheelWidth + 0.01, 24, 1).rotateX(Math.PI / 2),
    spoke: new THREE.BoxGeometry(0.38, 0.045, 0.02),
    glassMat: new THREE.MeshPhysicalMaterial({
      color: 0x0b1117, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.45, envMapIntensity: 1.4,
    }),
    trimMat: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.55 }),
    tireMat: new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
    rimMat: new THREE.MeshStandardMaterial({ color: 0xb9bec4, metalness: 0.9, roughness: 0.3 }),
    headMat: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeaf4ff, emissiveIntensity: 1.2 }),
    tailMat: new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xc0101a, emissiveIntensity: 0.9 }),
    interiorMat: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.85 }),
    seatMat: new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.95 }),
  };
}

const paintCache = new Map<number, THREE.MeshPhysicalMaterial>();
function paint(color: number) {
  let m = paintCache.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color, metalness: 0.45, roughness: 0.38, clearcoat: 1, clearcoatRoughness: 0.08 });
    paintCache.set(color, m);
  }
  return m;
}

export interface CarRig {
  root: THREE.Group; // origin = rear axle on the ground
  body: THREE.Group;
  frontPivots: THREE.Object3D[]; // [left, right], rotate about Y to steer
  spinners: THREE.Object3D[]; // rotate about Z to roll
  steeringSpin?: THREE.Object3D;
  displayMesh?: THREE.Mesh;
  mirrors: { left: THREE.Group; right: THREE.Group };
}

export function createCar(opts: { color: number; interior: boolean }): CarRig {
  const S = (shared ??= makeShared());
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const paintMat = paint(opts.color);
  const add = (g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D = body, shadow = true) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    parent.add(mesh);
    return mesh;
  };

  // Body shell
  if (opts.interior) {
    add(S.bodyFront, paintMat);
    add(S.bodyRear, paintMat);
    const half = VEHICLE.width / 2 - 0.035;
    add(S.door, paintMat).position.z = -half;
    add(S.door, paintMat).position.z = half;
  } else {
    add(S.bodyFull, paintMat);
  }
  add(S.glass, S.glassMat, body, false);
  add(S.roof, paintMat);

  // Pillars
  const zP = 0.72;
  for (const s of [-1, 1]) {
    body.add(beam(new THREE.Vector2(1.88, 0.98), new THREE.Vector2(1.36, 1.41), s * zP, 0.07, 0.06, paintMat));
    body.add(beam(new THREE.Vector2(0.55, 0.98), new THREE.Vector2(0.52, 1.43), s * zP, 0.09, 0.05, S.trimMat));
    body.add(beam(new THREE.Vector2(-0.58, 0.98), new THREE.Vector2(-0.47, 1.41), s * zP, 0.22, 0.05, paintMat));
  }

  // Bumpers, lights
  const bumper = new THREE.BoxGeometry(0.08, 0.12, 1.62);
  add(bumper, S.trimMat).position.set(3.39, 0.36, 0);
  add(bumper, S.trimMat).position.set(-0.71, 0.36, 0);
  const lamp = new THREE.BoxGeometry(0.05, 0.05, 0.38);
  for (const s of [-1, 1]) {
    add(lamp, S.headMat, body, false).position.set(3.36, 0.66, s * 0.6);
    const t = add(lamp, S.tailMat, body, false);
    t.position.set(-0.735, 0.8, s * 0.62);
    t.scale.y = 1.6;
  }

  // Wheels
  const frontPivots: THREE.Object3D[] = [];
  const spinners: THREE.Object3D[] = [];
  for (const [x, front] of [[VEHICLE.wheelbase, true], [0, false]] as const) {
    for (const s of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(x, VEHICLE.wheelRadius, (s * VEHICLE.track) / 2);
      const spin = new THREE.Group();
      pivot.add(spin);
      add(S.tire, S.tireMat, spin);
      add(S.rim, S.rimMat, spin, false);
      for (let k = 0; k < 3; k++) {
        const sp = add(S.spoke, S.trimMat, spin, false);
        sp.position.z = s * (VEHICLE.wheelWidth / 2 + 0.006);
        sp.rotation.z = (k * Math.PI) / 3;
      }
      root.add(pivot);
      spinners.push(spin);
      if (front) frontPivots.push(pivot);
    }
  }

  // Mirrors: housing on a stalk, glass facing backwards (texture assigned in milestone 2)
  const mirrors = { left: makeMirror(-1, paintMat, S.trimMat), right: makeMirror(1, paintMat, S.trimMat) };
  body.add(mirrors.left, mirrors.right);

  const rig: CarRig = { root, body, frontPivots, spinners, mirrors };
  if (opts.interior) buildInterior(rig, S);
  return rig;
}

function makeMirror(side: number, paintMat: THREE.Material, trimMat: THREE.Material) {
  const g = new THREE.Group();
  g.name = side < 0 ? 'mirror-left' : 'mirror-right';
  g.position.set(1.7, 1.04, side * 1.04);
  const shell = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.13, 0.22, 3, 0.035), paintMat);
  shell.castShadow = true;
  shell.name = 'shell';
  g.add(shell);
  const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.12), trimMat);
  stalk.position.set(0.0, -0.04, -side * 0.12);
  g.add(stalk);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.19, 0.105),
    new THREE.MeshPhysicalMaterial({ color: 0x222830, metalness: 1, roughness: 0.05 }),
  );
  glass.name = 'glass';
  glass.rotation.y = -Math.PI / 2; // faces -X (backwards)
  glass.position.x = -0.057;
  g.add(glass);
  return g;
}

function buildInterior(rig: CarRig, S: NonNullable<typeof shared>) {
  const b = rig.body;
  const box = (sx: number, sy: number, sz: number, m: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
    mesh.receiveShadow = true;
    b.add(mesh);
    return mesh;
  };
  box(1.97, 0.08, 1.66, S.interiorMat).position.set(0.64, 0.28, 0); // floor
  box(0.45, 0.3, 1.64, S.interiorMat).position.set(1.73, 0.84, 0); // dashboard
  box(0.5, 0.18, 0.22, S.interiorMat).position.set(1.15, 0.42, 0); // console

  for (const z of [-0.37, 0.37]) {
    box(0.5, 0.12, 0.5, S.seatMat).position.set(0.78, 0.5, z);
    const back = box(0.12, 0.62, 0.5, S.seatMat);
    back.position.set(0.5, 0.86, z);
    back.rotation.z = -0.18;
    box(0.1, 0.16, 0.26, S.seatMat).position.set(0.42, 1.25, z); // headrest
  }
  box(0.45, 0.14, 1.4, S.seatMat).position.set(-0.2, 0.5, 0); // rear bench
  box(0.12, 0.55, 1.4, S.seatMat).position.set(-0.42, 0.82, 0);

  // Steering wheel: tilt → face backwards → spin about its own axis
  const tilt = new THREE.Group();
  tilt.position.set(1.38, 0.98, VEHICLE.eye.z);
  tilt.rotation.z = -0.4;
  const face = new THREE.Group();
  face.rotation.y = -Math.PI / 2;
  const spin = new THREE.Group();
  tilt.add(face);
  face.add(spin);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.7 });
  spin.add(new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.019, 12, 48), wheelMat));
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.04, 20).rotateX(Math.PI / 2), wheelMat);
  spin.add(hub);
  for (const a of [Math.PI / 2 + Math.PI, 0, Math.PI]) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.026, 0.014), wheelMat);
    sp.position.set(Math.cos(a) * 0.095, Math.sin(a) * 0.095, 0);
    sp.rotation.z = a;
    spin.add(sp);
  }
  // Top marker so the rotation is readable
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.03, 0.045), new THREE.MeshStandardMaterial({ color: 0xbfc5ca }));
  mark.position.set(0, 0.18, 0);
  spin.add(mark);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.3, 12).rotateX(Math.PI / 2), wheelMat);
  column.position.z = -0.17;
  face.add(column);
  b.add(tilt);
  rig.steeringSpin = spin;

  // Central display (canvas texture is assigned by the display module)
  const dispGroup = new THREE.Group();
  dispGroup.position.set(1.53, 1.1, 0.02);
  dispGroup.rotation.y = -Math.PI / 2 - 0.14;
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.215, 0.015), S.trimMat);
  housing.position.z = -0.009;
  housing.rotation.x = -0.12;
  dispGroup.add(housing);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.2), new THREE.MeshBasicMaterial({ color: 0x050607 }));
  screen.rotation.x = -0.12;
  dispGroup.add(screen);
  b.add(dispGroup);
  rig.displayMesh = screen;
}

/** Pose the rig from the vehicle state (Ackermann on the front wheels). */
export function poseCar(rig: CarRig, x: number, z: number, heading: number, steer: number, spin: number, wheelDeg: number) {
  rig.root.position.set(x, 0, z);
  rig.root.rotation.y = -heading;
  const L = VEHICLE.wheelbase;
  const t = VEHICLE.track;
  let left = steer;
  let right = steer;
  if (Math.abs(steer) > 1e-4) {
    const R = L / Math.tan(steer); // signed, positive = turning right
    left = Math.atan(L / (R + t / 2));
    right = Math.atan(L / (R - t / 2));
  }
  rig.frontPivots[0].rotation.y = -left;
  rig.frontPivots[1].rotation.y = -right;
  for (const s of rig.spinners) s.rotation.z = -spin;
  if (rig.steeringSpin) rig.steeringSpin.rotation.z = -THREE.MathUtils.degToRad(wheelDeg);
}

/** A static parked car whose centre is at (cx, cz), facing +X or -X. */
export function createParkedCar(cx: number, cz: number, length: number, color: number, facing = 1) {
  const rig = createCar({ color, interior: false });
  const s = length / VEHICLE.length;
  rig.root.scale.set(s, 1, 1);
  const centreLocal = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
  rig.root.position.set(cx - facing * centreLocal * s, 0, cz);
  rig.root.rotation.y = facing > 0 ? 0 : Math.PI;
  return rig;
}
