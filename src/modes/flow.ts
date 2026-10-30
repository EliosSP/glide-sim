import * as THREE from 'three';
import { ONE_MANOEUVRE_MIN_EXTRA, VEHICLE } from '../config';
import type { FreeSpace } from '../scene/parkingLayout';
import type { VehicleState } from '../vehicle/kinematics';
import type { Collisions } from '../vehicle/collision';
import type { BarView } from '../mirrors/lightBar';
import { advance, type Pose } from '../planner/geometry';
import { planParallel, type ParkPlan } from '../planner/parallelPlanner';
import { AssistedManeuver, type AssistEvent, type AssistParams, type AssistedPhase } from './assisted';
import type { DriveInput } from '../vehicle/kinematics';
import {
  AutoRun, AutoTimeline, addCentring, autoBars, buildTimeline, previewOf,
  type AutoPreview, type SpeedProfile,
} from './autonomous';

export type Blinker = 'left' | 'right' | null;
export type ModeChoice = 'auto' | 'assisted';

export interface Evaluation {
  space: FreeSpace;
  fits: boolean;
  title: string;
  line: string;
}

export type DisplayScreen =
  | { kind: 'drive' }
  | { kind: 'approach'; selected: boolean }
  | { kind: 'assisted'; title: string; line: string; mirror: 'left' | 'right' | null; camera: boolean }
  | { kind: 'inside'; front: number; rear: number; line: string }
  | { kind: 'done'; title: string; lines: string[] }
  | { kind: 'autoPreview'; title: string; seconds: number; countdown: number | null }
  | { kind: 'autoRunning' }
  | { kind: 'autoStopped'; title: string; line: string; options: { key: string; label: string }[] };

/** What the reconstruction shows in autonomous mode: the trajectory, its critical points, the animated ghost. */
export interface ReconInfo {
  preview: AutoPreview;
  ghostT: number | null; // preview animation time on the timeline
  progressT: number; // part of the trajectory already driven
}

export interface DisplayModel {
  gear: string;
  speedKmh: number;
  blinker: Blinker;
  screen: DisplayScreen;
  toast: string | null;
}

/** Rear-camera overlay: predicted rear-wheel tracks up to the next point, and the point itself. */
export interface CameraGuide {
  left: THREE.Vector3[];
  right: THREE.Vector3[];
  target: [THREE.Vector3, THREE.Vector3] | null;
  bar: BarView;
  side: 'left' | 'right';
}

export type FlowEvent =
  | AssistEvent
  | { type: 'parkButton'; t: number }
  | { type: 'parkActive'; t: number }
  | { type: 'cancel'; from: string; t: number }
  | { type: 'modeChosen'; mode: ModeChoice; t: number }
  | { type: 'autoStart'; t: number }
  | { type: 'takeover'; t: number }
  | { type: 'switchToAssisted'; from: 'preview' | 'stopped'; t: number }
  | { type: 'lowConfidence'; t: number }
  | { type: 'trajectoryChange'; t: number }
  | { type: 'manual'; t: number }
  | { type: 'autoDone'; seconds: number; minClearance: number | null; t: number };

export interface FlowSettings {
  cameraWhileMoving: boolean; // display during movement (optional rear camera)
  curbPoorlyVisible: boolean; // scenario: sensors unsure about the curb
  speedProfile: SpeedProfile; // autonomous: fluid (default) / abrupt
  autoLead: number; // s, autonomous feedforward on the mirror bar
  assist: AssistParams; // notch tolerance, pre-announcement, segments (live from the panel)
}

type StopReason = 'driver' | 'confidence' | 'obstacle';
type BrakeReason = StopReason | 'cancel';
const PREVIEW_LOOP = 4.5; // s, length of the animated preview
const REPLAN_NOTICE = 3.5; // s, the new trajectory is shown before moving again
const CONFLICT_CLEARANCE = 0.1; // m, a newly arrived obstacle closer than this to the rest of the trajectory
const DEFAULT_OBSTACLE_LINE = "There is an obstacle on the path";

