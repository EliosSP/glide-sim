import { ROAD, VEHICLE } from '../config';
import type { FreeSpace } from '../scene/parkingLayout';
import { curbMargin, type Collisions } from '../vehicle/collision';
import { MAX_STEER, advance, kappaOf, steerOf, type Pose } from './geometry';

/** Body-to-curb distance aimed for at the end of the manoeuvre. */
export const FINAL_CURB_GAP = 0.2;
const MAX_SWITCH_HEADING = (-75 * Math.PI) / 180;
/** Closest the plan may end to the car behind. */
const MIN_REAR_GAP = 0.3;

/**
 * Geometric two-arc reverse parallel park:
 *   start (heading 0) → arc 1 with right lock (κ1 > 0) → switch → arc 2 with left lock (κ2 < 0) → straight, final.
 */
export interface ParkPlan {
  space: FreeSpace;
  start: Pose; // point where the driver stops and steers (start of steering)
  switchPose: Pose; // counter-steer point
  final: Pose; // straighten point = final position
  steer1: number; // rad, > 0 (right)
  steer2: number; // rad, < 0 (left)
  arc1: number; // length (m)
  arc2: number;
  minCarClearance: number; // m, along the whole path
  path: Pose[]; // samples from start to final, for display
}

export const finalZ = () => ROAD.curbZ - FINAL_CURB_GAP - VEHICLE.width / 2;

/**
 * From pose p reversing on arc κ1 then κ2, finds the switch heading so that arc 2 ends at heading 0 on z = zf.
 * Returns the switch pose, the remaining arc-1 length (signed: negative = already past) and the final pose.
 */
export function solveSwitch(p: Pose, k1: number, k2: number, zf: number) {
  const finalFrom = (hs: number) => {
    const sw = advance(p, k1, (hs - p.heading) / k1);
    return { sw, fin: advance(sw, k2, -hs / k2) };
  };
  // final z grows as the switch heading becomes more negative
  let lo = MAX_SWITCH_HEADING;
  let hi = Math.min(p.heading, 0) + 1e-6;
  if (finalFrom(hi).fin.z >= zf) {
    // Already past: solve backwards (driving forward along arc 1 would be needed)
    hi = Math.min(p.heading + 0.6, -1e-4);
    lo = p.heading;
  }
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (finalFrom(mid).fin.z < zf) hi = mid;
    else lo = mid;
  }
  const hs = (lo + hi) / 2;
  const { sw, fin } = finalFrom(hs);
  // remaining length to travel in reverse until the switch (>0 ahead of it)
  const remaining = (p.heading - hs) / k1;
  return { switchPose: sw, final: fin, remaining };
}

/** Curvature for arc 2 so that from pose p it ends at heading 0 on z = zf. */
export function counterSteerFor(p: Pose, zf: number) {
  const dz = zf - p.z;
  if (dz <= 1e-3 || p.heading >= -1e-4) return -kappaOf(MAX_STEER);
  return -(1 - Math.cos(p.heading)) / dz;
}

/**
 * Counter-steer angle chosen at the actual switch pose: as close as possible to ending on z = zf,
 * but never on a path that gets closer than `minClear` to a parked car or touches the curb.
 */
export function chooseCounterSteer(p: Pose, collisions: Collisions, minClear = 0.12) {
  const ideal = Math.min(1, Math.abs(steerOf(counterSteerFor(p, finalZ()))) / MAX_STEER);
  let best = { f: 1, clear: -Infinity };
  for (let f = ideal; f <= 1.0001; f += 0.02) {
    const k = -kappaOf(Math.min(f, 1) * MAX_STEER);
    const len = Math.abs(p.heading / k);
    let clear = Infinity;
    for (let s = 0; s <= len + 1e-6; s += 0.1) {
      const q = advance(p, k, -Math.min(s, len));
      if (curbMargin(q, steerOf(k)) < 0.02) {
        clear = -1;
        break;
      }
      clear = Math.min(clear, collisions.carClearance(q));
    }
    if (clear >= minClear) return Math.min(f, 1) * MAX_STEER;
    if (clear > best.clear) best = { f: Math.min(f, 1), clear };
  }
  return best.f * MAX_STEER;
}

