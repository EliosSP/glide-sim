import { START } from '../config';
import type { VehicleState, DriveInput } from '../vehicle/kinematics';
import type { BarView } from '../mirrors/lightBar';
import type { Glance, ViewName } from '../views/cameras';
import type { Scenario } from '../actors/actors';
import { MAX_STEER } from '../planner/geometry';
import { startXFor } from '../planner/parallelPlanner';
import type { GlideFlow } from './flow';

/** What the demo needs from the app: the same objects and commands the keyboard uses. */
export interface DemoHost {
  car: VehicleState;
  flow: GlideFlow;
  bars(): { left: BarView; right: BarView } | null;
  command(c: 'blinkerRight' | 'park' | 'assisted' | 'auto' | 'start' | 'gearR' | 'gearD'): void;
  reset(scenario: Scenario, x: number): void;
  /** zoom: field of view while glancing; closeUp: chase camera right behind a mirror, from outside. */
  camera(view: ViewName, glance?: Glance, opts?: { zoom?: number; closeUp?: 'left' | 'right' }): void;
  subtitle(text: string | null): void;
}

export interface DemoSettings {
  subtitles: boolean;
  takeover: boolean; // optional takeover during the autonomous part
}

const IDLE: DriveInput = { throttle: false, brake: false, hardBrake: false, steerLeft: false, steerRight: false };
const STOP_DECEL = 1.4; // m/s², planned deceleration when stopping at a point (the brake can do 3.5)
const STEER_TOL = 0.004; // rad
const MIRROR_ZOOM = { zoom: 11 }; // close enough to read the light bar in a video
const STEP_TIMEOUT = 40; // s: a step that never completes is skipped, the demo never hangs

/** Waits for one frame (yielded by every script step). */
type Frame = Generator<void, void, void>;

/**
 * Scripted pitch demo: approach → full assisted manoeuvre → reset → autonomous with preview
 * (→ optional takeover). An autopilot produces DriveInput inside the normal physics loop, so the
 * demo runs exactly the logic used in the tests. Subtitles are in English (pitch).
 */
export class DemoDirector {
  active = false;
  private script: Frame | null = null;
  private control: () => DriveInput = () => IDLE;
  private t = 0; // demo time (simulation seconds)
  private takingOver = false; // the only moment the autopilot touches the controls while Glide drives

  constructor(
    private host: DemoHost,
    public settings: DemoSettings,
  ) {}

  start() {
    this.active = true;
    this.t = 0;
    this.script = this.run();
  }

  stop() {
    this.active = false;
    this.script = null;
    this.control = () => IDLE;
    this.host.subtitle(null);
  }

  /** Called once per frame before physics; returns the input for this frame. */
  update(dt: number): DriveInput {
    if (!this.script) return IDLE;
    this.t += dt;
    if (this.script.next().done) {
      this.script = null;
      this.control = () => IDLE;
    }
    // While Glide drives, any brake or steering input would be a takeover (I1): hands off
    const s = this.host.flow.screen;
    if ((s === 'autoRunning' || s === 'autoReplan') && !this.takingOver) return IDLE;
    return this.control();
  }

  // ---------- script ----------

