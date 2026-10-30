import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { VEHICLE } from '../config';
import type { CarRig } from './carModel';

// Jacopo's cabin (car frame: x forward from the rear axle, y up, z right). Procedural, medium detail,
// inspired by a small modern EV: long low dashboard in textile, centre display on the dashboard,
// trimmed pillars, door panels, light headliner. Only seen from inside; no light bar here.

// Windscreen (side glass outline of the hatch style): bottom edge at x 1.88 / y 0.98, top at x 1.36 / y 1.40
const WS_BOTTOM = new THREE.Vector2(1.88, 0.98);
const WS_TOP = new THREE.Vector2(1.36, 1.4);
const INNER_HALF = 0.8; // inner half-width of the cabin (body half-width 0.9 minus the doors)

let mats: ReturnType<typeof makeMaterials> | null = null;

/** Fine woven fabric: grey noise with a light twill, tiled. */
function textile(base: number, seed: number) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const img = g.createImageData(128, 128);
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const twill = (x + y) % 4 < 2 ? 6 : -6;
      const v = base + twill + (rnd() - 0.5) * 22;
      const i = (y * 128 + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, v));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(14, 14);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeMaterials() {
  return {
    fabric: new THREE.MeshStandardMaterial({ map: textile(178, 3), roughness: 1 }), // dashboard top, door inserts
    dark: new THREE.MeshStandardMaterial({ color: 0x26292d, roughness: 0.8 }), // lower trim, console
    trim: new THREE.MeshStandardMaterial({ color: 0x45494f, roughness: 0.7 }), // pillars
    headliner: new THREE.MeshStandardMaterial({ color: 0xd5d3ce, roughness: 0.95 }),
    seat: new THREE.MeshStandardMaterial({ map: textile(196, 9), roughness: 1, color: 0xd8d6d2 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xc9cdd1, metalness: 0.9, roughness: 0.25 }),
    vent: new THREE.MeshStandardMaterial({ color: 0x111316, roughness: 0.6 }),
    wheel: new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.65 }),
    screenOff: new THREE.MeshBasicMaterial({ color: 0x050607 }),
  };
}

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.receiveShadow = true;
  parent.add(o);
  return o;
}

/** Profile (x, y) extruded across the cabin (z), centred. */
function across(pts: [number, number][], width: number) {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))), {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.015,
    bevelSize: 0.015,
    bevelSegments: 3,
    curveSegments: 6,
  });
  g.translate(0, 0, -width / 2);
  g.computeVertexNormals();
  return g;
}

/** Box between two points in the XY plane, at a given z (pillar trims). */
function beam(a: THREE.Vector2, b: THREE.Vector2, z: number, thick: number, depth: number, m: THREE.Material, parent: THREE.Object3D) {
  const o = mesh(new THREE.BoxGeometry(a.distanceTo(b), thick, depth), m, parent, (a.x + b.x) / 2, (a.y + b.y) / 2, z);
  o.rotation.z = Math.atan2(b.y - a.y, b.x - a.x);
  return o;
}

