import * as THREE from 'three';
import { ROAD } from '../config';
import type { World } from './world';
import { createParkedCar, type CarStyle } from '../vehicle/carModel';
import { buildOppositeRow, buildParkingRow, type FreeSpace, type ParkedCar } from './parkingLayout';
import { addProps } from './props';

// Deterministic pseudo-random, so the street is identical on every reload
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// CC0 textures from Poly Haven (see README credits), 1K, loaded from public/textures/<name>/
const loader = new THREE.TextureLoader();
const texCache = new Map<string, { base: THREE.Texture; clones: THREE.Texture[]; loaded: boolean }>();
function phTexture(name: string, map: 'diff' | 'nor' | 'rough') {
  const key = `${name}/${map}`;
  let e = texCache.get(key);
  if (!e) {
    const entry = { base: null as unknown as THREE.Texture, clones: [] as THREE.Texture[], loaded: false };
    // Clones share the image; they are flagged for upload only once it has arrived
    entry.base = loader.load(`${import.meta.env.BASE_URL}textures/${key}.jpg`, () => {
      entry.loaded = true;
      for (const c of entry.clones) c.needsUpdate = true;
    });
    entry.base.wrapS = entry.base.wrapT = THREE.RepeatWrapping;
    entry.base.anisotropy = 8;
    if (map === 'diff') entry.base.colorSpace = THREE.SRGBColorSpace;
    texCache.set(key, (e = entry));
  }
  const t = e.base.clone();
  if (!e.loaded) {
    t.version = 0; // clone() flags an upload; without the image yet that only produces warnings
    e.clones.push(t);
  }
  return t;
}

/** PBR maps of a Poly Haven texture, tiled `rx` × `ry` times (clones share the image). */
function phMaps(name: string, rx: number, ry: number, which: ('diff' | 'nor' | 'rough')[] = ['diff', 'nor', 'rough']) {
  const out: Partial<Record<'map' | 'normalMap' | 'roughnessMap', THREE.Texture>> = {};
  const key = { diff: 'map', nor: 'normalMap', rough: 'roughnessMap' } as const;
  for (const m of which) {
    const t = phTexture(name, m);
    t.repeat.set(rx, ry);
    out[key[m]] = t;
  }
  return out;
}

/** Body style from the length: short cars are hatchbacks, long ones sedans or MPVs. */
function styleFor(length: number, i: number): CarStyle {
  if (length < 4.05) return 'hatch';
  if (length >= 4.4) return i % 2 ? 'sedan' : 'mpv';
  return i % 2 ? 'suv' : 'hatch';
}

export interface Street {
  group: THREE.Group;
  parkedCars: ParkedCar[];
  oppositeCars: ParkedCar[];
  spaces: FreeSpace[];
}

export function buildStreet(world: World, targetSpaceLength?: number): Street {
  const group = new THREE.Group();
  const L = ROAD.length;
  const curbZ = ROAD.curbZ;

  // Ground far away
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshStandardMaterial({ color: 0x6d6a63, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  group.add(ground);

  // Asphalt
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(L, curbZ * 2),
    new THREE.MeshStandardMaterial({ ...phMaps('clean_asphalt', L / 4, (2 * curbZ) / 4), color: 0xffffff, roughness: 1, metalness: 0 }),
  );
  road.rotation.x = -Math.PI / 2;
  road.receiveShadow = true;
  group.add(road);

  // Markings: dashed centre line, solid lines between lanes and parking
  const paint = new THREE.MeshStandardMaterial({ color: 0xe9e9e4, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2 });
  const dash = new THREE.PlaneGeometry(3, 0.12).rotateX(-Math.PI / 2);
  for (let x = -L / 2; x < L / 2; x += 7.5) {
    const m = new THREE.Mesh(dash, paint);
    m.position.set(x + 1.5, 0.004, 0);
    m.receiveShadow = true;
    group.add(m);
  }
  for (const s of [-1, 1]) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(L, 0.12).rotateX(-Math.PI / 2), paint);
    line.position.set(0, 0.004, s * ROAD.laneWidth);
    line.receiveShadow = true;
    group.add(line);
  }

  // Sidewalks with curbs
  const sidewalkMat = new THREE.MeshStandardMaterial({ ...phMaps('concrete_pavement_02', L / 2, (ROAD.sidewalkWidth - 0.2) / 2), roughness: 1 });
  // Stone curb: long blocks
  const curbMat = new THREE.MeshStandardMaterial({ ...phMaps('concrete', L / 1.2, 0.2), color: 0xd8d4cc, roughness: 1 });
  const h = ROAD.curbHeight;
  for (const s of [-1, 1]) {
    const sw = new THREE.Mesh(new THREE.BoxGeometry(L, h, ROAD.sidewalkWidth - 0.2), sidewalkMat);
    sw.position.set(0, h / 2, s * (curbZ + 0.2 + (ROAD.sidewalkWidth - 0.2) / 2));
    sw.receiveShadow = true;
    sw.castShadow = true;
    group.add(sw);
    const curb = new THREE.Mesh(new THREE.BoxGeometry(L, h + 0.01, 0.2), curbMat);
    curb.position.set(0, (h + 0.01) / 2, s * (curbZ + 0.1));
    curb.receiveShadow = true;
    curb.castShadow = true;
    group.add(curb);
  }

  addBuildings(group, world);
  addLamps(group, world);
  addProps(group, lampPositions());

  // Parked cars
  const { cars, spaces } = buildParkingRow(targetSpaceLength);
  for (const [i, c] of cars.entries()) group.add(createParkedCar(c.x, c.z, c.length, c.color, 1, styleFor(c.length, i)).root);
  const oppositeCars = buildOppositeRow();
  for (const [i, c] of oppositeCars.entries()) group.add(createParkedCar(c.x, c.z, c.length, c.color, -1, styleFor(c.length, i + 1)).root);

  world.scene.add(group);
  return { group, parkedCars: cars, oppositeCars, spaces };
}

