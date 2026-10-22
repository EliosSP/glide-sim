import * as THREE from 'three';
import { VEHICLE } from '../config';
import type { Collisions, NearestObstacle } from '../vehicle/collision';
import type { BarView } from '../mirrors/lightBar';
import { MAX_STEER, advance, footprint, kappaOf, type Pose } from '../planner/geometry';
import { chooseCounterSteer, finalZ, solveSwitch, type ParkPlan } from '../planner/parallelPlanner';

export type SpeedProfile = 'fluid' | 'abrupt';
export type AutoStage = 'position' | 'arc1' | 'arc2' | 'end';

interface ProfileParams {
  vmax: number; // m/s
  amax: number; // m/s²
  steerRate: number; // rad/s at standstill
  pause: number; // s, between stopping and steering
}

const DEG = Math.PI / 180;
export const PROFILES: Record<SpeedProfile, ProfileParams> = {
  // Jerk-limited: soft starts and stops
  fluid: { vmax: 1.0, amax: 0.45, steerRate: 25 * DEG, pause: 0.5 },
  // Reproduces the "too fast and abrupt" experience: hard accelerations, fast wheel, no pauses
  abrupt: { vmax: 1.8, amax: 2.5, steerRate: 70 * DEG, pause: 0.05 },
};

interface StepBase {
  t0: number;
  dur: number;
  stage: AutoStage;
  pose0: Pose;
  steer0: number;
}
type Step =
  | (StepBase & { kind: 'pause' })
  | (StepBase & { kind: 'steer'; to: number; smooth: boolean })
  | (StepBase & { kind: 'drive'; kappa: number; length: number; dir: 1 | -1; profile: SpeedProfile; vpeak: number; apeak: number });

export interface AutoSample {
  pose: Pose;
  steer: number;
  speed: number; // signed
  accel: number;
  step: Step | null;
  stage: AutoStage;
}

/** Normalised motion u∈[0,1] → [position, velocity, acceleration] factors. */
function minJerk(u: number) {
  return [10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5, 30 * u * u * (1 - u) ** 2, 60 * u - 180 * u * u + 120 * u ** 3];
}

/**
 * The whole autonomous manoeuvre as a function of time. The car is moved exactly along it,
 * so the critical points announced in the preview are the ones met during the manoeuvre.
 */
export class AutoTimeline {
  steps: Step[] = [];
  total = 0;
  private pose: Pose;
  private steer: number;

  constructor(start: Pose, startSteer: number, readonly profile: SpeedProfile) {
    this.pose = { ...start };
    this.steer = startSteer;
  }

  get end() {
    return { pose: this.pose, steer: this.steer };
  }

  private push(step: Step) {
    this.steps.push(step);
    this.total += step.dur;
  }

  addSteer(to: number, stage: AutoStage) {
    if (Math.abs(to - this.steer) < 0.004) return;
    const p = PROFILES[this.profile];
    this.push({ kind: 'pause', t0: this.total, dur: p.pause, stage, pose0: { ...this.pose }, steer0: this.steer });
    const dur = Math.max(0.25, Math.abs(to - this.steer) / p.steerRate);
    this.push({ kind: 'steer', t0: this.total, dur, stage, pose0: { ...this.pose }, steer0: this.steer, to, smooth: this.profile === 'fluid' });
    this.steer = to;
  }

  /** Drives a signed distance with the current steering angle. */
  addDrive(length: number, stage: AutoStage) {
    if (Math.abs(length) < 0.03) return;
    const p = PROFILES[this.profile];
    const L = Math.abs(length);
    let dur: number;
    let vpeak: number;
    let apeak: number;
    if (this.profile === 'fluid') {
      dur = Math.max((1.875 * L) / p.vmax, Math.sqrt((5.7735 * L) / p.amax));
      vpeak = (1.875 * L) / dur;
      apeak = (5.7735 * L) / (dur * dur);
    } else if (L >= (p.vmax * p.vmax) / p.amax) {
      dur = L / p.vmax + p.vmax / p.amax;
      vpeak = p.vmax;
      apeak = p.amax;
    } else {
      dur = 2 * Math.sqrt(L / p.amax);
      vpeak = Math.sqrt(L * p.amax);
      apeak = p.amax;
    }
    const kappa = kappaOf(this.steer);
    const dir = length > 0 ? 1 : -1;
    this.push({ kind: 'drive', t0: this.total, dur, stage, pose0: { ...this.pose }, steer0: this.steer, kappa, length: L, dir, profile: this.profile, vpeak, apeak });
    this.pose = advance(this.pose, kappa, length);
  }