const OFF: BarView = { kind: 'off' };
const ON: BarView = { kind: 'on' };
const BAR_FADE_OUT = 1.0; // s: a light that has nothing more to say fades instead of dropping or snapping off
const BAR_FADE_IN = 0.15; // s
const BAR_END_FADE = 1.2; // s: after the last manoeuvre step

/** What a mirror light shows right now, and how bright (0..1). */
interface HeldBar {
  view: BarView;
  alpha: number;
}
const SLOW = 15 / 3.6; // approach view below this speed
const FAST = 20 / 3.6;
const PARK_MAX_SPEED = 10 / 3.6;

const PHASE_LINES: Record<AssistedPhase, { title: string; line: string; mirror: 'left' | 'right' | null }> = {
  positioning: { title: 'Assisted mode', line: 'Line up alongside the car ahead', mirror: 'right' },
  steer1: { title: 'Steer', line: 'Standing still, to the right', mirror: 'right' },
  reverse1: { title: 'Reverse', line: 'Follow the right mirror', mirror: 'right' },
  steer2: { title: 'Counter-steer', line: 'Standing still, to the left', mirror: 'left' },
  reverse2: { title: 'Reverse', line: 'Follow the left mirror', mirror: 'left' },
  inside: { title: 'Inside the space', line: 'Straighten the wheels', mirror: null },
  done: { title: 'Done', line: '', mirror: null },
};

/** Steps 1–5 and 11–12 of the experience, plus the assisted manoeuvre. */
export class GlideFlow {
  screen:
    | 'drive' | 'approach' | 'assisted' | 'assistBlocked' | 'done'
    | 'autoPreview' | 'autoRunning' | 'autoStopped' | 'autoReplan' = 'drive';
  blinker: Blinker = null;
  chosen: FreeSpace | null = null;
  locked = false;
  /** The space is chosen by a touch (video); otherwise the nearest free space is the chosen one. */
  requireSelection = false;
  selected = false;
  evaluation: Evaluation | null = null;
  private evalKey = '';
  private barHold: { left: HeldBar; right: HeldBar; at: number } | null = null;
  maneuver: AssistedManeuver | null = null;
  guide: CameraGuide | null = null;
  /** Spaces where the car fits in one manoeuvre (from the lane), for the reconstruction colours. */
  readonly fits = new Map<string, boolean>();

  private toast: { text: string; until: number } | null = null;
  private toastScreen: GlideFlow['screen'] = 'drive';
  private doneInfo: { title: string; lines: string[] } | null = null;
  private contactsAtStart = 0;
  private lastPose: Pose = { x: 0, z: 0, heading: 0 };

  // Autonomous mode
  auto: AutoRun | null = null;
  private autoPlan: ParkPlan | null = null;
  private previewStart = 0;
  private autoStartedAt = 0;
  private braking: BrakeReason | null = null; // stopping before entering the stopped state (or after a cancel)
  private replanAfterStop = false;
  private stopReason: StopReason | null = null;
  private stopPose: Pose | null = null;
  private replanUntil = 0;
  private lowConfidenceShown = false;
  private obstacleLine = DEFAULT_OBSTACLE_LINE;
  private nowForDisplay = 0;

  constructor(
    private spaces: FreeSpace[],
    private collisions: Collisions,
    public settings: FlowSettings,
    private emit: (e: FlowEvent) => void,
    laneZ: number,
  ) {
    for (const s of spaces) this.fits.set(s.id, planParallel(s, collisions, laneZ) !== null);
  }

  get isSelected() {
    return !this.requireSelection || this.selected;
  }

  reset() {
    this.selected = false;
    this.evalKey = '';
    this.screen = 'drive';
    this.blinker = null;
    this.chosen = null;
    this.locked = false;
    this.evaluation = null;
    this.maneuver = null;
    this.toast = null;
    this.doneInfo = null;
    this.auto = null;
    this.autoPlan = null;
    this.braking = null;
    this.replanAfterStop = false;
    this.stopReason = null;
    this.lowConfidenceShown = false;
    this.obstacleLine = DEFAULT_OBSTACLE_LINE;
  }

