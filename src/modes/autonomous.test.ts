import { describe, expect, it } from 'vitest';
import { START, TARGET_SPACE_LENGTH, VEHICLE } from '../config';
import { planParallel } from '../planner/parallelPlanner';
import { buildParkingRow } from '../scene/parkingLayout';
import { Collisions } from '../vehicle/collision';
import { AutoTimeline, autoBars, buildTimeline } from './autonomous';

const params = { lead: 1, announceLead: 2, segments: 6 };

describe('autoBars', () => {
  // Forward with the wheel straight, then steer and reverse
  const tl = new AutoTimeline({ x: 0, z: 0, heading: 0 }, 0, 'fluid');
  tl.addDrive(4, 'position');
  tl.addSteer(0.4, 'arc1');
  tl.addDrive(-3, 'arc1');
  const drive1 = tl.steps.find((s) => s.kind === 'drive')!;
  const reverse = tl.steps.find((s) => s.kind === 'drive' && s.dir < 0)!;

  it('lights both mirrors with the counting segments while driving straight', () => {
    const b = autoBars(tl, drive1.t0 + drive1.dur * 0.3, params);
    expect(b.left.kind).toBe('count');
    expect(b.right.kind).toBe('count');
  });

  it('lights only the steering side while reversing with the wheel turned', () => {
    const b = autoBars(tl, reverse.t0 + reverse.dur * 0.5, params);
    const lit = [b.left, b.right].filter((v) => v.kind !== 'off');
    expect(lit).toHaveLength(1);
  });
});

describe('buildTimeline', () => {
  it('ends in the middle of the target space, with the wheel straight', () => {
    const { cars, spaces } = buildParkingRow(TARGET_SPACE_LENGTH);
    const collisions = new Collisions(cars);
    const space = spaces.find((s) => s.isTarget)!;
    const plan = planParallel(space, collisions, START.z)!;
    const tl = buildTimeline({ x: 1.8, z: START.z, heading: 0 }, 0, 'position', plan, collisions, 'fluid');
    const { pose, steer } = tl.end;
    const rearGap = pose.x - VEHICLE.rearOverhang - space.xStart;
    const frontGap = space.xEnd - (pose.x + VEHICLE.wheelbase + VEHICLE.frontOverhang);
    expect(rearGap).toBeCloseTo(frontGap, 1);
    expect(steer).toBe(0);
  });
});