  private *run(): Frame {
    const h = this.host;
    const car = h.car;

    // 1. Approach
    h.reset('busy', START.x);
    h.camera('chase');
    this.say('Glide: parallel parking you can trust, and delegate when you want to.');
    yield* this.drive(() => (car.x < -18 ? 5 : this.stopAt(1.8 - car.x, 2.2)), () => car.x > -30);
    this.say('Below 15 km/h the central display maps the free spaces. Blue means your car fits.');
    h.camera('driver');
    yield* this.drive(() => (car.x < -18 ? 5 : this.stopAt(1.8 - car.x, 2.2)), () => car.x > -14);
    h.camera('driver', 'display');
    yield* this.drive(() => this.stopAt(1.8 - car.x, 2.2), () => this.stopped() && car.x > 1.5);
    yield* this.wait(0.8);

    // 2. Space evaluation and P
    h.command('blinkerRight');
    this.say('Right indicator: Glide checks the space. It fits, and it says by how much.');
    yield* this.wait(3.2);
    h.command('park');
    this.say('P: Glide recommends a mode, explains why, and splits what it does from what you do.');
    yield* this.wait(4.5);

    // 3. Assisted manoeuvre
    h.command('assisted');
    h.camera('driver');
    this.say('Assisted: you drive. For everything you need while moving, you look outside, at the mirrors.');
    yield* this.wait(2.5);
    h.camera('driver', 'right', MIRROR_ZOOM);
    this.say('Moving: segments switch off as you approach the point where to stop.');
    yield* this.drive(() => {
      const m = h.flow.maneuver;
      return m ? this.stopAt(startXFor(m.plan, car.z) - car.x, 1.2) : 0;
    }, () => h.flow.maneuver?.phase !== 'positioning');

    this.say('Stopped: the bar follows the steering wheel up to the notch. Two blinks and a tone: right.');
    yield* this.steerTo(() => h.flow.maneuver?.plan.steer1 ?? 0, () => this.confirmed('right'));
    yield* this.wait(1.0);
    h.command('gearR');
    this.say('Reverse: the right mirror counts down to the counter-steer point; the left one pre-announces it.');
    yield* this.reverseWhile('reverse1', 1.0, 1.7);
    h.camera('driver', 'left', MIRROR_ZOOM);
    this.say('The light snaps to the left mirror: counter-steer, same gesture, other side.');
    yield* this.steerTo(() => {
      const v = h.bars()?.left;
      return v?.kind === 'steer' && v.target !== null ? -v.target * MAX_STEER : car.steer;
    }, () => this.confirmed('left'));
    yield* this.wait(0.8);
    h.camera('top');
    this.say('Last reverse: the left mirror counts down to where to straighten the wheels.');
    yield* this.reverseWhile('reverse2', 0.9, 0);
    this.say('Inside the space the mirrors switch off. Sensors beep only in the last centimetres.');
    h.camera('driver', 'display');
    yield* this.steerTo(() => 0, () => h.flow.screen === 'done');
    this.say('Parked. The feedback is factual: first attempt, distance from the curb.');
    yield* this.wait(4.5);

    // 4. Autonomous with preview
    this.say(null);
    h.reset('busy', -14);
    h.camera('chase');
    this.say('Now the autonomous mode, on a busier street.');
    yield* this.drive(() => this.stopAt(1.8 - car.x, 2.0), () => this.stopped() && car.x > 1.5);
    h.command('blinkerRight');
    yield* this.wait(1.2);
    h.command('park');
    yield* this.wait(1.5);
    h.camera('driver', 'display');
    h.command('auto');
    this.say('Before moving, Glide previews the whole manoeuvre and its critical points: closest distance, fastest stretch.');
    yield* this.wait(6);
    h.command('start');
    this.say('"I steer, accelerate and brake. You supervise: brake or steer to stop me."');
    yield* this.wait(3);
    h.camera('chase', null, { closeUp: 'right' });
    this.say('The mirror light leads the wheel by one second, and tells people outside where the car is going.');
    const run = () => h.flow.auto;
    yield* this.until(() => (run()?.t ?? 0) > (run()?.timeline.total ?? 1) * 0.45 || h.flow.screen !== 'autoRunning');

    if (this.settings.takeover && h.flow.screen === 'autoRunning') {
      h.camera('driver', 'display');
      this.say('Brake or steer and Glide stops at once, then asks how to continue.');
      this.takingOver = true;
      yield* this.drive(() => 0, () => h.flow.screen === 'autoStopped', true);
      this.takingOver = false;
      yield* this.wait(3.5);
      this.say('Resume: Glide continues from exactly where it stopped.');
      h.command('start');
      yield* this.wait(2);
      h.camera('chase');
    }
    h.camera('top');
    this.say('The critical points are met exactly as announced in the preview.');
    yield* this.until(() => h.flow.screen === 'done' || h.flow.screen === 'autoStopped');
    h.camera('driver', 'display');
    this.say('Parked as previewed. Control is back to you.');
    yield* this.wait(5);
    this.say('Glide. Advise, never impose.');
    yield* this.wait(4);
    this.say(null);
  }

  // ---------- helpers ----------

  private say(text: string | null) {
    this.host.subtitle(this.settings.subtitles ? text : null);
  }

  private stopped() {
    return Math.abs(this.host.car.speed) < 0.02;
  }

  private confirmed(side: 'left' | 'right') {
    const v = this.host.bars()?.[side];
    return v?.kind === 'steer' && v.inTarget;
  }

  /** Target speed that stops `d` metres ahead with a gentle deceleration. */
  private stopAt(d: number, vmax: number) {
    return d <= 0.03 ? 0 : Math.min(vmax, Math.sqrt(2 * STOP_DECEL * d));
  }

  /** Throttle/brake to follow a signed target speed (the keyboard controls are on/off). */
  private speedInput(target: number, hard = false): DriveInput {
    const v = this.host.car.speed;
    const t = Math.abs(target);
    const s = Math.abs(v);
    if (t === 0) return { ...IDLE, brake: s > 0, hardBrake: hard };
    return { ...IDLE, throttle: s < t - 0.05, brake: s > t + 0.15 };
  }

  private *wait(seconds: number): Frame {
    const end = this.t + seconds;
    this.control = () => this.speedInput(0);
    while (this.t < end) yield;
  }

  /** Yields until `cond`, or until STEP_TIMEOUT. */
  private *until(cond: () => boolean): Frame {
    const end = this.t + STEP_TIMEOUT;
    while (!cond() && this.t < end) yield;
  }

  /** Drives forward (D) at a target speed until `done`. */
  private *drive(speed: () => number, done: () => boolean, hard = false): Frame {
    this.control = () => this.speedInput(speed(), hard);
    yield* this.until(done);
    this.control = () => this.speedInput(0);
  }

  /** Turns the wheel at standstill until `done` (or the angle is reached and held). */
  private *steerTo(target: () => number, done: () => boolean): Frame {
    this.control = () => {
      const e = target() - this.host.car.steer;
      return { ...this.speedInput(0), steerRight: e > STEER_TOL, steerLeft: e < -STEER_TOL };
    };
    yield* this.until(done);
    this.control = () => this.speedInput(0);
  }

  /** Reverses during an assisted phase, stopping at the point the mirror counts down to. */
  private *reverseWhile(phase: 'reverse1' | 'reverse2', vmax: number, glanceSwitch: number): Frame {
    const h = this.host;
    let switched = glanceSwitch <= 0;
    this.control = () => {
      const g = h.flow.maneuver?.guide;
      if (!switched && g && g.remaining < glanceSwitch) {
        // Close to the point: the pre-announcement in the left mirror
        switched = true;
        h.camera('driver', 'left', MIRROR_ZOOM);
      }
      // Before the phase starts (no countdown yet) roll back slowly to start it
      return this.speedInput(g ? -this.stopAt(g.remaining, vmax) : -0.4);
    };
    // The phase starts only once the car actually moves backwards
    yield* this.until(() => h.flow.maneuver?.phase === phase);
    yield* this.until(() => h.flow.maneuver?.phase !== phase);
    this.control = () => this.speedInput(0);
  }
}