  /** Short message on the display (e.g. scenario changed). */
  notice(text: string, now: number) {
    this.say(text, now);
  }

  private say(text: string, now: number) {
    this.toast = { text, until: now + 3 };
    this.toastScreen = this.screen;
  }

  // ---------- inputs ----------

  onBlinker(side: 'left' | 'right', car: VehicleState, now: number) {
    this.blinker = this.blinker === side ? null : side;
    void car;
    void now;
  }

  /** Touch on the free space (the blue one): it becomes the chosen space. Only needed with requireSelection. */
  select() {
    if (this.screen !== 'approach' || !this.chosen) return;
    this.selected = true;
    this.locked = true;
  }

  onParkButton(car: VehicleState, now: number, contacts: number) {
    this.emit({ type: 'parkButton', t: now });
    if (this.screen === 'autoRunning' || this.screen === 'autoReplan' || this.screen === 'autoStopped') return this.cancelAuto(car, now);
    if (this.screen === 'assisted' || this.screen === 'assistBlocked' || this.screen === 'autoPreview') {
      this.maneuver = null;
      this.auto = null;
      this.screen = 'approach';
      this.say('Glide cancelled · you are in control', now);
      return;
    }
    if (!this.evaluation) return this.say(this.requireSelection && !this.selected ? 'Tap a free space first' : 'No free space nearby', now);
    if (!this.evaluation.fits) return this.say('This space does not fit: choose another', now);
    if (Math.abs(car.speed) > PARK_MAX_SPEED) return this.say('Slow down to activate Glide', now);
    // P arms Glide (lights on both mirrors) and goes straight to the preview of the autonomous manoeuvre
    this.contactsAtStart = contacts;
    this.emit({ type: 'parkActive', t: now });
    this.startPreview(car, now);
  }

  /** P during the autonomous manoeuvre: firm stop, Glide off, back to the approach; the driver has control. */
  private cancelAuto(car: VehicleState, now: number) {
    this.emit({ type: 'cancel', from: this.screen, t: now });
    this.braking = Math.abs(car.speed) > 0.02 ? 'cancel' : null;
    this.auto = null;
    this.autoPlan = null;
    this.maneuver = null;
    this.replanAfterStop = false;
    this.stopReason = null;
    this.stopPose = null;
    this.evaluation = null;
    this.locked = false;
    this.blinker = null;
    this.screen = 'approach';
    this.say('Glide cancelled · you are in control', now);
  }

  /** A1: animated preview of the whole trajectory, with its critical points. */
  private startPreview(car: VehicleState, now: number) {
    if (!this.evaluation) return;
    const plan = planParallel(this.evaluation.space, this.collisions, car.z);
    if (!plan) return this.say("Can't plan the manoeuvre from here", now);
    this.emit({ type: 'modeChosen', mode: 'auto', t: now });
    this.autoPlan = plan;
    const pose = { x: car.x, z: car.z, heading: car.heading };
    const tl = buildTimeline(pose, car.steer, 'position', plan, this.collisions, this.settings.speedProfile);
    this.auto = new AutoRun(tl, previewOf(tl, this.collisions, this.settings.curbPoorlyVisible));
    this.lowConfidenceShown = false;
    this.previewStart = now;
    this.screen = 'autoPreview';
  }

  private startAssisted(plan: ParkPlan, car: VehicleState, now: number, from: 'positioning' | 'steer1' | 'steer2') {
    this.maneuver = new AssistedManeuver(plan, this.collisions, this.settings.assist, (e) => this.emit(e), now);
    if (from !== 'positioning') this.maneuver.startFrom(from, { x: car.x, z: car.z, heading: car.heading }, now);
    this.auto = null;
    this.screen = 'assisted';
  }

