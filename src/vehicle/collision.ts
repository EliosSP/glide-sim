import { ROAD, VEHICLE } from '../config';
import type { ParkedCar } from '../scene/parkingLayout';
import { footprint, pointPolygonDistance, polygonDistance, polygonsOverlap, rectPolygon, type Polygon, type Pose } from '../planner/geometry';

export type ContactKind = 'auto' | 'cordolo';

const PARKED_HALF_WIDTH = 0.9;
// Horizontal half-extent of a tyre at curb height: sqrt(r² − (r − h)²)
const TYRE_HALF_LEN = Math.sqrt(VEHICLE.wheelRadius ** 2 - (VEHICLE.wheelRadius - ROAD.curbHeight) ** 2);
const TYRE_HALF_WIDTH = VEHICLE.wheelWidth / 2;

interface Obstacle {
  x: number;
  poly: Polygon;
  kind: 'car' | 'object';
  id?: string;
}

export interface NearestObstacle {
  distance: number;
  kind: 'car' | 'object';
  behind: boolean; // obstacle centre behind the car centre
  point: [number, number]; // body corner closest to it
}

export class Collisions {
  private obstacles: Obstacle[];

  constructor(cars: ParkedCar[]) {
    this.obstacles = cars.map((c) => ({ x: c.x, poly: rectPolygon(c.x, c.z, c.length / 2, PARKED_HALF_WIDTH), kind: 'car' as const }));
  }

  /** Temporary or moving obstacle (an object that appears during a manoeuvre, a car of the traffic). */
  addObject(id: string, x: number, z: number, halfLen: number, halfWidth: number, kind: 'car' | 'object' = 'object') {
    this.removeObject(id);
    this.obstacles.push({ x, poly: rectPolygon(x, z, halfLen, halfWidth), kind, id });
  }

  removeObject(id: string) {
    this.obstacles = this.obstacles.filter((o) => o.id !== id);
  }

  /** Closest obstacle to the body, with the body corner nearest to it. */
  nearest(pose: Pose): NearestObstacle | null {
    const body = footprint(pose);
    const centre = pose.x + Math.cos(pose.heading) * 1.35;
    let best: NearestObstacle | null = null;
    for (const o of this.obstacles) {
      if (Math.abs(o.x - pose.x) > 9) continue;
      const d = polygonDistance(body, o.poly);
      if (best && d >= best.distance) continue;
      let corner = body[0];
      let cd = Infinity;
      for (const v of body) {
        const vd = pointPolygonDistance(v[0], v[1], o.poly);
        if (vd < cd) {
          cd = vd;
          corner = v;
        }
      }
      best = { distance: d, kind: o.kind, behind: o.x < centre, point: corner };
    }
    return best;
  }

  /** Returns the first contact for a vehicle pose, or null. */
  check(x: number, z: number, heading: number, steer: number): ContactKind | null {
    const pose = { x, z, heading };
    const body = footprint(pose);
    for (const o of this.obstacles) {
      if (Math.abs(o.x - x) > 8) continue;
      if (polygonsOverlap(body, o.poly)) return 'auto';
    }
    return curbMargin(pose, steer) < 0 ? 'cordolo' : null;
  }

  /** Smallest distance from the body to any parked car (m). */
  carClearance(pose: Pose) {
    const body = footprint(pose);
    let d = Infinity;
    for (const o of this.obstacles) {
      if (Math.abs(o.x - pose.x) > 9) continue;
      d = Math.min(d, polygonDistance(body, o.poly));
    }
    return d;
  }

  /** Smallest distance from the body to a moving car (traffic, the car waiting behind) (m). */
  movingCarClearance(pose: Pose) {
    const body = footprint(pose);
    let d = Infinity;
    for (const o of this.obstacles) {
      if (o.kind !== 'car' || !o.id || Math.abs(o.x - pose.x) > 9) continue;
      d = Math.min(d, polygonDistance(body, o.poly));
    }
    return d;
  }

  /** Distances from the body to the nearest car ahead and behind, for the final pose. */
  frontRearGaps(pose: Pose) {
    const body = footprint(pose);
    let front = Infinity;
    let rear = Infinity;
    for (const o of this.obstacles) {
      if (Math.abs(o.x - pose.x) > 9) continue;
      const d = polygonDistance(body, o.poly);
      if (o.x > pose.x + 1.35) front = Math.min(front, d);
      else rear = Math.min(rear, d);
    }
    return { front, rear };
  }
}

/** Distance between the tyres and the nearest curb (negative = touching). */
export function curbMargin(p: Pose, steer: number) {
  const c = Math.cos(p.heading);
  const s = Math.sin(p.heading);
  let m = Infinity;
  for (const [wx, front] of [[VEHICLE.wheelbase, true], [0, false]] as const) {
    for (const side of [-1, 1]) {
      const wz = (side * VEHICLE.track) / 2;
      const pz = p.z + s * wx + c * wz;
      const a = p.heading + (front ? steer : 0);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const cz = pz + sa * u * TYRE_HALF_LEN + ca * v * TYRE_HALF_WIDTH;
        m = Math.min(m, ROAD.curbZ - Math.abs(cz));
      }
    }
  }
  return m;
}

/** Distance from the right side of the body to the right curb face. */
export function bodyToCurb(p: Pose) {
  return ROAD.curbZ - Math.max(...footprint(p).map(([, z]) => z));
}
