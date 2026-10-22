import * as THREE from 'three';

// Procedural people and bike, built facing +X with the origin on the ground.

const SKIN = [0xe0b48f, 0xc68a5c, 0x8d5a3b, 0xf1cfb0];
const SHIRTS = [0x2f4b6e, 0xb23a3a, 0xd9d4c7, 0x3d5b3a, 0x2b2b2b, 0x8a6d9e, 0xc9a23c, 0x5d7c8a];
const TROUSERS = [0x22262d, 0x3a4a63, 0x5b5248, 0x1b1c1f, 0x7a7466];

const matCache = new Map<number, THREE.MeshStandardMaterial>();
function mat(color: number, roughness = 0.85) {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness });
    matCache.set(color, m);
  }
  return m;
}

function part(geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(geo, m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Limb hanging from a pivot: a capsule whose top is at the pivot. */
function limb(parent: THREE.Object3D, radius: number, length: number, m: THREE.Material, x: number, y: number, z: number) {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  parent.add(pivot);
  part(new THREE.CapsuleGeometry(radius, length - 2 * radius, 4, 10), m, pivot, 0, -length / 2, 0);
  return pivot;
}

export interface Walker {
  root: THREE.Group;
  /** Walking cycle; phase in radians, speed in m/s (0 = standing). */
  animate(phase: number, speed: number): void;
}

export function createPedestrian(seed: number): Walker {
  const pick = <T,>(a: T[], k: number) => a[(seed * k) % a.length];
  const skin = mat(pick(SKIN, 7));
  const shirt = mat(pick(SHIRTS, 5));
  const trousers = mat(pick(TROUSERS, 3));
  const scale = 0.92 + ((seed * 37) % 17) / 100;

  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(scale);
  root.add(body);
  const hip = 0.88;
  const legs = [-1, 1].map((s) => limb(body, 0.075, 0.86, trousers, 0, hip, s * 0.1));
  part(new THREE.CapsuleGeometry(0.17, 0.36, 4, 12), shirt, body, 0, 1.2, 0).scale.set(0.75, 1, 1.15);
  part(new THREE.SphereGeometry(0.105, 16, 12), skin, body, 0.01, 1.6, 0);
  const arms = [-1, 1].map((s) => limb(body, 0.05, 0.58, shirt, 0, 1.44, s * 0.235));
  for (const a of arms) part(new THREE.SphereGeometry(0.05, 8, 6), skin, a, 0, -0.6, 0);

  return {
    root,
    animate(phase, speed) {
      const amp = Math.min(1, speed / 1.2);
      const sw = Math.sin(phase) * 0.45 * amp;
      legs[0].rotation.z = sw;
      legs[1].rotation.z = -sw;
      arms[0].rotation.z = -sw * 0.8;
      arms[1].rotation.z = sw * 0.8;
      body.position.y = Math.abs(Math.cos(phase)) * 0.03 * amp;
    },
  };
}

/** Cylinder between two points. */
function stick(a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material, parent: THREE.Object3D) {
  const d = new THREE.Vector3().subVectors(b, a);
  const mesh = part(new THREE.CylinderGeometry(r, r, d.length(), 8), m, parent);
  mesh.position.copy(a).addScaledVector(d, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return mesh;
}

export interface Rider {
  root: THREE.Group;
  /** Wheel and crank rotation from the distance travelled. */
  animate(distance: number): void;
}

export function createCyclist(): Rider {
  const root = new THREE.Group();
  const frameMat = mat(0x1f6f8b, 0.4);
  const dark = mat(0x161616, 0.7);
  const skin = mat(SKIN[0]);
  const jacket = mat(0xd8e04a, 0.7); // high-visibility jacket
  const trousers = mat(0x23272e);
  const R = 0.34;
  const V = (x: number, y: number, z = 0) => new THREE.Vector3(x, y, z);

  // Wheels
  const wheels = [-0.52, 0.52].map((x) => {
    const w = new THREE.Group();
    w.position.set(x, R, 0);
    part(new THREE.TorusGeometry(R - 0.02, 0.022, 8, 28), dark, w);
    for (let k = 0; k < 4; k++) {
      const sp = part(new THREE.BoxGeometry(2 * R - 0.06, 0.008, 0.008), mat(0x9aa0a6, 0.3), w);
      sp.rotation.z = (k * Math.PI) / 4;
    }
    root.add(w);
    return w;
  });

  // Frame
  const bb = V(0, 0.32); // bottom bracket
  const seat = V(-0.14, 0.86);
  const head = V(0.4, 0.82);
  stick(V(-0.52, R), bb, 0.018, frameMat, root);
  stick(V(-0.52, R), seat, 0.016, frameMat, root);
  stick(bb, seat, 0.022, frameMat, root);
  stick(bb, head, 0.024, frameMat, root);
  stick(seat.clone().setY(0.78), head.clone().setY(0.78), 0.02, frameMat, root);
  stick(head, V(0.52, R), 0.018, frameMat, root);
  stick(head, V(0.44, 1.0), 0.016, dark, root);
  stick(V(0.44, 1.0, -0.26), V(0.44, 1.0, 0.26), 0.014, dark, root); // handlebar
  part(new THREE.BoxGeometry(0.24, 0.05, 0.12), dark, root, -0.15, 0.9, 0); // saddle

  // Crank with pedals
  const crank = new THREE.Group();
  crank.position.copy(bb);
  root.add(crank);
  for (const s of [-1, 1]) {
    stick(V(0, 0, 0), V(0, -s * 0.17, s * 0.08), 0.012, dark, crank);
    part(new THREE.BoxGeometry(0.1, 0.02, 0.07), dark, crank, 0, -s * 0.17, s * 0.12);
  }

  // Rider
  const torso = part(new THREE.CapsuleGeometry(0.16, 0.36, 4, 12), jacket, root, 0.06, 1.25, 0);
  torso.rotation.z = -0.55; // leaning forward
  torso.scale.set(0.8, 1, 1.1);
  part(new THREE.SphereGeometry(0.1, 16, 12), skin, root, 0.3, 1.58, 0);
  const helmet = part(new THREE.SphereGeometry(0.125, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xf2f2f2, 0.4), root, 0.3, 1.6, 0);
  helmet.scale.set(1.15, 0.9, 1);
  for (const s of [-1, 1]) stick(V(0.2, 1.45, s * 0.2), V(0.44, 1.0, s * 0.22), 0.045, jacket, root);
  const legs = [-1, 1].map((s) => limb(root, 0.07, 0.82, trousers, -0.12, 0.92, s * 0.1));

  return {
    root,
    animate(distance) {
      const a = distance / R;
      for (const w of wheels) w.rotation.z = -a;
      const c = -a / 2.6; // gear ratio
      crank.rotation.z = c;
      legs[0].rotation.z = 0.35 + 0.35 * Math.sin(c);
      legs[1].rotation.z = 0.35 - 0.35 * Math.sin(c);
    },
  };
}