  /** "Avvia" (Enter): start after the preview, or resume after a takeover (I1). */
  onStart(car: VehicleState, now: number) {
    if (this.screen === 'autoPreview' && this.auto) {
      this.screen = 'autoRunning';
      this.autoStartedAt = now;
      this.emit({ type: 'autoStart', t: now });
    } else if (this.screen === 'autoStopped' && this.stopReason === 'driver') {
      if (this.rebuild(car)) this.screen = 'autoRunning';
      else this.stopWith('obstacle', car);
    }
  }

  /** "Passa all'assistito" (A): from the preview (step 6), or from where the car stopped. */
  onSwitchToAssisted(car: VehicleState, now: number) {
    if (this.screen === 'autoPreview' && this.autoPlan) {
      this.emit({ type: 'switchToAssisted', from: 'preview', t: now });
      const plan = planParallel(this.autoPlan.space, this.collisions, car.z) ?? this.autoPlan;
      return this.startAssisted(plan, car, now, 'positioning');
    }
    if (this.screen === 'autoStopped' && this.auto && this.autoPlan) {
      this.emit({ type: 'switchToAssisted', from: 'stopped', t: now });
      const stage = this.auto.stage;
      if (stage === 'position') {
        const plan = planParallel(this.autoPlan.space, this.collisions, car.z) ?? this.autoPlan;
        return this.startAssisted(plan, car, now, 'positioning');
      }
      this.startAssisted(this.autoPlan, car, now, stage === 'arc1' ? 'steer1' : 'steer2');
    }
  }

  /** "Finisco io a mano" (M). */
  onManual(now: number) {
    if (this.screen !== 'autoStopped' && this.screen !== 'assistBlocked') return;
    this.emit({ type: 'manual', t: now });
    this.toManual(now);
  }

  private toManual(now: number) {
    this.auto = null;
    this.screen = 'drive';
    this.blinker = null;
    this.locked = false;
    this.evaluation = null;
    this.say('You are in control', now);
  }

  /** I3: an obstacle appeared (already added to the collisions): stop, re-plan, announce, continue. */
  onObstacle(car: VehicleState, now: number, line = DEFAULT_OBSTACLE_LINE) {
    this.obstacleLine = line;
    if (this.screen === 'autoPreview' && this.auto) {
      if (this.rebuild(car)) {
        this.previewStart = now;
        this.emit({ type: 'trajectoryChange', t: now });
      } else {
        this.stopWith('obstacle', car);
      }
    } else if (this.screen === 'autoRunning' && !this.braking) {
      this.braking = 'obstacle';
      this.replanAfterStop = true;
    }
  }

  /**
   * A moving actor has stopped near the manoeuvre (e.g. the car waiting behind): if it is in the
   * way of the rest of the trajectory, handle it like I3; otherwise only refresh the preview's distances.
   */
  onTrafficSettled(car: VehicleState, now: number, line: string) {
    if (this.screen === 'assisted' && this.maneuver) return this.checkAssisted(car, now, line);
    const run = this.auto;
    if (!run || (this.screen !== 'autoPreview' && this.screen !== 'autoRunning') || this.braking) return;
    const from = this.screen === 'autoPreview' ? 0 : run.t;
    let clear = Infinity;
    for (let t = from; t <= run.timeline.total; t += 0.1) {
      const s = run.timeline.sample(t);
      if (s.step?.kind === 'drive') clear = Math.min(clear, this.collisions.carClearance(s.pose));
    }
    if (clear < CONFLICT_CLEARANCE) return this.onObstacle(car, now, line);
    if (this.screen === 'autoPreview') {
      const updated = new AutoRun(run.timeline, previewOf(run.timeline, this.collisions, this.settings.curbPoorlyVisible && !this.lowConfidenceShown));
      this.auto = updated;
    }
  }

  /**
   * Assisted, before reversing: if the planned path is no longer free, re-plan from here
   * (positioning starts again); if no manoeuvre fits, say so and stop the assistance.
   * While reversing, the mirror countdown already ends before the obstacle.
   */
  private checkAssisted(car: VehicleState, now: number, line: string) {
    const m = this.maneuver!;
    if ((m.phase !== 'positioning' && m.phase !== 'steer1') || m.pathClear()) return;
    const plan = planParallel(m.plan.space, this.collisions, car.z);
    if (plan) return this.startAssisted(plan, car, now, 'positioning');
    this.obstacleLine = line;
    this.maneuver = null;
    this.screen = 'assistBlocked';
  }

