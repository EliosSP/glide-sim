import type { VehicleState } from '../vehicle/kinematics';
import { bodyToCurb, type Collisions } from '../vehicle/collision';
import type { BarView } from '../mirrors/lightBar';
import { MAX_STEER, kappaOf, steerOf, type Pose } from '../planner/geometry';
import { chooseCounterSteer, counterSteerFor, finalZ, solveSwitch, startXFor, type ParkPlan } from '../planner/parallelPlanner';

export type AssistedPhase = 'positioning' | 'steer1' | 'reverse1' | 'steer2' | 'reverse2' | 'inside' | 'done';

export const PHASE_LABELS: Record<AssistedPhase, string> = {
  positioning: 'Posizionamento',
  steer1: 'Sterzata',
  reverse1: 'Retro',
  steer2: 'Controsterzo',
  reverse2: 'Retro finale',
  inside: 'Dentro lo spazio',
  done: 'Fine',
};

export interface AssistParams {
  notchTol: number; // fraction of the steering travel (± around the target)
  announceLead: number; // s
  pointTol: number; // m
  segments: number;
}

export const DEFAULT_ASSIST: AssistParams = { notchTol: 0.07, announceLead: 1.75, pointTol: 0.15, segments: 8 };

export type AssistEvent =
  | { type: 'phase'; phase: AssistedPhase; t: number }
  | { type: 'confirm'; side: 'left' | 'right'; t: number }
  | { type: 'pointReached'; side: 'left' | 'right'; t: number }
  | { type: 'over'; what: 'steer' | 'point'; t: number }
  | { type: 'steerError'; phase: AssistedPhase; error: number; t: number };

export interface AssistResult {
  seconds: number;
  overs: number;
  curbGap: number;
  frontGap: number;
  rearGap: number;
  steerErrors: number[];
}

const OFF: BarView = { kind: 'off' };
const STOPPED = 0.02;
const CONFIRM_HOLD = 0.3;
/** After "point reached", the next phase starts only once its blinks have been seen. */
const REACHED_HOLD = 0.6;

export class AssistedManeuver {
  phase: AssistedPhase = 'positioning';
  overs = 0;
  steerErrors: number[] = [];
  result: AssistResult | null = null;
  instruction = '';
  /** While reversing: curvature being driven and distance left to the next point (for the camera overlay). */
  guide: { kappa: number; remaining: number } | null = null;

  private t0: number;
  private range = 5;
  private needRange = true;
  private reachedAt: number | null = null;
  private inTargetSince: number | null = null;
  private confirmedAt: number | null = null;
  private wasOver = false;
  private steer2Target = 0;
  private stillSince: number | null = null;

  constructor(
    readonly plan: ParkPlan,
    private collisions: Collisions,
    private params: AssistParams,
    private emit: (e: AssistEvent) => void,
    now: number,
  ) {
    this.t0 = now;
    emit({ type: 'phase', phase: this.phase, t: now });
  }

  /**
   * Hand-over from the autonomous mode: continue from the current pose at a given step
   * (the car is stopped; "steer2" recomputes the counter-steer from where it is).
   */
  startFrom(phase: 'positioning' | 'steer1' | 'steer2', pose: Pose, now: number) {
    if (phase === 'steer2') this.steer2Target = chooseCounterSteer(pose, this.collisions) / MAX_STEER;
    this.needRange = phase === 'positioning';
    this.go(phase, now);
  }

  private go(phase: AssistedPhase, now: number) {
    this.phase = phase;
    this.reachedAt = null;
    this.inTargetSince = null;
    this.confirmedAt = null;
    this.wasOver = false;
    this.stillSince = null;
    this.emit({ type: 'phase', phase, t: now });
  }

