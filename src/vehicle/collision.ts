import { ROAD, VEHICLE } from '../config';
import type { ParkedCar } from '../scene/parkingLayout';

/** Oriented rectangle on the ground plane. */
interface OBB {
  cx: number;
  cz: number;
  hx: number; // half length along heading
  hz: number; // half width
  angle: number;
}

export type ContactKind = 'auto' | 'cordolo';

const PARKED_HALF_WIDTH = 0.9;
// Horizontal half-extent of a tyre at curb height: sqrt(r² − (r − h)²)
const TYRE_HALF_LEN = Math.sqrt(VEHICLE.wheelRadius ** 2 - (VEHICLE.wheelRadius - ROAD.curbHeight) ** 2);
const TYRE_HALF_WIDTH = VEHICLE.wheelWidth / 2;

export class Collisions {
  private obstacles: OBB[];

  constructor(cars: ParkedCar[]) {
    this.obstacles = cars.map((c) => ({ cx: c.x, cz: c.z, hx: c.length / 2, hz: PARKED_HALF_WIDTH, angle: 0 }));
  }

  /** Returns the first contact for a vehicle pose (rear-axle reference), or null. */
  check(x: number, z: number, heading: number, steer: number): ContactKind | null {
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const centre = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
    const ego: OBB = { cx: x + c * centre, cz: z + s * centre, hx: VEHICLE.length / 2, hz: VEHICLE.width / 2, angle: heading };
    for (const o of this.obstacles) {
      if (Math.abs(o.cx - ego.cx) > 6) continue;
      if (overlap(ego, o)) return 'auto';
    }

    // Tyres against both curbs
    const limit = ROAD.curbZ;
    for (const [wx, front] of [[VEHICLE.wheelbase, true], [0, false]] as const) {
      for (const side of [-1, 1]) {
        const wz = (side * VEHICLE.track) / 2;
        const pz = z + s * wx + c * wz;
        const a = heading + (front ? steer : 0);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const cz = pz + sa * u * TYRE_HALF_LEN + ca * v * TYRE_HALF_WIDTH;
          if (Math.abs(cz) > limit) return 'cordolo';
        }
      }
    }
    return null;
  }
}

function corners(b: OBB): [number, number][] {
  const c = Math.cos(b.angle);
  const s = Math.sin(b.angle);
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([u, v]) => [
    b.cx + c * u * b.hx - s * v * b.hz,
    b.cz + s * u * b.hx + c * v * b.hz,
  ]);
}

/** Separating axis test for two oriented rectangles. */
function overlap(a: OBB, b: OBB) {
  const ca = corners(a);
  const cb = corners(b);
  for (const ang of [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2]) {
    const ax = Math.cos(ang);
    const az = Math.sin(ang);
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const [x, z] of ca) {
      const p = x * ax + z * az;
      minA = Math.min(minA, p);
      maxA = Math.max(maxA, p);
    }
    for (const [x, z] of cb) {
      const p = x * ax + z * az;
      minB = Math.min(minB, p);
      maxB = Math.max(maxB, p);
    }
    if (maxA < minB || maxB < minA) return false;
  }
  return true;
}