  /** Pedestrian or cyclist close to the car. Behaviour NOT yet defined by the group: intentionally empty. */
  onHazard(e: { kind: 'cyclist' | 'pedestrian'; distance: number; t: number }) {
    void e;
  }

  /** Who moves the car this physics step. */
  autoControl(): 'auto' | 'braking' | 'hold' | null {
    if (this.braking) return 'braking';
    if (this.screen === 'autoReplan') return 'hold';
    return this.screen === 'autoRunning' ? 'auto' : null;
  }

  /** Re-plan notice: Glide holds the car still; steering or braking counts as a takeover (I1). */
  holdStep(car: VehicleState, input: DriveInput, now: number) {
    car.speed = 0;
    if (input.brake || input.hardBrake || input.steerLeft || input.steerRight) {
      this.emit({ type: 'takeover', t: now });
      this.stopWith('driver', car);
    }
  }

  /** Brake input while stopping: immediate when the driver intervened, Glide's own stop otherwise. */
  brakeInput(input: DriveInput): DriveInput {
    return { ...input, throttle: false, brake: true, hardBrake: this.braking === 'driver' || this.braking === 'cancel' };
  }

  autoStep(car: VehicleState, dt: number, input: DriveInput, now: number) {
    const run = this.auto!;
    // I1: any steering or braking input stops the car at once
    if (input.brake || input.hardBrake || input.steerLeft || input.steerRight) {
      this.braking = 'driver';
      this.emit({ type: 'takeover', t: now });
      return;
    }
    // I2: Glide loses confidence where the preview said the sensors see poorly
    if (this.settings.curbPoorlyVisible && !this.lowConfidenceShown) {
      const t2 = run.timeline.stageStart('arc2');
      if (t2 !== null && run.t + dt >= t2) {
        run.t = t2; // stopped at the end of arc 1, right before the counter-steer
        this.lowConfidenceShown = true;
        this.emit({ type: 'lowConfidence', t: now });
        this.stopWith('confidence', car);
        return;
      }
    }
    run.advance(car, dt, this.collisions);
    if (run.finished) this.finishAuto(now);
  }

  /** Something blocked the car: stop and offer the options. */
  autoHalt(car: VehicleState) {
    car.speed = 0;
    this.braking = null;
    this.stopWith('obstacle', car);
  }

  private stopWith(reason: StopReason, car: VehicleState) {
    this.stopReason = reason;
    this.stopPose = { x: car.x, z: car.z, heading: car.heading };
    this.screen = 'autoStopped';
  }

  /** Rest of the manoeuvre from where the car is now (resume, re-plan). */
  private rebuild(car: VehicleState): boolean {
    if (!this.auto || !this.autoPlan) return false;
    const pose = { x: car.x, z: car.z, heading: car.heading };
    const stage = this.auto.stage;
    let tl: AutoTimeline;
    if (stage === 'end') {
      tl = new AutoTimeline(pose, car.steer, this.settings.speedProfile);
      tl.addSteer(0, 'end');
      addCentring(tl, this.autoPlan.space);
    } else {
      if (stage === 'position') {
        const plan = planParallel(this.autoPlan.space, this.collisions, car.z);
        if (!plan) return false;
        this.autoPlan = plan;
      }
      tl = buildTimeline(pose, car.steer, stage, this.autoPlan, this.collisions, this.settings.speedProfile);
    }
    const preview = previewOf(tl, this.collisions, this.settings.curbPoorlyVisible && !this.lowConfidenceShown);
    if (preview.minClearance && preview.minClearance.distance < 0.05) return false;
    const run = new AutoRun(tl, preview);
    run.minSeen = this.auto.minSeen;
    this.auto = run;
    return true;
  }

