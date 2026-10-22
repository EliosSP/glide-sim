import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { VEHICLE } from '../config';

export type CarStyle = 'hatch' | 'sedan' | 'suv' | 'mpv';

type P = [number, number];
/**
 * Body styles, same footprint (planner and collisions use config.ts): front of the profile after
 * the front arch, side glass [rear bottom, rear top, front top, front bottom] and roof.
 */
const STYLES: Record<CarStyle, { nose: P[]; glass: P[]; roof: P[] }> = {
  hatch: {
    nose: [[3.0, 0.26], [3.3, 0.3], [3.42, 0.45], [3.4, 0.62], [3.25, 0.76], [2.5, 0.9], [1.85, 0.97], [0.0, 0.99], [-0.6, 0.98], [-0.7, 0.9], [-0.74, 0.6], [-0.72, 0.4]],
    glass: [[-0.58, 0.97], [-0.47, 1.4], [1.36, 1.4], [1.88, 0.98]],
    roof: [[-0.47, 1.4], [-0.45, 1.46], [1.15, 1.52], [1.36, 1.4]],
  },
  // Three-box: the rear glass ends on a boot deck
  sedan: {
    nose: [[3.0, 0.26], [3.3, 0.3], [3.42, 0.45], [3.4, 0.6], [3.25, 0.74], [2.5, 0.88], [1.85, 0.96], [0.0, 0.99], [-0.5, 1.0], [-0.68, 0.96], [-0.74, 0.6], [-0.72, 0.4]],
    glass: [[-0.22, 0.99], [0.08, 1.38], [1.3, 1.39], [1.86, 0.97]],
    roof: [[0.08, 1.38], [0.1, 1.44], [1.1, 1.48], [1.3, 1.39]],
  },
  // Higher belt and roof
  suv: {
    nose: [[3.0, 0.26], [3.3, 0.3], [3.44, 0.5], [3.42, 0.74], [3.3, 0.9], [2.5, 1.03], [1.85, 1.09], [0.0, 1.11], [-0.6, 1.1], [-0.7, 1.02], [-0.74, 0.6], [-0.72, 0.4]],
    glass: [[-0.6, 1.09], [-0.5, 1.56], [1.3, 1.56], [1.86, 1.1]],
    roof: [[-0.5, 1.56], [-0.48, 1.63], [1.1, 1.68], [1.3, 1.56]],
  },
  // Short bonnet, tall boxy cabin
  mpv: {
    nose: [[3.0, 0.26], [3.3, 0.3], [3.42, 0.48], [3.4, 0.7], [3.2, 0.86], [2.7, 0.99], [2.25, 1.04], [0.0, 1.06], [-0.65, 1.05], [-0.72, 0.98], [-0.74, 0.6], [-0.72, 0.4]],
    glass: [[-0.68, 1.04], [-0.64, 1.66], [1.55, 1.66], [2.25, 1.04]],
    roof: [[-0.64, 1.66], [-0.62, 1.72], [1.4, 1.74], [1.55, 1.66]],
  },
};
const v2 = (pts: P[]) => pts.map(([x, y]) => new THREE.Vector2(x, y));

