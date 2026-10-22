import { VEHICLE } from '../config';

/** Rear-axle pose on the ground plane. heading 0 = +X, positive towards +Z (right). */
export interface Pose {
  x: number;
  z: number;
  heading: number;
}

export const MAX_STEER = (VEHICLE.maxSteerDeg * Math.PI) / 180;

export const kappaOf = (steer: number) => Math.tan(steer) / VEHICLE.wheelbase;
export const steerOf = (kappa: number) => Math.atan(kappa * VEHICLE.wheelbase);

/** Moves along a constant-curvature arc by signed distance s (negative = reverse). */
export function advance(p: Pose, kappa: number, s: number): Pose {
  if (Math.abs(kappa) < 1e-9) {
    return { x: p.x + Math.cos(p.heading) * s, z: p.z + Math.sin(p.heading) * s, heading: p.heading };
  }
  const h = p.heading + kappa * s;
  return {
    x: p.x + (Math.sin(h) - Math.sin(p.heading)) / kappa,
    z: p.z - (Math.cos(h) - Math.cos(p.heading)) / kappa,
    heading: h,
  };
}

/** Car body outline (4 corners) for a rear-axle pose. */
export function footprint(p: Pose, inflate = 0): [number, number][] {
  const c = Math.cos(p.heading);
  const s = Math.sin(p.heading);
  const back = -VEHICLE.rearOverhang - inflate;
  const front = VEHICLE.wheelbase + VEHICLE.frontOverhang + inflate;
  const half = VEHICLE.width / 2 + inflate;
  return [[front, half], [front, -half], [back, -half], [back, half]].map(([u, v]) => [
    p.x + c * u - s * v,
    p.z + s * u + c * v,
  ]);
}

export type Polygon = [number, number][];

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/** Distance from a point to a polygon's outline. */
export function pointPolygonDistance(px: number, pz: number, poly: Polygon) {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % poly.length];
    d = Math.min(d, segDist(px, pz, ax, az, bx, bz));
  }
  return d;
}

/** Separating axis test for convex polygons. */
export function polygonsOverlap(a: Polygon, b: Polygon) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, z1] = poly[i];
      const [x2, z2] = poly[(i + 1) % poly.length];
      const nx = z1 - z2;
      const nz = x2 - x1;
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
      for (const [x, z] of a) {
        const p = x * nx + z * nz;
        minA = Math.min(minA, p);
        maxA = Math.max(maxA, p);
      }
      for (const [x, z] of b) {
        const p = x * nx + z * nz;
        minB = Math.min(minB, p);
        maxB = Math.max(maxB, p);
      }
      if (maxA < minB || maxB < minA) return false;
    }
  }
  return true;
}

/** Distance between two convex polygons (0 if they overlap). */
export function polygonDistance(a: Polygon, b: Polygon) {
  if (polygonsOverlap(a, b)) return 0;
  let d = Infinity;
  for (const [p, q] of [[a, b], [b, a]]) {
    for (const [px, pz] of p) {
      for (let i = 0; i < q.length; i++) {
        const [ax, az] = q[i];
        const [bx, bz] = q[(i + 1) % q.length];
        d = Math.min(d, segDist(px, pz, ax, az, bx, bz));
      }
    }
  }
  return d;
}

/** Axis-aligned rectangle of a parked car. */
export function rectPolygon(cx: number, cz: number, halfLen: number, halfWidth: number): Polygon {
  return [
    [cx + halfLen, cz + halfWidth],
    [cx + halfLen, cz - halfWidth],
    [cx - halfLen, cz - halfWidth],
    [cx - halfLen, cz + halfWidth],
  ];
}
