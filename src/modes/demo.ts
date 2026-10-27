import { START } from '../config';
import type { VehicleState, DriveInput } from '../vehicle/kinematics';
import type { BarView } from '../mirrors/lightBar';
import type { Glance, ViewName } from '../views/cameras';
import type { Scenario } from '../actors/actors';
import { MAX_STEER } from '../planner/geometry';
import { startXFor } from '../planner/parallelPlanner';
import type { GlideFlow } from './flow';
import type { LineId, Narrator } from '../audio/narrator';

/** What the demo needs from the app: the same objects and commands the keyboard uses. */
export interface DemoHost {
  car: VehicleState;
  flow: GlideFlow;
  bars(): { left: BarView; right: BarView } | null;
  command(c: 'blinkerRight' | 'park' | 'assisted' | 'auto' | 'start' | 'gearR' | 'gearD'): void;
  reset(scenario: Scenario, x: number): void;
  /** zoom: field of view while glancing; closeUp: chase camera right behind a mirror, from outside. */
  camera(view: ViewName, glance?: Glance, opts?: { zoom?: number; closeUp?: 'left' | 'right' }): void;
  /** Voice-over (also drives the subtitles: each line is shown when it starts). */
  voice: Narrator;
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
 * demo runs exactly the logic used in the tests. English voice-over (narration.json), subtitles = its transcript.
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
    this.host.voice.stop();
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
    this.say('01_intro');
    yield* this.drive(() => (car.x < -18 ? 5 : this.stopAt(1.8 - car.x, 2.2)), () => car.x > -30);
    this.say('02_approach');
    h.camera('driver');
    yield* this.drive(() => (car.x < -18 ? 5 : this.stopAt(1.8 - car.x, 2.2)), () => car.x > -14);
    h.camera('driver', 'display');
    yield* this.drive(() => this.stopAt(1.8 - car.x, 2.2), () => this.stopped() && car.x > 1.5);
    yield* this.wait(0.8);

    // 2. Space evaluation and P
    h.command('blinkerRight');
    this.say('03_evaluate');
    yield* this.waitVoice(3.2);
    h.command('park');
    this.say('04_park');
    yield* this.waitVoice(4.5);

    // 3. Assisted manoeuvre
    h.command('assisted');
    h.camera('driver');
    this.say('05_assisted');
    yield* this.waitVoice(2.5);
    h.camera('driver', 'right', MIRROR_ZOOM);
    this.say('06_positioning');
    yield* this.drive(() => {
      const m = h.flow.maneuver;
      return m ? this.stopAt(startXFor(m.plan, car.z) - car.x, 1.2) : 0;
    }, () => h.flow.maneuver?.phase !== 'positioning');

    this.say('07_steer');
    yield* this.steerTo(() => h.flow.maneuver?.plan.steer1 ?? 0, () => this.confirmed('right'));
    yield* this.waitVoice(1.0);
    h.command('gearR');
    this.say('08_reverse');
    yield* this.reverseWhile('reverse1', 1.0, 1.7);
    h.camera('driver', 'left', MIRROR_ZOOM);
    this.say('09_countersteer');
    yield* this.steerTo(() => {
      const v = h.bars()?.left;
      return v?.kind === 'steer' && v.target !== null ? -v.target * MAX_STEER : car.steer;
    }, () => this.confirmed('left'));
    yield* this.waitVoice(0.8);
    h.camera('top');
    this.say('10_final_reverse');
    yield* this.reverseWhile('reverse2', 0.9, 0);
    this.say('11_inside');
    h.camera('driver', 'display');
    yield* this.steerTo(() => 0, () => h.flow.screen === 'done');
    this.say('12_done');
    yield* this.waitVoice(4.5);

    // 4. Autonomous with preview
    h.reset('busy', -14);
    h.camera('chase');
    this.say('13_auto_intro');
    yield* this.drive(() => this.stopAt(1.8 - car.x, 2.0), () => this.stopped() && car.x > 1.5);
    h.command('blinkerRight');
    yield* this.wait(1.2);
    h.command('park');
    yield* this.wait(1.5);
    h.camera('driver', 'display');
    h.command('auto');
    this.say('14_preview');
    yield* this.waitVoice(6);
    h.command('start');
    this.say('15_start');
    yield* this.waitVoice(3);
    h.camera('chase', null, { closeUp: 'right' });
    this.say('16_outside');
    const run = () => h.flow.auto;
    yield* this.until(() => (run()?.t ?? 0) > (run()?.timeline.total ?? 1) * 0.45 || h.flow.screen !== 'autoRunning');

    if (this.settings.takeover && h.flow.screen === 'autoRunning') {
      h.camera('driver', 'display');
      this.say('17_takeover');
      this.takingOver = true;
      yield* this.drive(() => 0, () => h.flow.screen === 'autoStopped', true);
      this.takingOver = false;
      yield* this.waitVoice(3.5);
      this.say('18_resume');
      h.command('start');
      yield* this.wait(2);
      h.camera('chase');
    }
    h.camera('top');
    this.say('19_as_previewed');
    yield* this.until(() => h.flow.screen === 'done' || h.flow.screen === 'autoStopped');
    h.camera('driver', 'display');
    this.say('20_auto_done');
    yield* this.waitVoice(4);
    this.say('21_outro');
    yield* this.waitVoice(3);
    yield* this.wait(1);
  }

  // ---------- helpers ----------

  /** Queues a line of the voice-over (the subtitle follows the voice). */
  private say(id: LineId) {
    this.host.voice.say(id);
  }

  /** Waits at least `seconds`, and until the voice has finished (a missing clip does not wait). */
  private *waitVoice(seconds: number): Frame {
    yield* this.wait(seconds);
    yield* this.until(() => !this.host.voice.busy);
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
