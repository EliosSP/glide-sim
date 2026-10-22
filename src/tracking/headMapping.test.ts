import { describe, expect, it } from 'vitest';
import { DEFAULT_MAPPING, INITIAL_MAPPING_STATE, mapHead, mirrorInView, shape, type MappingParams, type MappingState, type MirrorGlance } from './headMapping';
import { poseFromMatrix } from './headPose';
import { OneEuro } from './oneEuro';

const DEG = Math.PI / 180;
const SNAPS: MappingParams = { ...DEFAULT_MAPPING, snapEnabled: true, deadZone: 3, gainYaw: 4, gainPitch: 2 };

/** Runs a sequence of head yaw values, one every `stepMs`, and returns the glance after each. */
function run(yaws: number[], p: MappingParams = SNAPS, stepMs = 33, key: MirrorGlance | null = null, pitch = 0) {
  let state: MappingState = INITIAL_MAPPING_STATE;
  return yaws.map((yaw, i) => {
    const out = mapHead({ yaw, pitch, tracking: true, key, now: i * stepMs }, state, p);
    state = out.state;
    return out;
  });
}

describe('dead zone and gain', () => {
  it('does not move inside the dead zone', () => {
    const [o] = run([2.9], SNAPS);
    expect(o.yaw).toBeCloseTo(0, 9);
    expect(shape(-2.9, 3, 4)).toBe(0);
  });

  it('amplifies past the dead zone, keeping the sign (head right → view right = negative Views yaw)', () => {
    const [o] = run([8], SNAPS);
    expect(o.yaw).toBeCloseTo(-(8 - 3) * 4 * DEG, 6);
    const [l] = run([-8], SNAPS);
    expect(l.yaw).toBeCloseTo((8 - 3) * 4 * DEG, 6);
  });

  it('applies the pitch gain (head up → view up)', () => {
    const out = mapHead({ yaw: 0, pitch: 7, tracking: true, key: null, now: 0 }, INITIAL_MAPPING_STATE, SNAPS);
    expect(out.pitch).toBeCloseTo((7 - 3) * 2 * DEG, 6);
  });
});

describe('mirror snaps', () => {
  it('are off by default (continuous view only)', () => {
    const outs = run(Array(20).fill(30), DEFAULT_MAPPING);
    expect(outs.every((o) => o.glance === null)).toBe(true);
  });

  it('snap only after the minimum time past the entry threshold', () => {
    const outs = run(Array(10).fill(17), SNAPS, 33); // 0, 33, 66, 99, 132 ms…
    expect(outs[3].glance).toBeNull(); // 99 ms < 120 ms
    expect(outs[4].glance).toBe('right'); // 132 ms
  });

  it('do not snap on a brief crossing shorter than the minimum time', () => {
    const outs = run([17, 17, 17, 5, 5, 17, 17, 17, 5]);
    expect(outs.every((o) => o.glance === null)).toBe(true);
  });

  it('hysteresis: oscillating between the exit and the entry thresholds never snaps', () => {
    const yaws = Array.from({ length: 120 }, (_, i) => 13.5 + 2 * Math.sin(i / 3)); // 11.5…15.5
    expect(run(yaws).every((o) => o.glance === null)).toBe(true);
  });

  it('hysteresis: once snapped, it holds between the thresholds and releases below the exit one', () => {
    const outs = run([...Array(6).fill(-20), -14, -12, -11.5, -10]);
    expect(outs[5].glance).toBe('left');
    expect(outs[6].glance).toBe('left');
    expect(outs[8].glance).toBe('left');
    expect(outs[9].glance).toBeNull();
  });

  it('snaps onto the rear-view mirror with the head up, slightly right', () => {
    const outs = run(Array(6).fill(5), SNAPS, 33, null, 12);
    expect(outs[5].glance).toBe('rear');
  });

  it('never snaps while the face is not tracked', () => {
    const out = mapHead({ yaw: 30, pitch: 0, tracking: false, key: null, now: 1000 }, { glance: 'right', pending: null, pendingSince: 0 }, SNAPS);
    expect(out.glance).toBeNull();
  });
});

describe('priority', () => {
  it('a held key wins over the head', () => {
    const outs = run(Array(8).fill(25), SNAPS, 33, 'left');
    expect(outs.every((o) => o.glance === 'left' && o.source === 'key')).toBe(true);
  });
});

describe('gaze from the view direction (continuous mode)', () => {
  const mirrors = { left: { yaw: 0.9, pitch: -0.2 }, right: { yaw: -1.2, pitch: -0.25 }, rear: { yaw: -0.6, pitch: 0.15 } };
  it('finds the mirror the view points at, within the tolerance', () => {
    expect(mirrorInView({ yaw: 0.95, pitch: -0.15 }, mirrors, 12)).toBe('left');
    expect(mirrorInView({ yaw: -1.1, pitch: -0.3 }, mirrors, 12)).toBe('right');
    expect(mirrorInView({ yaw: 0, pitch: 0 }, mirrors, 12)).toBeNull();
  });
});

describe('head pose from the face matrix', () => {
  /** Column-major 4×4 with the face's forward axis set to `f`. */
  const withForward = (f: [number, number, number]) => [1, 0, 0, 0, 0, 1, 0, 0, f[0], f[1], f[2], 0, 0, 0, 0, 1];
  it('looking at the camera is zero', () => {
    const p = poseFromMatrix(withForward([0, 0, 1]));
    expect(p.yaw).toBeCloseTo(0);
    expect(p.pitch).toBeCloseTo(0);
  });
  it('head turned to the user\'s right (nose towards the camera\'s −x) is positive yaw', () => {
    const a = 20 * DEG;
    expect(poseFromMatrix(withForward([-Math.sin(a), 0, Math.cos(a)])).yaw).toBeCloseTo(20);
  });
  it('head up is positive pitch', () => {
    const a = 10 * DEG;
    expect(poseFromMatrix(withForward([0, Math.sin(a), Math.cos(a)])).pitch).toBeCloseTo(10);
  });
});

describe('One Euro filter', () => {
  it('removes jitter when still and follows a fast move', () => {
    const f = new OneEuro(1.2, 0.18);
    let out = 0;
    let maxDev = 0;
    for (let i = 0; i < 90; i++) {
      out = f.filter(10 + (i % 2 ? 0.4 : -0.4), i / 30); // ±0.4° jitter at 30 Hz
      if (i > 30) maxDev = Math.max(maxDev, Math.abs(out - 10));
    }
    expect(maxDev).toBeLessThan(0.15);
    for (let i = 90; i < 96; i++) out = f.filter(30, i / 30); // 20° step
    expect(out).toBeGreaterThan(25); // within 200 ms
  });
});