  /** Returns the bar for each mirror. */
  update(car: VehicleState, now: number): { left: BarView; right: BarView } {
    const pose: Pose = { x: car.x, z: car.z, heading: car.heading };
    const stopped = Math.abs(car.speed) < STOPPED;
    const fillRight = Math.max(0, car.steer) / MAX_STEER;
    const fillLeft = Math.max(0, -car.steer) / MAX_STEER;
    const p = this.params;
    this.guide = null;

    switch (this.phase) {
      case 'positioning': {
        const d = startXFor(this.plan, car.z) - car.x; // > 0: still behind the point
        if (this.needRange) {
          this.range = clamp(Math.abs(d), 1, 5);
          this.needRange = false;
        }
        this.instruction = d > p.pointTol ? `Avanti ${d.toFixed(1)} m` : d < -p.pointTol ? `Indietro ${(-d).toFixed(1)} m` : 'Fermati qui';
        const view = this.countdown(d, now, 'right');
        if (Math.abs(d) <= p.pointTol && stopped && this.reachedFor(now)) this.go('steer1', now);
        return { left: OFF, right: view };
      }

      case 'steer1': {
        const target = this.plan.steer1 / MAX_STEER;
        const view = this.steering(fillRight, target, now, 'right');
        this.instruction = view.kind === 'steer' && view.inTarget ? 'Giusto: inizia la retro' : 'Gira il volante a destra fino alla tacca';
        if (car.speed < -0.05) {
          this.recordSteerError(fillRight - target, now);
          const k1 = car.steer > 0.02 ? kappaOf(car.steer) : kappaOf(this.plan.steer1);
          this.range = Math.max(0.5, solveSwitch(pose, k1, kappaOf(this.plan.steer2), finalZ()).remaining);
          this.go('reverse1', now);
        } else if (car.speed > 0.05) {
          this.needRange = true;
          this.go('positioning', now);
        }
        return { left: OFF, right: view };
      }

      case 'reverse1': {
        const k1 = car.steer > 0.02 ? kappaOf(car.steer) : kappaOf(this.plan.steer1);
        const sol = solveSwitch(pose, k1, kappaOf(this.plan.steer2), finalZ());
        const view = this.countdown(sol.remaining, now, 'right');
        this.guide = { kappa: k1, remaining: sol.remaining };
        this.instruction = sol.remaining > p.pointTol ? 'Retro: guarda lo specchietto destro' : sol.remaining < -p.pointTol ? 'Troppo indietro: vai avanti' : 'Fermati qui';
        // Pre-announce the counter-steer in the left mirror
        let left: BarView = OFF;
        const eta = sol.remaining / Math.max(Math.abs(car.speed), 0.4);
        if (sol.remaining > p.pointTol && eta <= p.announceLead) {
          const target = Math.min(1, Math.abs(steerOf(counterSteerFor(sol.switchPose, finalZ()))) / MAX_STEER);
          left = { kind: 'announce', target, tol: p.notchTol, alpha: 0.15 + 0.6 * (1 - eta / p.announceLead) };
        }
        if (Math.abs(sol.remaining) <= p.pointTol && stopped && this.reachedFor(now)) {
          this.steer2Target = chooseCounterSteer(pose, this.collisions) / MAX_STEER;
          this.go('steer2', now); // snap: right off, left on
        }
        return { left, right: view };
      }

      case 'steer2': {
        const view = this.steering(fillLeft, this.steer2Target, now, 'left');
        this.instruction = view.kind === 'steer' && view.inTarget ? 'Giusto: continua la retro' : 'Gira il volante a sinistra fino alla tacca';
        if (car.speed < -0.05) {
          this.recordSteerError(fillLeft - this.steer2Target, now);
          const k2 = car.steer < -0.02 ? kappaOf(car.steer) : -kappaOf(this.steer2Target * MAX_STEER);
          this.range = Math.max(0.5, car.heading / k2);
          this.go('reverse2', now);
        }
        return { left: view, right: OFF };
      }

      case 'reverse2': {
        const k2 = car.steer < -0.02 ? kappaOf(car.steer) : -kappaOf(this.steer2Target * MAX_STEER);
        const remaining = car.heading / k2; // > 0 while still angled towards the curb
        const view = this.countdown(remaining, now, 'left');
        this.guide = { kappa: k2, remaining };
        this.instruction = remaining > p.pointTol ? 'Retro: guarda lo specchietto sinistro' : remaining < -p.pointTol ? 'Troppo: vai avanti' : 'Fermati e raddrizza';
        if (Math.abs(remaining) <= p.pointTol && stopped && this.reachedFor(now)) this.go('inside', now);
        return { left: view, right: OFF };
      }

      case 'inside': {
        // Notch off; only parking sensors remain. "P" engages once stopped with the wheels straight.
        this.instruction = 'Raddrizza le ruote';
        const straight = Math.abs(car.steer) < 0.05 * MAX_STEER;
        if (stopped && straight) {
          this.stillSince ??= now;
          if (now - this.stillSince >= 1) this.finish(pose, now);
        } else {
          this.stillSince = null;
        }
        return { left: OFF, right: OFF };
      }

      case 'done':
        this.instruction = 'P inserita';
        return { left: OFF, right: OFF };
    }
  }