// Side profile of the lower body (x forward from rear axle, y up), with wheel arches.
const ARCH_R = 0.4;
const ARCH_CY = 0.32;
function bodyProfile(style: CarStyle): THREE.Vector2[] {
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
  p.push(...STYLES[style].nose);
  return v2(p);
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
const styleGeo = new Map<CarStyle, ReturnType<typeof makeStyleGeo>>();
function makeStyleGeo(style: CarStyle) {
  const profile = bodyProfile(style);
  const st = STYLES[style];
  return {
    bodyFull: extrude(profile, VEHICLE.width),
    bodyFront: extrude(clipX(profile, 1.62, 9), VEHICLE.width, 0.03),
    bodyRear: extrude(clipX(profile, -9, -0.35), VEHICLE.width, 0.03),
    door: extrude(clipX(profile, -0.35, 1.62), 0.07, 0.015),
    glass: extrude(v2(st.glass), 1.46, 0.03),
    roof: extrude(v2(st.roof), 1.44, 0.03),
  };
}

let shared: ReturnType<typeof makeShared> | null = null;
function makeShared() {
  return {
    seam: new THREE.BoxGeometry(0.008, 0.5, 0.004),
    plate: new THREE.PlaneGeometry(0.42, 0.1).rotateY(Math.PI / 2), // faces +X
    plateMat: new THREE.MeshStandardMaterial({ map: plateTexture(), roughness: 0.4 }),
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

/** EU-style plate: white, blue band on the left. */
function plateTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2f2ee';
  g.fillRect(0, 0, 256, 64);
  g.fillStyle = '#1f47a8';
  g.fillRect(0, 0, 22, 64);
  g.fillRect(234, 0, 22, 64);
  g.fillStyle = '#16181b';
  g.font = 'bold 40px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('GL 036 DE', 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
  rearMirror?: THREE.Group; // interior rear-view mirror (Jacopo's car only); no light bar on it
}

export function createCar(opts: { color: number; interior: boolean; style?: CarStyle }): CarRig {
  const S = (shared ??= makeShared());
  const style = opts.style ?? 'hatch';
  let G = styleGeo.get(style);
  if (!G) styleGeo.set(style, (G = makeStyleGeo(style)));
  const st = STYLES[style];
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
    add(G.bodyFront, paintMat);
    add(G.bodyRear, paintMat);
    const half = VEHICLE.width / 2 - 0.035;
    add(G.door, paintMat).position.z = -half;
    add(G.door, paintMat).position.z = half;
  } else {
    add(G.bodyFull, paintMat);
    // Door shut lines
    const belt = st.glass[3][1];
    for (const x of [1.62, 0.55, style === 'sedan' ? -0.15 : -0.35]) {
      for (const s of [-1, 1]) add(S.seam, S.trimMat, body, false).position.set(x, (0.42 + belt) / 2, s * (VEHICLE.width / 2 + 0.002));
    }
  }
  add(G.glass, S.glassMat, body, false);
  add(G.roof, paintMat);

  // Pillars, from the glass outline: A (front), B (between the doors), C (rear)
  const [rb, rt, ft, fb] = st.glass.map(([x, y]) => new THREE.Vector2(x, y));
  const zP = 0.72;
  for (const s of [-1, 1]) {
    body.add(beam(fb, ft.clone().setY(ft.y + 0.01), s * zP, 0.07, 0.06, paintMat));
    body.add(beam(new THREE.Vector2(0.55, rb.y), new THREE.Vector2(0.52, rt.y + 0.03), s * zP, 0.09, 0.05, S.trimMat));
    body.add(beam(rb, rt.clone().setY(rt.y + 0.01), s * zP, style === 'sedan' ? 0.16 : 0.22, 0.05, paintMat));
  }

  // Number plates
  add(S.plate, S.plateMat, body, false).position.set(3.445, 0.47, 0);
  const rear = add(S.plate, S.plateMat, body, false);
  rear.position.set(-0.765, 0.56, 0);
  rear.rotation.y = Math.PI;

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
  const mirrorY = st.glass[3][1] + 0.06;
  const mirrors = { left: makeMirror(-1, paintMat, S.trimMat, mirrorY), right: makeMirror(1, paintMat, S.trimMat, mirrorY) };
  body.add(mirrors.left, mirrors.right);

  const rig: CarRig = { root, body, frontPivots, spinners, mirrors };
  if (opts.interior) buildInterior(rig, S);
  return rig;
}

function makeMirror(side: number, paintMat: THREE.Material, trimMat: THREE.Material, y: number) {
  const g = new THREE.Group();
  g.name = side < 0 ? 'mirror-left' : 'mirror-right';
  g.position.set(1.7, y, side * 1.04);
  const shell = new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.155, 0.225, 3, 0.035), paintMat);
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
  glass.position.set(-0.066, -0.009, 0); // clear of the housing even with a few degrees of pitch
  g.add(glass);
  // Mount for the light bar: thin strip on the lower rim, below the glass, facing backwards
  const mount = new THREE.Object3D();
  mount.name = 'bar-mount';
  mount.position.set(-0.059, -0.069, 0);
  mount.rotation.y = -Math.PI / 2;
  g.add(mount);
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

  // Interior rear-view mirror: flat, on a short stem glued to the top of the windscreen
  const rm = new THREE.Group();
  rm.name = 'mirror-rear';
  rm.position.set(1.42, 1.27, 0);
  rm.add(new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.07, 0.22, 2, 0.014), S.trimMat));
  const rmGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.055), new THREE.MeshBasicMaterial({ color: 0x222830 }));
  rmGlass.name = 'glass';
  rmGlass.rotation.y = -Math.PI / 2; // faces -X (backwards)
  rmGlass.position.set(-0.017, 0, 0);
  rm.add(rmGlass);
  b.add(rm);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.06, 6), S.trimMat);
  stem.position.set(1.435, 1.32, 0);
  b.add(stem);
  rig.rearMirror = rm;
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
export function createParkedCar(cx: number, cz: number, length: number, color: number, facing = 1, style: CarStyle = 'hatch') {
  const rig = createCar({ color, interior: false, style });
  const s = length / VEHICLE.length;
  rig.root.scale.set(s, 1, 1);
  const centreLocal = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
  rig.root.position.set(cx - facing * centreLocal * s, 0, cz);
  rig.root.rotation.y = facing > 0 ? 0 : Math.PI;
  return rig;
}