  stepAt(t: number): Step | null {
    for (const s of this.steps) if (t < s.t0 + s.dur) return s;
    return null;
  }

  sample(t: number): AutoSample {
    const step = this.stepAt(t);
    if (!step) return { pose: { ...this.pose }, steer: this.steer, speed: 0, accel: 0, step: null, stage: 'end' };
    const u = Math.min(1, Math.max(0, (t - step.t0) / step.dur));
    if (step.kind === 'pause') return { pose: step.pose0, steer: step.steer0, speed: 0, accel: 0, step, stage: step.stage };
    if (step.kind === 'steer') {
      const k = step.smooth ? u * u * (3 - 2 * u) : u;
      return { pose: step.pose0, steer: step.steer0 + (step.to - step.steer0) * k, speed: 0, accel: 0, step, stage: step.stage };
    }
    const T = step.dur;
    const L = step.length;
    let s: number, v: number, a: number;
    if (step.profile === 'fluid') {
      const [f, f1, f2] = minJerk(u);
      s = L * f;
      v = (L * f1) / T;
      a = (L * f2) / (T * T);
    } else {
      const tt = u * T;
      const ta = step.vpeak / step.apeak;
      if (tt < ta) {
        s = 0.5 * step.apeak * tt * tt;
        v = step.apeak * tt;
        a = step.apeak;
      } else if (tt > T - ta) {
        const r = T - tt;
        s = L - 0.5 * step.apeak * r * r;
        v = step.apeak * r;
        a = -step.apeak;
      } else {
        s = 0.5 * step.apeak * ta * ta + step.vpeak * (tt - ta);
        v = step.vpeak;
        a = 0;
      }
    }
    return { pose: advance(step.pose0, step.kappa, step.dir * s), steer: step.steer0, speed: step.dir * v, accel: a, step, stage: step.stage };
  }

  /** Start time of the first step of a stage (e.g. where the counter-steer begins). */
  stageStart(stage: AutoStage) {
    return this.steps.find((s) => s.stage === stage)?.t0 ?? null;
  }
}

/**
 * Builds the rest of the manoeuvre from the car's current state.
 * stage 'position': straight to the start point, then both arcs (plan from the planner);
 * 'arc1': finish arc 1 from here; 'arc2': counter-steer from here.
 */
export function buildTimeline(
  pose: Pose,
  steer: number,
  stage: Exclude<AutoStage, 'end'>,
  plan: ParkPlan,
  collisions: Collisions,
  profile: SpeedProfile,
): AutoTimeline {
  const tl = new AutoTimeline(pose, steer, profile);
  if (stage === 'position') {
    tl.addSteer(0, 'position');
    tl.addDrive((plan.start.x - pose.x) / Math.cos(pose.heading), 'position');
  }
  if (stage === 'position' || stage === 'arc1') {
    tl.addSteer(plan.steer1, 'arc1');
    const sol = solveSwitch(tl.end.pose, kappaOf(plan.steer1), kappaOf(plan.steer2), finalZ());
    tl.addDrive(-sol.remaining, 'arc1');
  }
  const counter = -chooseCounterSteer(tl.end.pose, collisions);
  tl.addSteer(counter, 'arc2');
  tl.addDrive(-Math.abs(tl.end.pose.heading / kappaOf(counter)), 'arc2');
  tl.addSteer(0, 'end');
  return tl;
}

// ---------- preview: critical points ----------

export interface CriticalPoint {
  kind: 'clearance' | 'fast' | 'sensor';
  t: number;
  position: THREE.Vector3;
  label: string;
}

