/**
 * Head pose → driver view, TrackIR style (the screen stays in front of the user, so the motion is
 * amplified): dead zone, then a continuous zone with a gain. Pure, easy to test.
 *
 * Input angles in degrees, calibrated: yaw > 0 head turned right, pitch > 0 head up.
 * Output view angles in radians, in the convention of `Views`: yaw > 0 looks LEFT, pitch > 0 up.
 */

export type MirrorGlance = 'left' | 'right' | 'rear';

export interface MappingParams {
  deadZone: number; // ° (both axes)
  gainYaw: number;
  gainPitch: number;
}

// Defaults from the first driving test (22/10/2026). [to be tuned with real users]
export const DEFAULT_MAPPING: MappingParams = { deadZone: 0.5, gainYaw: 4.3, gainPitch: 2 };

const DEG = Math.PI / 180;
const MAX_VIEW_YAW = 2.6; // rad, same limits as the mouse
const MIN_VIEW_PITCH = -1.0;
const MAX_VIEW_PITCH = 0.8;

/** Dead zone then gain, sign preserved. */
export function shape(angle: number, dead: number, gain: number) {
  const a = Math.abs(angle) - dead;
  return a <= 0 ? 0 : Math.sign(angle) * a * gain;
}

/** View direction (Views convention, radians) from the calibrated head angles. */
export function mapHead(head: { yaw: number; pitch: number }, p: MappingParams) {
  return {
    yaw: clamp(-shape(head.yaw, p.deadZone, p.gainYaw) * DEG, -MAX_VIEW_YAW, MAX_VIEW_YAW),
    pitch: clamp(shape(head.pitch, p.deadZone, p.gainPitch) * DEG, MIN_VIEW_PITCH, MAX_VIEW_PITCH),
  };
}

/**
 * Which mirror the view direction points at (Views convention, radians), within `tolDeg`:
 * used to log glances, since the view follows the head continuously.
 */
export function mirrorInView(
  view: { yaw: number; pitch: number },
  mirrors: Partial<Record<MirrorGlance, { yaw: number; pitch: number }>>,
  tolDeg: number,
): MirrorGlance | null {
  let best: MirrorGlance | null = null;
  let bestD = tolDeg * DEG;
  for (const [k, m] of Object.entries(mirrors) as [MirrorGlance, { yaw: number; pitch: number }][]) {
    const d = Math.hypot(view.yaw - m.yaw, view.pitch - m.pitch);
    if (d <= bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