  private reachedFor(now: number) {
    return this.reachedAt !== null && now - this.reachedAt >= REACHED_HOLD;
  }

  private finish(pose: Pose, now: number) {
    const gaps = this.collisions.frontRearGaps(pose);
    this.result = {
      seconds: now - this.t0,
      overs: this.overs,
      curbGap: bodyToCurb(pose),
      frontGap: gaps.front,
      rearGap: gaps.rear,
      steerErrors: this.steerErrors,
    };
    this.instruction = 'P inserita';
    this.go('done', now);
  }

  private recordSteerError(error: number, now: number) {
    this.steerErrors.push(error);
    this.emit({ type: 'steerError', phase: this.phase, error, t: now });
  }

  /** "In motion" grammar: segments switching off towards the point; past it, dashed blinking. */
  private countdown(remaining: number, now: number, side: 'left' | 'right'): BarView {
    const p = this.params;
    const reached = Math.abs(remaining) <= p.pointTol;
    if (reached && this.reachedAt === null) {
      this.reachedAt = now;
      this.emit({ type: 'pointReached', side, t: now });
    } else if (!reached) {
      this.reachedAt = null;
    }
    const over = remaining < -p.pointTol;
    if (over && !this.wasOver) {
      this.overs++;
      this.emit({ type: 'over', what: 'point', t: now });
    }
    this.wasOver = over;
    const lit = reached || over ? 1 : Math.max(1, Math.ceil(clamp(remaining / this.range, 0, 1) * p.segments));
    return {
      kind: 'count',
      lit,
      total: p.segments,
      reached,
      blinkStart: this.reachedAt,
      overshoot: over ? clamp((-remaining - p.pointTol) / 1.0, 0.08, 1) : 0,
    };
  }

  /** "Stopped" grammar: bar follows the wheel up to the notch; in target → 2 blinks + confirmation. */
  private steering(fill: number, target: number, now: number, side: 'left' | 'right'): BarView {
    const tol = this.params.notchTol;
    const inTarget = Math.abs(fill - target) <= tol;
    if (inTarget) {
      this.inTargetSince ??= now;
      if (this.confirmedAt === null && now - this.inTargetSince >= CONFIRM_HOLD) {
        this.confirmedAt = now;
        this.emit({ type: 'confirm', side, t: now });
      }
    } else {
      this.inTargetSince = null;
      this.confirmedAt = null;
    }
    const over = fill > target + tol;
    if (over && !this.wasOver) {
      this.overs++;
      this.emit({ type: 'over', what: 'steer', t: now });
    }
    this.wasOver = over;
    return { kind: 'steer', fill, target, tol, inTarget: inTarget && this.confirmedAt !== null, blinkStart: this.confirmedAt };
  }
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