export interface AutoPreview {
  path: THREE.Vector3[]; // car centre, every 0.1 s
  pathTimes: number[];
  fast: { from: number; to: number } | null; // time range of the most abrupt stretch
  points: CriticalPoint[];
  minClearance: NearestObstacle | null;
  seconds: number;
}

const centreOf = (p: Pose) => {
  const c = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
  return new THREE.Vector3(p.x + Math.cos(p.heading) * c, 0.05, p.z + Math.sin(p.heading) * c);
};

export function clearanceLabel(n: NearestObstacle) {
  const what = n.kind === 'car' ? `dall'auto ${n.behind ? 'dietro' : 'davanti'}` : "dall'ostacolo";
  return `${Math.round(n.distance * 100)} cm ${what}`;
}

export function previewOf(tl: AutoTimeline, collisions: Collisions, curbPoorlyVisible: boolean): AutoPreview {
  const path: THREE.Vector3[] = [];
  const pathTimes: number[] = [];
  let min: { n: NearestObstacle; t: number } | null = null;
  for (let t = 0; t <= tl.total + 1e-6; t += 0.1) {
    const s = tl.sample(t);
    path.push(centreOf(s.pose));
    pathTimes.push(t);
    // Only where the car moves: the static start pose is not a "point" of the manoeuvre
    if (s.step?.kind !== 'drive') continue;
    const n = collisions.nearest(s.pose);
    if (n && (!min || n.distance < min.n.distance)) min = { n, t };
  }
  const points: CriticalPoint[] = [];
  if (min) {
    points.push({
      kind: 'clearance',
      t: min.t,
      position: new THREE.Vector3(min.n.point[0], 0.05, min.n.point[1]),
      label: clearanceLabel(min.n),
    });
  }
  // The stretch with the hardest accelerations
  let fast: AutoPreview['fast'] = null;
  let best = 0;
  for (const st of tl.steps) {
    // hardest acceleration first; at equal acceleration, the faster stretch
    const score = st.kind === 'drive' ? st.apeak + 0.01 * st.vpeak : 0;
    if (st.kind !== 'drive' || score <= best) continue;
    best = score;
    fast = { from: st.t0, to: st.t0 + st.dur };
  }
  if (fast) {
    const mid = tl.sample((fast.from + fast.to) / 2);
    const st = tl.stepAt((fast.from + fast.to) / 2);
    const kmh = st && st.kind === 'drive' ? st.vpeak * 3.6 : 0;
    points.push({ kind: 'fast', t: (fast.from + fast.to) / 2, position: centreOf(mid.pose), label: `Tratto più rapido · ${kmh.toFixed(1)} km/h` });
  }
  // Where the sensors see poorly (scenario): at the counter-steer, near the curb
  if (curbPoorlyVisible) {
    const t = tl.stageStart('arc2');
    if (t !== null) {
      const fp = footprint(tl.sample(t).pose);
      const rearRight = fp[3];
      points.push({ kind: 'sensor', t, position: new THREE.Vector3(rearRight[0], 0.05, rearRight[1]), label: 'Qui vedo poco il cordolo' });
    }
  }
  return { path, pathTimes, fast, points, minClearance: min?.n ?? null, seconds: tl.total };
}

// ---------- mirrors in autonomous mode ----------

export interface AutoBarParams {
  lead: number; // s, feedforward: the bar shows the angle the wheel will have this much later
  announceLead: number; // s
  segments: number;
}

const sideOf = (steer: number): 'left' | 'right' | null => (steer > 0.01 ? 'right' : steer < -0.01 ? 'left' : null);

/**
 * Same grammar as the assisted mode, different meaning: no notch; the bar fills to the angle
 * the car will use ~1 s before the wheel turns; segments count down to the next change of behaviour.
 * The lit mirror is the side the car is steering towards.
 */
