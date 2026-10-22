import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ROAD } from '../config';

// Street furniture. Repeated objects are instanced (one draw call per kind).
// Nothing here stands in the road or the parking lane: planner and collisions are unaffected.

/** Trees are left out around the target space, so the top view of the manoeuvre stays clear. */
const TREE_FREE = { xMin: -12, xMax: 16 };
/** Zebra crossings, outside the parking rows. */
const CROSSINGS = [-40, 45];

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function addProps(group: THREE.Group, lamps: { x: number; side: 1 | -1 }[]) {
  addTrees(group, lamps);
  addBins(group, lamps);
  addCrossings(group);
  addParkingSign(group);
}

function addTrees(group: THREE.Group, lamps: { x: number; side: 1 | -1 }[]) {
  const r = rng(77);
  // Halfway between lamps, in line with them near the curb
  const spots = lamps
    .map(({ x, side }) => ({ x: x + 13, side }))
    .filter(({ x, side }) => x < ROAD.length / 2 - 5 && !(side > 0 && x > TREE_FREE.xMin && x < TREE_FREE.xMax));

  const trunkGeo = new THREE.CylinderGeometry(0.09, 0.14, 3.4, 8).translate(0, 1.7, 0);
  const blobs = [
    new THREE.IcosahedronGeometry(1.15, 1).translate(0, 4.2, 0),
    new THREE.IcosahedronGeometry(0.9, 1).translate(0.55, 4.9, 0.3),
    new THREE.IcosahedronGeometry(0.85, 1).translate(-0.5, 4.8, -0.35),
    new THREE.IcosahedronGeometry(0.7, 1).translate(0.1, 5.5, 0),
  ];
  const canopyGeo = mergeGeometries(blobs);
  const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95 }), spots.length);
  const canopy = new THREE.InstancedMesh(
    canopyGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }),
    spots.length,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const greens = [0x4d6b34, 0x587a3a, 0x445f2f, 0x63803f];
  spots.forEach(({ x, side }, i) => {
    const s = 0.85 + r() * 0.3;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
    m.compose(new THREE.Vector3(x, ROAD.curbHeight, side * (ROAD.curbZ + 0.6)), q, new THREE.Vector3(s, s, s));
    trunk.setMatrixAt(i, m);
    canopy.setMatrixAt(i, m);
    canopy.setColorAt(i, new THREE.Color(greens[Math.floor(r() * greens.length)]));
  });
  for (const mesh of [trunk, canopy]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

/** Small litter bins hanging on the lamp poles, on the building side. */
function addBins(group: THREE.Group, lamps: { x: number; side: 1 | -1 }[]) {
  const geo = new THREE.CylinderGeometry(0.2, 0.18, 0.55, 14, 1, true);
  const bins = new THREE.InstancedMesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0x2f4a3a, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide }),
    lamps.length,
  );
  const m = new THREE.Matrix4();
  lamps.forEach(({ x, side }, i) => {
    m.makeTranslation(x, ROAD.curbHeight + 0.95, side * (ROAD.curbZ + 0.6 + 0.26));
    bins.setMatrixAt(i, m);
  });
  bins.castShadow = true;
  group.add(bins);
}

function addCrossings(group: THREE.Group) {
  const paint = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 });
  const stripe = new THREE.PlaneGeometry(2.6, 0.5).rotateX(-Math.PI / 2);
  const zs: number[] = [];
  // Across the two driving lanes (the opposite parking row is continuous)
  for (let z = -ROAD.laneWidth + 0.4; z < ROAD.laneWidth - 0.2; z += 1.0) zs.push(z);
  const mesh = new THREE.InstancedMesh(stripe, paint, zs.length * CROSSINGS.length);
  const m = new THREE.Matrix4();
  let i = 0;
  for (const x of CROSSINGS) {
    for (const z of zs) {
      m.makeTranslation(x, 0.005, z);
      mesh.setMatrixAt(i++, m);
    }
  }
  mesh.receiveShadow = true;
  group.add(mesh);
}

/** Blue "P" sign at the start of the parking row, on the right sidewalk. */
function addParkingSign(group: THREE.Group) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#1f4fa3';
  g.fillRect(6, 6, 116, 116);
  g.fillStyle = '#ffffff';
  g.font = 'bold 96px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('P', 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const x = -31;
  const z = ROAD.curbZ + 0.35;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 2.6, 8),
    new THREE.MeshStandardMaterial({ color: 0x8a8f94, metalness: 0.7, roughness: 0.4 }),
  );
  pole.position.set(x, ROAD.curbHeight + 1.3, z);
  pole.castShadow = true;
  // Faces the oncoming traffic of Jacopo's lane (−X)
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(0.02, 0.6, 0.6),
    [0, 1, 2, 3, 4, 5].map((k) =>
      k === 1 ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }) : new THREE.MeshStandardMaterial({ color: 0xb9bdc1, roughness: 0.5 }),
    ),
  );
  sign.position.set(x - 0.02, ROAD.curbHeight + 2.35, z);
  sign.castShadow = true;
  group.add(pole, sign);
}