function samplePath(start: Pose, k1: number, arc1: number, k2: number, arc2: number, step = 0.1) {
  const out: Pose[] = [];
  for (let s = 0; s <= arc1; s += step) out.push(advance(start, k1, -s));
  const sw = advance(start, k1, -arc1);
  for (let s = 0; s <= arc2; s += step) out.push(advance(sw, k2, -s));
  out.push(advance(sw, k2, -arc2));
  return out;
}

/**
 * Searches steering angles and final position in the space for the plan with the largest clearance.
 * startZ / startHeading: where the car is laterally when the assistance starts.
 */
export function planParallel(space: FreeSpace, collisions: Collisions, startZ: number): ParkPlan | null {
  const zf = finalZ();
  const centreOffset = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
  const centreX = (space.xStart + space.xEnd) / 2 - centreOffset;
  // Final rear-axle x: anywhere from close to the car behind...
  const rearMost = space.xStart + MIN_REAR_GAP + VEHICLE.rearOverhang;
  // ...up to close to the car in front (needed when something occupies the back of the space)
  const frontMost = space.xEnd - MIN_REAR_GAP - VEHICLE.wheelbase - VEHICLE.frontOverhang;
  const fractions = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0];
  let best: { plan: ParkPlan; score: number } | null = null;

  for (const f1 of fractions) {
    for (const f2 of fractions) {
      const k1 = kappaOf(f1 * MAX_STEER);
      const k2 = -kappaOf(f2 * MAX_STEER);
      const rel = solveSwitch({ x: 0, z: startZ, heading: 0 }, k1, k2, zf);
      if (Math.abs(rel.final.z - zf) > 0.02 || rel.remaining <= 0) continue;
      const arc1 = rel.remaining;
      const arc2 = Math.abs(rel.switchPose.heading / k2);
      for (let fx = rearMost; fx <= Math.max(rearMost, frontMost) + 1e-6; fx += 0.1) {
        const off = fx - centreX;
        const start: Pose = { x: fx - rel.final.x, z: startZ, heading: 0 };
        const path = samplePath(start, k1, arc1, k2, arc2);
        let minCar = Infinity;
        let ok = true;
        for (let i = 0; i < path.length; i++) {
          const p = path[i];
          const steer = i * 0.1 <= arc1 ? steerOf(k1) : steerOf(k2);
          if (curbMargin(p, steer) < 0.02) {
            ok = false;
            break;
          }
          minCar = Math.min(minCar, collisions.carClearance(p));
          if (minCar < 0.08) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        // Prefer clearance, then angles that leave room past the notch, then a centred final position
        const score = Math.min(minCar, 0.6) - 0.08 * (Math.abs(f1 - 0.8) + Math.abs(f2 - 0.8)) - 0.05 * Math.abs(off);
        if (!best || score > best.score) {
          const sw = advance(start, k1, -arc1);
          best = {
            score,
            plan: {
              space, start, switchPose: sw, final: advance(sw, k2, -arc2),
              steer1: steerOf(k1), steer2: steerOf(k2), arc1, arc2, minCarClearance: minCar, path,
            },
          };
        }
      }
    }
  }
  return best?.plan ?? null;
}

/** Start x for arc 1 from the current lateral position, keeping the plan's angles and final x. */
export function startXFor(plan: ParkPlan, z: number) {
  const k1 = kappaOf(plan.steer1);
  const k2 = kappaOf(plan.steer2);
  const rel = solveSwitch({ x: 0, z, heading: 0 }, k1, k2, finalZ());
  return plan.final.x - rel.final.x;
}