export function autoBars(tl: AutoTimeline, t: number, p: AutoBarParams): { left: BarView; right: BarView } {
  const out: { left: BarView; right: BarView } = { left: { kind: 'off' }, right: { kind: 'off' } };
  if (t >= tl.total) return out;
  const cur = tl.sample(t);
  const fut = tl.sample(Math.min(t + p.lead, tl.total));
  const steeringSoon = tl.steps.some((s) => s.kind === 'steer' && s.t0 < t + p.lead && s.t0 + s.dur > t);

  let side: 'left' | 'right' | null;
  if (steeringSoon || cur.step?.kind !== 'drive') {
    side = sideOf(fut.steer) ?? sideOf(cur.steer);
    if (side) out[side] = { kind: 'steer', fill: Math.abs(fut.steer) / MAX_STEER, target: null, tol: 0, inTarget: false, blinkStart: null };
  } else {
    const st = cur.step;
    const done = Math.abs(advanceDistance(st, t));
    const remaining = Math.max(0, st.length - done);
    side = sideOf(st.steer0) ?? sideOf(nextSteerTarget(tl, t)) ?? 'right';
    const lit = Math.max(1, Math.ceil((remaining / st.length) * p.segments));
    out[side] = { kind: 'count', lit, total: p.segments, reached: false, blinkStart: null, overshoot: 0 };
  }

  // Pre-announcement in the other mirror before the side changes
  const next = tl.steps.find((s) => s.kind === 'steer' && s.t0 > t && sideOf(s.to) && sideOf(s.to) !== side) as
    | (Step & { kind: 'steer' })
    | undefined;
  if (next && side) {
    const until = next.t0 - p.lead - t;
    if (until > 0 && until <= p.announceLead) {
      const other = side === 'left' ? 'right' : 'left';
      out[other] = { kind: 'announce', target: Math.abs(next.to) / MAX_STEER, tol: 0.03, alpha: 0.15 + 0.6 * (1 - until / p.announceLead) };
    }
  }
  return out;
}

function advanceDistance(st: Step & { kind: 'drive' }, t: number) {
  const u = Math.min(1, Math.max(0, (t - st.t0) / st.dur));
  if (st.profile === 'fluid') return st.length * minJerk(u)[0];
  const tt = u * st.dur;
  const ta = st.vpeak / st.apeak;
  if (tt < ta) return 0.5 * st.apeak * tt * tt;
  if (tt > st.dur - ta) return st.length - 0.5 * st.apeak * (st.dur - tt) ** 2;
  return 0.5 * st.apeak * ta * ta + st.vpeak * (tt - ta);
}

function nextSteerTarget(tl: AutoTimeline, t: number) {
  const s = tl.steps.find((x) => x.kind === 'steer' && x.t0 > t && Math.abs(x.to) > 0.01) as (Step & { kind: 'steer' }) | undefined;
  return s?.to ?? 0;
}

// ---------- runtime ----------

/** Moves the car exactly along a timeline. */
export class AutoRun {
  t = 0;
  minSeen: NearestObstacle | null = null;

  constructor(
    public timeline: AutoTimeline,
    public preview: AutoPreview,
  ) {}

  get finished() {
    return this.t >= this.timeline.total;
  }

  get stage(): AutoStage {
    return this.timeline.sample(this.t).stage;
  }

  advance(car: { x: number; z: number; heading: number; steer: number; speed: number; wheelSpin: number; gear: 'D' | 'R' }, dt: number, collisions: Collisions) {
    this.t = Math.min(this.timeline.total, this.t + dt);
    const s = this.timeline.sample(this.t);
    const moved = Math.hypot(s.pose.x - car.x, s.pose.z - car.z);
    car.wheelSpin += (Math.sign(s.speed) * moved) / VEHICLE.wheelRadius;
    car.x = s.pose.x;
    car.z = s.pose.z;
    car.heading = s.pose.heading;
    car.steer = s.steer;
    car.speed = s.speed;
    if (s.speed > 0.01) car.gear = 'D';
    else if (s.speed < -0.01) car.gear = 'R';
    if (s.step?.kind === 'drive') {
      const n = collisions.nearest(s.pose);
      if (n && (!this.minSeen || n.distance < this.minSeen.distance)) this.minSeen = n;
    }
  }
}
