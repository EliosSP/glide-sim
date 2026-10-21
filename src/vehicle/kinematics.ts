import { DRIVE, VEHICLE } from '../config';

export type Gear = 'D' | 'R';

export interface DriveInput {
  throttle: boolean;
  brake: boolean;
  hardBrake: boolean;
  steerLeft: boolean;
  steerRight: boolean;
}

const DEG = Math.PI / 180;
export const MAX_STEER = VEHICLE.maxSteerDeg * DEG;

/** Kinematic bicycle model, reference point = rear axle centre. */
export class VehicleState {
  x = 0;
  z = 0;
  heading = 0; // rad, 0 = +X, positive turns towards +Z (right)
  speed = 0; // m/s, positive forward
  steer = 0; // road-wheel angle, rad, positive = right
  gear: Gear = 'D';
  wheelSpin = 0; // accumulated rolling angle, for visuals

  reset(x: number, z: number, heading: number) {
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.speed = 0;
    this.steer = 0;
    this.gear = 'D';
  }

  /** Steering-wheel angle in degrees (positive = clockwise/right). */
  get steeringWheelDeg() {
    return (this.steer / DEG) * VEHICLE.steeringRatio;
  }

  setGear(g: Gear): boolean {
    if (g === this.gear) return true;
    if (Math.abs(this.speed) > DRIVE.gearChangeMaxSpeed) return false;
    this.gear = g;
    this.speed = 0;
    return true;
  }

  step(input: DriveInput, dt: number) {
    const dir = this.gear === 'D' ? 1 : -1;
    const accel = this.gear === 'D' ? DRIVE.accelForward : DRIVE.accelReverse;

    let decel = DRIVE.coast;
    if (input.brake) decel = DRIVE.brake;
    if (input.hardBrake) decel = DRIVE.hardBrake;

    if (input.throttle && !input.brake && !input.hardBrake) {
      this.speed = clamp(this.speed + dir * accel * dt, -DRIVE.maxReverse, DRIVE.maxForward);
    } else {
      const s = Math.abs(this.speed) - decel * dt;
      this.speed = s > 0 ? Math.sign(this.speed) * s : 0;
    }

    // Steering: continuous while held. Slow self-alignment (caster) only when rolling forward,
    // so the angle holds when stopped and while reversing, as in a real car.
    const ds = Math.max(0, this.speed) * dt;
    if (input.steerLeft !== input.steerRight) {
      this.steer += (input.steerRight ? 1 : -1) * DRIVE.steerRateDeg * DEG * dt;
    } else if (this.steer !== 0) {
      const back = DRIVE.selfAlignDegPerMeter * DEG * ds;
      this.steer = Math.abs(this.steer) <= back ? 0 : this.steer - Math.sign(this.steer) * back;
    }
    this.steer = clamp(this.steer, -MAX_STEER, MAX_STEER);

    // Integrate
    const v = this.speed;
    this.x += v * Math.cos(this.heading) * dt;
    this.z += v * Math.sin(this.heading) * dt;
    this.heading += (v / VEHICLE.wheelbase) * Math.tan(this.steer) * dt;
    this.wheelSpin += (v * dt) / VEHICLE.wheelRadius;
  }
}

export function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
