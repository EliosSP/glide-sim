/**
 * Head pose → driver view, TrackIR style (the screen stays in front of the user, so the motion is
 * amplified): dead zone, continuous zone with a gain, snap onto the mirrors with hysteresis and a
 * minimum time. Pure: all state is passed in and returned, so it is easy to test.
 *
 * Input angles in degrees, calibrated: yaw > 0 head turned right, pitch > 0 head up.
 * Output view angles in radians, in the convention of `Views`: yaw > 0 looks LEFT, pitch > 0 up.
 */

export type MirrorGlance = 'left' | 'right' | 'rear';

export interface MappingParams {
  deadZone: number; // ° (both axes)
  gainYaw: number;
  gainPitch: number;
  snapIn: number; // ° |yaw| to snap onto a side mirror
  snapOut: number; // ° |yaw| below which the snap is released (hysteresis)
  snapDelay: number; // ms the head must stay past the threshold
  rearEnabled: boolean;
  rearPitch: number; // ° head up to snap onto the rear-view mirror…
  rearYawMin: number; // …with yaw in [min, max]
  rearYawMax: number;
}

export const DEFAULT_MAPPING: MappingParams = {
  deadZone: 3,
  gainYaw: 4,
  gainPitch: 2,
  snapIn: 16,
  snapOut: 11,
  snapDelay: 120,
  rearEnabled: true,
  rearPitch: 10,
  rearYawMin: -4,
  rearYawMax: 14,
};

export interface MappingState {
  glance: MirrorGlance | null;
  pending: MirrorGlance | null; // candidate waiting for snapDelay
  pendingSince: number;
}

export const INITIAL_MAPPING_STATE: MappingState = { glance: null, pending: null, pendingSince: 0 };

export interface MappingInput {
  yaw: number; // ° head, calibrated
  pitch: number;
  tracking: boolean; // false: face lost / not tracking → no snap
  key: MirrorGlance | null; // Z / X / W held: always wins
  now: number; // ms
}

export interface MappingOutput {
  yaw: number; // rad, view (Views convention)
  pitch: number; // rad
  glance: MirrorGlance | null;
  source: 'head' | 'key' | null;
  state: MappingState;
}

const DEG = Math.PI / 180;
const MAX_VIEW_YAW = 2.6; // rad, same limits as the mouse
const MIN_VIEW_PITCH = -1.0;
const MAX_VIEW_PITCH = 0.8;

/** Dead zone then gain, sign preserved. */
export function shape(angle: number, dead: number, gain: number) {
  const a = Math.abs(angle) - dead;
  return a <= 0 ? 0 : Math.sign(angle) * a * gain;
}

/** Which mirror the head points at past the entry thresholds (null: none). */
function candidate(yaw: number, pitch: number, p: MappingParams): MirrorGlance | null {
  if (p.rearEnabled && pitch >= p.rearPitch && yaw >= p.rearYawMin && yaw <= p.rearYawMax) return 'rear';
  if (yaw >= p.snapIn) return 'right';
  if (yaw <= -p.snapIn) return 'left';
  return null;
}

/** Whether a snap already on is kept (exit thresholds, lower than the entry ones). */
function holds(g: MirrorGlance, yaw: number, pitch: number, p: MappingParams) {
  const hyst = p.snapIn - p.snapOut;
  if (g === 'right') return yaw > p.snapOut;
  if (g === 'left') return yaw < -p.snapOut;
  return pitch > p.rearPitch - hyst && yaw > p.rearYawMin - hyst && yaw < p.rearYawMax + hyst;
}

export function mapHead(input: MappingInput, state: MappingState, p: MappingParams): MappingOutput {
  const yaw = clamp(-shape(input.yaw, p.deadZone, p.gainYaw) * DEG, -MAX_VIEW_YAW, MAX_VIEW_YAW);
  const pitch = clamp(shape(input.pitch, p.deadZone, p.gainPitch) * DEG, MIN_VIEW_PITCH, MAX_VIEW_PITCH);

  // A held key wins over the head
  if (input.key) return { yaw, pitch, glance: input.key, source: 'key', state: { glance: null, pending: null, pendingSince: 0 } };
  if (!input.tracking) return { yaw, pitch, glance: null, source: null, state: { glance: null, pending: null, pendingSince: 0 } };

  let { glance, pending, pendingSince } = state;
  // Release: below the exit threshold
  if (glance && !holds(glance, input.yaw, input.pitch, p)) glance = null;
  // Snap: a (different) candidate past the entry threshold for at least snapDelay
  const c = candidate(input.yaw, input.pitch, p);
  if (c && c !== glance) {
    if (pending !== c) {
      pending = c;
      pendingSince = input.now;
    }
    if (input.now - pendingSince >= p.snapDelay) {
      glance = c;
      pending = null;
    }
  } else {
    pending = null;
  }
  return { yaw, pitch, glance, source: glance ? 'head' : null, state: { glance, pending, pendingSince } };
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
