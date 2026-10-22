import { describe, expect, it } from 'vitest';
import { DEFAULT_MAPPING, mapHead, mirrorInView, shape, type MappingParams } from './headMapping';
import { poseFromMatrix } from './headPose';
import { OneEuro } from './oneEuro';

const DEG = Math.PI / 180;
const P: MappingParams = { deadZone: 3, gainYaw: 4, gainPitch: 2 };

describe('dead zone and gain', () => {
  it('does not move inside the dead zone', () => {
    expect(mapHead({ yaw: 2.9, pitch: -2.9 }, P).yaw).toBeCloseTo(0, 9);
    expect(shape(-2.9, 3, 4)).toBe(0);
  });

  it('amplifies past the dead zone, keeping the sign (head right → view right = negative Views yaw)', () => {
    expect(mapHead({ yaw: 8, pitch: 0 }, P).yaw).toBeCloseTo(-(8 - 3) * 4 * DEG, 6);
    expect(mapHead({ yaw: -8, pitch: 0 }, P).yaw).toBeCloseTo((8 - 3) * 4 * DEG, 6);
  });

  it('applies the pitch gain (head up → view up)', () => {
    expect(mapHead({ yaw: 0, pitch: 7 }, P).pitch).toBeCloseTo((7 - 3) * 2 * DEG, 6);
  });

  it('defaults follow the first driving test', () => {
    expect(DEFAULT_MAPPING).toEqual({ deadZone: 0.5, gainYaw: 4.3, gainPitch: 2 });
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