  private finishAuto(now: number) {
    const run = this.auto!;
    const seen = run.minSeen;
    const seconds = Math.round(now - this.autoStartedAt);
    this.emit({ type: 'autoDone', seconds, minClearance: seen?.distance ?? null, t: now });
    this.doneInfo = { title: 'Parked', lines: ['Control is back with you'] };
    this.screen = 'done';
    this.blinker = null;
    this.locked = false;
    this.evaluation = null;
  }

  /** Plan of the running autonomous manoeuvre (used to place the I3 test obstacle). */
  get autoPlanNow() {
    return this.auto ? this.autoPlan : null;
  }

  /** Data for the reconstruction while in autonomous mode. */
  reconInfo(now: number): ReconInfo | null {
    if (!this.auto) return null;
    const p = this.auto.preview;
    if (this.screen === 'autoPreview' || this.screen === 'autoReplan') {
      const u = ((now - this.previewStart) % PREVIEW_LOOP) / PREVIEW_LOOP;
      return { preview: p, ghostT: u * p.seconds, progressT: 0 };
    }
    if (this.screen === 'autoRunning' || this.screen === 'autoStopped') return { preview: p, ghostT: null, progressT: this.auto.t };
    return null;
  }

  // ---------- logic ----------

  private evaluate(space: FreeSpace, laneZ: number): Evaluation {
    const len = space.xEnd - space.xStart;
    const extra = Math.round((len - VEHICLE.length) * 100);
    const plan = planParallel(space, this.collisions, laneZ);
    if (plan) return { space, fits: true, title: 'Fits', line: `${extra} cm longer than your car` };
    if (extra <= 0) return { space, fits: false, title: 'Does not fit', line: `${-extra} cm shorter than your car` };
    return {
      space,
      fits: false,
      title: 'Does not fit in one manoeuvre',
      line: `${extra} cm longer than your car, ${Math.round(ONE_MANOEUVRE_MIN_EXTRA * 100)} needed`,
    };
  }