function facadeTexture(seed: number) {
  const r = rng(seed);
  const shutter = ['#3f5b3a', '#4a6340', '#6b5640', '#5d6b70'][Math.floor(r() * 4)];
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 256, 256);
    // one floor = 256 px tall; one bay = 256 px wide
    g.fillStyle = '#e6e2da';
    g.fillRect(0, 0, 256, 18); // string course
    g.fillStyle = '#1e2329';
    g.fillRect(88, 60, 80, 140); // window
    g.fillStyle = shutter;
    g.fillRect(52, 60, 34, 140);
    g.fillRect(170, 60, 34, 140);
    g.fillStyle = '#d8d4cc';
    g.fillRect(80, 198, 96, 10); // sill
  });
}

function addBuildings(group: THREE.Group, world: World) {
  const r = rng(42);
  const palette = [0xd9b98a, 0xc98b6b, 0xe8dcc0, 0xd8c37e, 0xb9765a, 0xe2cfa9, 0xcfae96];
  const textures = [0, 1, 2, 3].map((i) => facadeTexture(100 + i));
  const nightWindow = new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffc98a, emissiveIntensity: 0 });
  nightWindow.userData.nightScale = 0.5;
  world.nightMaterials.push(nightWindow);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a5a44, roughness: 0.9 });
  const shopMat = new THREE.MeshStandardMaterial({ color: 0x2c3237, roughness: 0.15, metalness: 0.6 });
  const shopGeo = new THREE.BoxGeometry(2.6, 2.3, 0.06);

  for (const s of [-1, 1]) {
    let x = -ROAD.length / 2;
    const zFront = s * (ROAD.curbZ + ROAD.sidewalkWidth);
    while (x < ROAD.length / 2) {
      const w = 12 + Math.floor(r() * 3) * 3.5;
      const floors = 4 + Math.floor(r() * 3);
      const hgt = floors * 3.2 + 1.0;
      const d = 12;
      const tex = textures[Math.floor(r() * textures.length)].clone();
      tex.repeat.set(w / 3.5, floors);
      tex.offset.y = -1.0 / 3.2; // ground floor plinth
      tex.needsUpdate = true;
      // Painted plaster: window layout as colour map, plaster relief and roughness from the CC0 texture
      const facade = new THREE.MeshStandardMaterial({
        ...phMaps('beige_wall_001', w / 2.5, hgt / 2.5, ['nor', 'rough']),
        color: palette[Math.floor(r() * palette.length)],
        map: tex,
        roughness: 1,
      });
      const plain = new THREE.MeshStandardMaterial({ color: facade.color, roughness: 0.9 });
      // Box faces: +x, -x, +y, -y, +z, -z. The street-facing side is -z for s=+1 and +z for s=-1.
      const mats = [plain, plain, roofMat, plain, s > 0 ? plain : facade, s > 0 ? facade : plain];
      const b = new THREE.Mesh(new THREE.BoxGeometry(w - 0.15, hgt, d), mats);
      b.position.set(x + w / 2, hgt / 2, zFront + s * (d / 2));
      b.castShadow = true;
      b.receiveShadow = true;
      group.add(b);
      // Ground-floor shop windows, one per bay
      for (let bx = x + 1.2; bx + 2.6 < x + w - 0.6; bx += 3.5) {
        const shop = new THREE.Mesh(shopGeo, r() < 0.4 ? nightWindow : shopMat);
        shop.position.set(bx + 1.3, 1.45, zFront - s * 0.03);
        group.add(shop);
      }
      x += w;
    }
  }
}

/** Street lamp positions on both sidewalks (props are placed between them). */
export function lampPositions() {
  const out: { x: number; side: 1 | -1 }[] = [];
  for (const side of [-1, 1] as const) {
    for (let x = -ROAD.length / 2 + 10 + (side > 0 ? 0 : 12); x < ROAD.length / 2; x += 26) out.push({ x, side });
  }
  return out;
}

function addLamps(group: THREE.Group, world: World) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2f3337, metalness: 0.6, roughness: 0.5 });
  const bulbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd9a0, emissiveIntensity: 0 });
  world.nightMaterials.push(bulbMat);
  const pole = new THREE.CylinderGeometry(0.06, 0.08, 6, 10);
  const arm = new THREE.BoxGeometry(0.08, 0.08, 1.4);
  const head = new THREE.BoxGeometry(0.5, 0.1, 0.25);
  for (const { x, side: s } of lampPositions()) {
    const z = s * (ROAD.curbZ + 0.6);
    const p = new THREE.Mesh(pole, poleMat);
    p.position.set(x, 3 + ROAD.curbHeight, z);
    p.castShadow = true;
    const a = new THREE.Mesh(arm, poleMat);
    a.position.set(x, 6, z - s * 0.65);
    const hd = new THREE.Mesh(head, bulbMat);
    hd.position.set(x, 5.92, z - s * 1.3);
    group.add(p, a, hd);
  }
}
