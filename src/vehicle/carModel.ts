import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { VEHICLE } from '../config';
import { buildInterior } from './interior';

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
  /** Physical P button under the display (Jacopo's car only). */
  pButton?: { cap: THREE.Object3D; set(k: number, active: boolean): void };
  rearMirror?: THREE.Group; // interior rear-view mirror (Jacopo's car only); no light bar on it
}

export function createCar(opts: { color: number; interior: boolean; style?: CarStyle; mirrorRaise?: number }): CarRig {
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

  // Mirrors: housing (aimed later towards the driver's eye), glass facing backwards. The arm that carries
  // it is fixed to the body, from the base of the A-pillar on the door line up to the housing.
  const belt = st.glass[3][1];
  const mirrorY = belt + 0.06 + (opts.mirrorRaise ?? 0);
  const mirrors = { left: makeMirror(-1, paintMat, S.trimMat, mirrorY), right: makeMirror(1, paintMat, S.trimMat, mirrorY) };
  body.add(mirrors.left, mirrors.right);
  for (const s of [-1, 1]) {
    const foot = new THREE.Vector3(1.78, belt - 0.01, s * 0.86); // on the door, at the base of the A-pillar
    const top = new THREE.Vector3(1.72, mirrorY - 0.05, s * 0.97); // under the inner end of the housing
    body.add(taperedArm(foot, top, 0.044, 0.03, S.trimMat));
    const plate = new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.03, 0.09, 3, 0.012), S.trimMat); // base cover on the door
    plate.position.set(1.75, belt - 0.005, s * 0.875);
    plate.castShadow = true;
    body.add(plate);
  }

  const rig: CarRig = { root, body, frontPivots, spinners, mirrors };
  if (opts.interior) buildInterior(rig);
  return rig;
}

/** Round arm from a to b, thicker at a (radius ra) than at b (radius rb). */
function taperedArm(a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, m: THREE.Material) {
  const dir = b.clone().sub(a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rb, ra, dir.length(), 20), m);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  mesh.castShadow = true;
  return mesh;
}

/** Centred rounded-rectangle outline on a shape or hole path (cy: vertical offset). */
function roundedRectPath<T extends THREE.Path>(p: T, w: number, h: number, r: number, cy = 0): T {
  const x = w / 2;
  const y = h / 2;
  p.moveTo(-x + r, cy - y);
  p.lineTo(x - r, cy - y);
  p.absarc(x - r, cy - y + r, r, -Math.PI / 2, 0, false);
  p.lineTo(x, cy + y - r);
  p.absarc(x - r, cy + y - r, r, 0, Math.PI / 2, false);
  p.lineTo(-x + r, cy + y);
  p.absarc(-x + r, cy + y - r, r, Math.PI / 2, Math.PI, false);
  p.lineTo(-x, cy - y + r);
  p.absarc(-x + r, cy - y + r, r, Math.PI, Math.PI * 1.5, false);
  return p;
}

/** Flat ring (rounded outline with a rounded hole) in the mirror's back plane, extruded backwards from x = xFront. */
function mirrorRing(outer: [number, number, number], hole: [number, number, number], holeY: number, depth: number, xFront: number, bevel: number) {
  const shape = roundedRectPath(new THREE.Shape(), ...outer);
  shape.holes.push(roundedRectPath(new THREE.Path(), ...hole, holeY));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 18 });
  g.rotateY(-Math.PI / 2); // shape (u, v) → (z, y); the extrusion runs towards -x
  g.translate(xFront, 0, 0);
  return g;
}

function makeMirror(side: number, paintMat: THREE.Material, trimMat: THREE.Material, y: number) {
  const g = new THREE.Group();
  g.name = side < 0 ? 'mirror-left' : 'mirror-right';
  g.position.set(1.7, y, side * 1.04);
  const gloss = new THREE.MeshPhysicalMaterial({ color: 0x0c0e11, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.05 });
  const put = (geo: THREE.BufferGeometry, m: THREE.Material, x = 0, yy = 0, z = 0, shadow = true) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, yy, z);
    mesh.castShadow = shadow;
    g.add(mesh);
    return mesh;
  };

  // Head: rounded body that narrows towards the front (aerodynamic), with a larger lower part for the light
  const head = new RoundedBoxGeometry(0.1, 0.175, 0.225, 8, 0.05);
  const pos = head.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const f = (pos.getX(i) + 0.05) / 0.1; // 0 at the back, 1 at the front
    const k = 1 - 0.22 * f * f;
    pos.setY(i, pos.getY(i) * k - 0.012 * f * f);
    pos.setZ(i, pos.getZ(i) * k);
  }
  head.computeVertexNormals();
  put(head, paintMat, 0, -0.01).name = 'shell';

  // Back: painted rim round the glass, and a thin black gasket against the glass edge
  put(mirrorRing([0.222, 0.172, 0.05], [0.198, 0.113, 0.032], 0.001, 0.01, -0.042, 0.002), paintMat, 0, -0.01, 0);
  put(mirrorRing([0.2, 0.115, 0.034], [0.188, 0.103, 0.028], 0, 0.002, -0.0535, 0), trimMat, 0, -0.009, 0, false);

  // Neck under the inner end of the head, meeting the arm fixed to the body
  put(new RoundedBoxGeometry(0.07, 0.07, 0.09, 4, 0.02), trimMat, 0.01, -0.085, -side * 0.075);

  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.19, 0.105),
    new THREE.MeshPhysicalMaterial({ color: 0x222830, metalness: 1, roughness: 0.05 }),
  );
  glass.name = 'glass';
  glass.rotation.y = -Math.PI / 2; // faces -X (backwards)
  glass.position.set(-0.0515, -0.009, 0); // recessed in the rim; rounded corners (alpha mask) follow its shape
  g.add(glass);

  // Light: a glossy black channel along the lower rim, the bar sits on its face
  put(new RoundedBoxGeometry(0.012, 0.026, 0.205, 3, 0.006), gloss, -0.0515, -0.0803, 0, false);
  const mount = new THREE.Object3D();
  mount.name = 'bar-mount';
  mount.position.set(-0.0585, -0.0803, 0);
  mount.rotation.y = -Math.PI / 2;
  g.add(mount);
  return g;
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
