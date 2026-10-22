// World frame: +X = driving direction of Jacopo's lane, +Y = up, +Z = right-hand side (curb side).
// Vehicle frame: origin at the rear axle centre on the ground, +X forward, +Z right.

export const VEHICLE = {
  length: 4.1,
  width: 1.8,
  wheelbase: 2.6,
  frontOverhang: 0.8,
  rearOverhang: 0.7,
  track: 1.55,
  wheelRadius: 0.32,
  wheelWidth: 0.21,
  maxSteerDeg: 35,
  steeringRatio: 15,
  // Driver eye, left-hand drive
  eye: { x: 0.85, y: 1.23, z: -0.37 }, // seat a bit back, as in a real driving position
};

export const DRIVE = {
  accelForward: 2.2, // m/s²
  accelReverse: 1.0,
  brake: 3.5,
  hardBrake: 8.0,
  coast: 0.4,
  maxForward: 13.9, // 50 km/h
  maxReverse: 1.5,
  steerRateDeg: 32, // road-wheel deg/s while a key is held
  selfAlignDegPerMeter: 8, // slow return, proportional to distance travelled (none when stopped)
  gearChangeMaxSpeed: 0.3,
};

export const ROAD = {
  laneWidth: 3.25,
  parkingWidth: 2.1,
  sidewalkWidth: 3.2,
  curbHeight: 0.15,
  length: 320,
  get curbZ() {
    return this.laneWidth + this.parkingWidth;
  },
};

// A single two-arc reverse manoeuvre with this car (2.6 m wheelbase, 35° lock) needs ≥ car + 2.0 m.
// Group decision: "tight" = car + 2.2 m; car + 1.0 m is shown as "doesn't fit in one manoeuvre".
export const TARGET_SPACE_LENGTH = VEHICLE.length + 2.2;
export const SHORT_SPACE_LENGTH = VEHICLE.length + 1.0;
/** Minimum extra length over the car for a single manoeuvre (from the planner, see above). */
export const ONE_MANOEUVRE_MIN_EXTRA = 2.0;
/** From this length a space counts as "wide" (autonomous recommended when well detected). */
export const WIDE_SPACE_MIN = VEHICLE.length + 2.5;

export const START = { x: -55, z: ROAD.laneWidth / 2 + 0.1, heading: 0 };

export const PHYSICS_DT = 1 / 120;