export function buildInterior(rig: CarRig) {
  const M = (mats ??= makeMaterials());
  const b = rig.body;

  // Floor
  mesh(new THREE.BoxGeometry(2.0, 0.06, INNER_HALF * 2), M.dark, b, 0.64, 0.27, 0);

  // Dashboard: soft textile top running from the windscreen base towards the driver, dark lower part
  const top: [number, number][] = [
    [WS_BOTTOM.x + 0.03, WS_BOTTOM.y - 0.02], [1.7, 0.975], [1.56, 0.955], [1.47, 0.93], [1.43, 0.89], [1.45, 0.84], [1.9, 0.84],
  ];
  mesh(across(top, INNER_HALF * 2 - 0.04), M.fabric, b);
  const lower: [number, number][] = [[1.45, 0.84], [1.47, 0.62], [1.58, 0.5], [1.9, 0.48], [1.9, 0.84]];
  mesh(across(lower, INNER_HALF * 2 - 0.04), M.dark, b);
  // Air vents: thin dark slots on the dashboard face, a chrome bar in each
  for (const z of [-0.62, -0.12, 0.12, 0.62]) {
    const w = Math.abs(z) > 0.3 ? 0.16 : 0.1;
    mesh(new THREE.BoxGeometry(0.02, 0.035, w), M.vent, b, 1.445, 0.865, z);
    mesh(new THREE.BoxGeometry(0.008, 0.005, w - 0.02), M.chrome, b, 1.435, 0.865, z);
  }

  // Centre display on the dashboard, slightly turned towards the driver (canvas texture assigned by the display module)
  const disp = new THREE.Group();
  // Stands on the dashboard (bottom edge just above it), right of the steering-wheel rim as seen from the eye
  disp.position.set(1.4, 1.0, 0.08);
  disp.rotation.y = -Math.PI / 2 - 0.12;
  const tilt = new THREE.Group();
  tilt.rotation.x = -0.18; // leaning back, towards the eyes
  disp.add(tilt);
  const housing = mesh(new RoundedBoxGeometry(0.335, 0.22, 0.03, 3, 0.012), M.dark, tilt, 0, 0, -0.017);
  housing.castShadow = true;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.1875), M.screenOff); // 16:10, like the canvas
  tilt.add(screen);
  b.add(disp);
  // Foot: the display stands on the dashboard top
  mesh(new RoundedBoxGeometry(0.08, 0.09, 0.12, 2, 0.02), M.dark, b, 1.47, 0.92, 0.08);
  rig.displayMesh = screen;

  // Centre tunnel with armrest and gear selector, between the seats
  mesh(new RoundedBoxGeometry(0.95, 0.26, 0.24, 3, 0.03), M.dark, b, 1.0, 0.42, 0);
  mesh(new RoundedBoxGeometry(0.32, 0.06, 0.2, 3, 0.025), M.fabric, b, 0.55, 0.62, 0);
  mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.06, 12), M.chrome, b, 1.22, 0.58, 0);

  // Seats (driver and passenger) and rear bench
  for (const z of [-0.37, 0.37]) {
    mesh(new RoundedBoxGeometry(0.5, 0.13, 0.5, 3, 0.04), M.seat, b, 0.78, 0.5, z);
    const back = mesh(new RoundedBoxGeometry(0.13, 0.64, 0.5, 3, 0.05), M.seat, b, 0.49, 0.87, z);
    back.rotation.z = -0.18;
    mesh(new RoundedBoxGeometry(0.1, 0.17, 0.27, 3, 0.04), M.seat, b, 0.41, 1.26, z);
  }
  mesh(new RoundedBoxGeometry(0.45, 0.14, 1.4, 3, 0.04), M.seat, b, -0.2, 0.5, 0);
  mesh(new RoundedBoxGeometry(0.12, 0.55, 1.4, 3, 0.04), M.seat, b, -0.42, 0.82, 0);

  // Door panels: dark lower part, textile insert, armrest, chrome handle, dark cap along the window line
  for (const s of [-1, 1]) {
    const z = s * (INNER_HALF + 0.005);
    mesh(new THREE.BoxGeometry(1.45, 0.42, 0.03), M.dark, b, 0.92, 0.55, z);
    mesh(new THREE.BoxGeometry(1.1, 0.2, 0.03), M.fabric, b, 0.95, 0.83, z - s * 0.005);
    mesh(new RoundedBoxGeometry(0.55, 0.05, 0.09, 3, 0.02), M.dark, b, 0.85, 0.71, z - s * 0.05);
    mesh(new RoundedBoxGeometry(0.11, 0.03, 0.02, 2, 0.01), M.chrome, b, 1.28, 0.86, z - s * 0.025);
    mesh(new THREE.BoxGeometry(1.5, 0.04, 0.07), M.dark, b, 0.9, 0.965, z - s * 0.02);
  }

  // Pillar trims (inside the painted pillars): thick A-pillars as on a real car
  const zP = 0.7;
  for (const s of [-1, 1]) {
    beam(WS_BOTTOM, WS_TOP.clone().setY(WS_TOP.y + 0.01), s * zP, 0.1, 0.09, M.trim, b);
    beam(new THREE.Vector2(0.55, 0.98), new THREE.Vector2(0.52, 1.42), s * zP, 0.1, 0.07, M.trim, b);
    beam(new THREE.Vector2(-0.58, 0.98), new THREE.Vector2(-0.47, 1.41), s * zP, 0.24, 0.07, M.trim, b);
  }

  // Headliner, overhead console, sun visors
  mesh(new THREE.BoxGeometry(1.85, 0.02, INNER_HALF * 2 - 0.06), M.headliner, b, 0.45, 1.39, 0);
  mesh(new RoundedBoxGeometry(0.22, 0.04, 0.28, 3, 0.015), M.dark, b, 1.18, 1.365, 0);
  for (const s of [-1, 1]) {
    const v = mesh(new RoundedBoxGeometry(0.16, 0.014, 0.36, 2, 0.006), M.headliner, b, 1.24, 1.37, s * 0.4);
    v.rotation.z = 0.12;
  }

  // Steering wheel: thick rim, three spokes, padded hub; tilt → face backwards → spin about its own axis
  const tiltW = new THREE.Group();
  tiltW.position.set(1.36, 0.97, VEHICLE.eye.z);
  tiltW.rotation.z = -0.42;
  const face = new THREE.Group();
  face.rotation.y = -Math.PI / 2;
  const spin = new THREE.Group();
  tiltW.add(face);
  face.add(spin);
  mesh(new THREE.TorusGeometry(0.185, 0.024, 16, 64), M.wheel, spin);
  mesh(new THREE.CylinderGeometry(0.075, 0.08, 0.05, 28).rotateX(Math.PI / 2), M.wheel, spin);
  for (const a of [-Math.PI / 2, 0.15, Math.PI - 0.15]) {
    const sp = mesh(new THREE.BoxGeometry(0.13, a === -Math.PI / 2 ? 0.05 : 0.04, 0.02), M.wheel, spin, Math.cos(a) * 0.115, Math.sin(a) * 0.115, 0);
    sp.rotation.z = a;
  }
  for (const s of [-1, 1]) mesh(new THREE.BoxGeometry(0.006, 0.035, 0.012), M.chrome, spin, s * 0.17, 0.012, 0.01);
  // Top marker so the rotation is readable
  mesh(new THREE.BoxGeometry(0.018, 0.03, 0.05), new THREE.MeshStandardMaterial({ color: 0xbfc5ca }), spin, 0, 0.185, 0);
  mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.3, 14).rotateX(Math.PI / 2), M.dark, face, 0, 0, -0.17);
  b.add(tiltW);
  rig.steeringSpin = spin;

  // Interior rear-view mirror: frameless, rounded, high on the windscreen under the overhead console
  const rm = new THREE.Group();
  rm.name = 'mirror-rear';
  rm.position.set(1.36, 1.3, 0);
  mesh(new RoundedBoxGeometry(0.025, 0.075, 0.26, 3, 0.02), M.dark, rm);
  const rmGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.062), new THREE.MeshBasicMaterial({ color: 0x222830 }));
  rmGlass.name = 'glass';
  rmGlass.rotation.y = -Math.PI / 2; // faces -X (backwards)
  rmGlass.position.set(-0.0135, 0, 0);
  rm.add(rmGlass);
  b.add(rm);
  mesh(new THREE.CylinderGeometry(0.01, 0.012, 0.06, 8), M.dark, b, 1.37, 1.355, 0);
  rig.rearMirror = rm;

  // Physical Park button under the display, on the dashboard face: round cap with a "P", lit ring when Glide is armed
  const btn = new THREE.Group();
  btn.position.set(1.452, 0.78, 0.08);
  btn.rotation.z = Math.PI / 2; // local +y points to the driver (-x)
  b.add(btn);
  mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.008, 28), M.dark, btn, 0, 0.002, 0); // bezel
  const ring = mesh(new THREE.TorusGeometry(0.0265, 0.0022, 8, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0f62fe }), btn, 0, 0.0065, 0);
  ring.visible = false;
  const cap = new THREE.Group();
  btn.add(cap);
  const pCanvas = document.createElement('canvas');
  pCanvas.width = pCanvas.height = 128;
  const pg = pCanvas.getContext('2d')!;
  pg.fillStyle = '#d9dde1';
  pg.fillRect(0, 0, 128, 128);
  pg.fillStyle = '#16191c';
  pg.font = '700 84px system-ui, sans-serif';
  pg.textAlign = 'center';
  pg.textBaseline = 'middle';
  pg.fillText('P', 64, 70);
  const pTex = new THREE.CanvasTexture(pCanvas);
  pTex.colorSpace = THREE.SRGBColorSpace;
  mesh(new THREE.CylinderGeometry(0.0235, 0.0235, 0.012, 28), new THREE.MeshStandardMaterial({ color: 0x2a2e33, roughness: 0.5 }), cap, 0, 0.008, 0);
  const pTop = new THREE.Mesh(new THREE.CircleGeometry(0.0225, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: pTex }));
  // Disc normal along +y (the button's axis, towards the driver); image right → car +z (driver's right), image up → car +y
  pTop.rotation.y = -Math.PI / 2;
  pTop.position.y = 0.0142;
  cap.add(pTop);
  rig.pButton = {
    cap: pTop,
    /** k: how far the cap is pushed in (0..1); active: the ring is lit. */
    set(k: number, active: boolean) {
      cap.position.y = -0.006 * k;
      ring.visible = active;
    },
  };
}