  /** Free space nearest to the car, among those just behind it or ahead. */
  private nearestSpace(x: number) {
    const centre = x + 1.35;
    let best: FreeSpace | null = null;
    let bestD = Infinity;
    for (const s of this.spaces) {
      const c = (s.xStart + s.xEnd) / 2;
      if (c < centre - 8 || c > centre + 25) continue;
      const d = Math.abs(c - centre);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  update(car: VehicleState, now: number, contacts: number): { bars: { left: BarView; right: BarView }; barAlpha: { left: number; right: number }; display: DisplayModel } {
    const speed = Math.abs(car.speed);
    const pose: Pose = { x: car.x, z: car.z, heading: car.heading };
    this.lastPose = pose;
    // After P the mirror lights are on and steady, until the manoeuvre gives them something to show
    const armed = this.screen === 'autoPreview' || this.screen === 'autoReplan' || this.screen === 'autoStopped' || this.screen === 'autoRunning';
    let bars: { left: BarView; right: BarView } = armed ? { left: ON, right: ON } : { left: OFF, right: OFF };
    this.guide = null;

    // Step 1–2: approach view and automatic highlight of the nearest space
    if (this.screen === 'drive' && speed < SLOW && this.nearestSpace(car.x)) this.screen = 'approach';
    if (this.screen === 'approach' && speed > FAST && !this.blinker) this.screen = 'drive';
    if ((this.screen === 'approach' || this.screen === 'drive') && !this.locked) this.chosen = this.nearestSpace(car.x);
    // The space is evaluated as soon as it is chosen: no blinker, nothing written on the display
    if (this.screen === 'approach' && this.chosen && this.isSelected) {
      const key = `${this.chosen.id}|${Math.round(car.z * 10)}`;
      if (key !== this.evalKey) {
        this.evaluation = this.evaluate(this.chosen, car.z);
        this.evalKey = key;
      }
    } else if (this.screen === 'approach' || this.screen === 'drive') {
      this.evaluation = null;
      this.evalKey = '';
    }

    if (this.screen === 'assisted' && this.maneuver) {
      bars = this.maneuver.update(car, now);
      if (this.maneuver.guide) this.guide = this.buildGuide(pose, this.maneuver.guide, bars);
      if (this.maneuver.phase === 'done' && this.maneuver.result) {
        const r = this.maneuver.result;
        const clean = r.overs === 0 && contacts === this.contactsAtStart;
        this.doneInfo = {
          title: clean ? 'Parked at the first attempt' : 'Parked',
          lines: [
            `${Math.round(r.curbGap * 100)} cm from the curb`,
            `${Math.round(r.frontGap * 100)} cm ahead · ${Math.round(r.rearGap * 100)} cm behind`,
          ],
        };
        this.screen = 'done';
        this.blinker = null;
        this.locked = false;
        this.evaluation = null;
      }
    }
    // Autonomous: stopping, re-plan notice, mirrors
    if (this.braking && speed < 0.02) {
      const reason = this.braking;
      this.braking = null;
      if (reason === 'cancel') {
        // Cancelled: just stopped, nothing else to do
      } else if (this.replanAfterStop) {
        this.replanAfterStop = false;
        if (this.rebuild(car)) {
          this.screen = 'autoReplan';
          this.previewStart = now;
          this.replanUntil = now + REPLAN_NOTICE;
          this.emit({ type: 'trajectoryChange', t: now });
        } else {
          this.stopWith('obstacle', car);
        }
      } else {
        this.stopWith(reason, car);
      }
    }
    if (this.screen === 'autoReplan' && now >= this.replanUntil) this.screen = 'autoRunning';
    if (this.screen === 'autoStopped' && this.stopReason === 'driver' && this.stopPose) {
      // Driving away after a takeover means finishing by hand
      if (Math.hypot(car.x - this.stopPose.x, car.z - this.stopPose.z) > 0.3) this.toManual(now);
    }
    let barAlpha = { left: 1, right: 1 };
    if (this.screen === 'autoRunning' && this.auto && !this.braking) {
      const raw = autoBars(this.auto.timeline, this.auto.t, { lead: this.settings.autoLead, announceLead: this.settings.assist.announceLead, segments: this.settings.assist.segments });
      ({ bars, alpha: barAlpha } = this.smoothBars(raw, now));
    } else if (this.screen === 'done' && this.barHold) {
      // End of the manoeuvre: the lights fade out together
      ({ bars, alpha: barAlpha } = this.smoothBars({ left: OFF, right: OFF }, now, BAR_END_FADE));
    } else {
      this.barHold = null;
    }

    if (this.screen === 'done' && car.gear === 'D' && car.speed > 1) {
      this.screen = 'drive';
      this.maneuver = null;
      this.auto = null;
    }

    this.nowForDisplay = now;
    // A message belongs to the screen it was shown on
    if (this.toast && (now > this.toast.until || this.screen !== this.toastScreen)) this.toast = null;
    return {
      bars,
      barAlpha,
      display: {
        gear: this.screen === 'done' ? 'P' : car.gear,
        speedKmh: speed * 3.6,
        blinker: this.blinker,
        screen: this.displayScreen(),
        toast: this.toast?.text ?? null,
      },
    };
  }

  /**
   * Autonomous lights, same grammar, no sudden moves: a bar that would drop to nothing (wheels straightening,
   * the light changing side, a phase boundary with nothing lit) keeps what it showed and fades out; a new
   * or rising bar fades in. `fade` is how long a fade-out takes.
   */
  private smoothBars(raw: { left: BarView; right: BarView }, now: number, fade = BAR_FADE_OUT) {
    const h = (this.barHold ??= { left: { view: OFF, alpha: 0 }, right: { view: OFF, alpha: 0 }, at: now });
    const dt = Math.max(0, now - h.at);
    h.at = now;
    for (const side of ['left', 'right'] as const) {
      const held = h[side];
      const v = raw[side];
      const falling = v.kind === 'steer' && held.view.kind === 'steer' && v.fill < held.view.fill - 1e-3;
      if (v.kind === 'off' || falling) {
        held.alpha = Math.max(0, held.alpha - dt / fade);
      } else {
        held.view = v;
        held.alpha = Math.min(1, held.alpha + dt / BAR_FADE_IN);
      }
    }
    return {
      bars: { left: h.left.alpha > 0 ? h.left.view : OFF, right: h.right.alpha > 0 ? h.right.view : OFF },
      alpha: { left: h.left.alpha, right: h.right.alpha },
    };
  }

  private displayScreen(): DisplayScreen {
    switch (this.screen) {
      case 'drive':
        return { kind: 'drive' };
      case 'approach':
        return { kind: 'approach', selected: this.isSelected };
      case 'assisted': {
        const m = this.maneuver!;
        if (m.phase === 'inside') {
          const g = this.collisions.frontRearGaps(this.lastPose);
          return { kind: 'inside', front: g.front, rear: g.rear, line: m.instruction };
        }
        const pl = PHASE_LINES[m.phase];
        const moving = m.phase === 'reverse1' || m.phase === 'reverse2';
        // Rear camera while reversing: on request, or by itself when a car has stopped close behind
        const camera = moving && (this.settings.cameraWhileMoving || m.closeBehind);
        return { kind: 'assisted', title: pl.title, line: pl.line, mirror: pl.mirror, camera };
      }
      case 'done':
        return { kind: 'done', title: this.doneInfo!.title, lines: this.doneInfo!.lines };
      case 'autoPreview':
        return { kind: 'autoPreview', title: 'Ready to park', seconds: this.auto!.preview.seconds, countdown: null };
      case 'autoReplan':
        return {
          kind: 'autoPreview',
          title: 'Path changed: obstacle',
          seconds: this.auto!.preview.seconds,
          countdown: Math.max(1, Math.ceil(this.replanUntil - this.nowForDisplay)),
        };
      case 'autoRunning':
        return { kind: 'autoRunning' };
      case 'assistBlocked':
        return {
          kind: 'autoStopped',
          title: "The manoeuvre doesn't fit",
          line: this.obstacleLine,
          options: [{ key: 'M', label: 'I will finish by hand' }],
        };
      case 'autoStopped': {
        const assisted = { key: 'A', label: 'Continue in assisted mode from here' };
        const manual = { key: 'M', label: 'I will finish by hand' };
        if (this.stopReason === 'driver') {
          return {
            kind: 'autoStopped',
            title: 'You took control',
            line: 'I stopped. How would you like to continue?',
            options: [{ key: 'Enter', label: 'Resume autonomous' }, assisted, manual],
          };
        }
        if (this.stopReason === 'confidence') {
          return { kind: 'autoStopped', title: 'I cannot see the curb well', line: 'I stopped: continue from here in assisted mode', options: [assisted, manual] };
        }
        return { kind: 'autoStopped', title: 'I cannot find a safe manoeuvre', line: this.obstacleLine, options: [assisted, manual] };
      }
    }
  }

  private buildGuide(pose: Pose, g: { kappa: number; remaining: number }, bars: { left: BarView; right: BarView }): CameraGuide {
    const left: THREE.Vector3[] = [];
    const right: THREE.Vector3[] = [];
    const half = VEHICLE.track / 2;
    const at = (p: Pose, side: number) =>
      new THREE.Vector3(p.x - Math.sin(p.heading) * side * half, 0.02, p.z + Math.cos(p.heading) * side * half);
    const len = Math.max(0, Math.min(g.remaining, 6));
    for (let s = 0; s <= len + 1e-6; s += 0.2) {
      const p = advance(pose, g.kappa, -s);
      left.push(at(p, -1));
      right.push(at(p, 1));
    }
    let target: [THREE.Vector3, THREE.Vector3] | null = null;
    if (g.remaining > 0 && g.remaining < 6) {
      const p = advance(pose, g.kappa, -g.remaining);
      target = [at(p, -1.25), at(p, 1.25)];
    }
    const side = bars.right.kind !== 'off' && bars.right.kind !== 'announce' ? 'right' : 'left';
    return { left, right, target, bar: bars[side], side };
  }
}
