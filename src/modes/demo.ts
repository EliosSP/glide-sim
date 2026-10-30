import { START } from '../config';
import type { VehicleState, DriveInput } from '../vehicle/kinematics';
import type { BarView } from '../mirrors/lightBar';
import type { Glance, ViewName } from '../views/cameras';
import type { Scenario } from '../actors/actors';
import { MAX_STEER } from '../planner/geometry';
import { startXFor } from '../planner/parallelPlanner';
import type { GlideFlow } from './flow';
import type { LineId, Narrator } from '../audio/narrator';
import type { NoteAnchor, VideoOverlayState } from '../ui/overlay';

/** What the demo needs from the app: the same objects and commands the keyboard uses. */
export interface DemoHost {
  car: VehicleState;
  flow: GlideFlow;
  bars(): { left: BarView; right: BarView } | null;
  /** How bright each mirror light is (the lights fade in and out). */
  barAlpha(): { left: number; right: number };
  command(c: 'blinkerRight' | 'park' | 'assisted' | 'select' | 'start' | 'gearR' | 'gearD'): void;
  reset(scenario: Scenario, x: number): void;
  /** zoom: field of view while glancing; closeUp: chase camera right behind a mirror, from outside. */
  camera(view: ViewName, glance?: Glance, opts?: { zoom?: number; closeUp?: 'left' | 'right'; natural?: boolean }): void;
  /** Video only: overlay (labels), tap on a display button. */
  overlay(o: Partial<VideoOverlayState>): void;
  tap(label: string | null): void;
  tapSpace(on: boolean): void;
  /** Video: big driver view on the left, outside view (close, behind and above) in a narrow panel on the right. */
  split(on: boolean): void;
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
const NATURAL_GAZE = { natural: true }; // video: eyes turn towards a mirror without zooming or locking onto it
const BOTH_HOLD = 2.0; // s: each look when both mirrors are lit (left, then right, then straight ahead)
const MIRROR_HOLD = 1.2; // s: shortest look at a mirror (or straight ahead) in the video
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
  private silent = false; // video: no voice, no subtitles
  private takingOver = false; // the only moment the autopilot touches the controls while Glide drives

  constructor(
    private host: DemoHost,
    public settings: DemoSettings,
  ) {}

  start(kind: 'pitch' | 'video' = 'pitch') {
    this.active = true;
    this.t = 0;
    this.silent = kind === 'video';
    this.script = kind === 'video' ? this.runVideo() : this.run();
  }

  stop() {
    this.active = false;
    this.script = null;
    this.control = () => IDLE;
    this.host.voice.stop();
    this.host.overlay({ note: null });
    this.host.tap(null);
    this.host.tapSpace(false);
    this.host.split(false);
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


  /**
   * Concept video, no voice or subtitles: arrival at the space → touch to choose it → P (lights on, preview
   * with Start) → the preview explained → Start → manoeuvre, cutting between
   * outside and inside → parked. A few short white bubbles (English) sit next to the touch points; the rest is for a voice-over.
   */
  private *runVideo(): Frame {
    const h = this.host;
    const car = h.car;
    const say = (text: string, anchor: NoteAnchor) => h.overlay({ note: { text, anchor } });
    const hush = () => h.overlay({ note: null });
    hush();
    h.tap(null);
    h.tapSpace(false);

    // 1. Arrival: the search is already done, the car slows down next to a free space
    h.reset('busy', -14);
    h.camera('chase');
    yield* this.drive(() => (car.x < -7 ? 6 : this.stopAt(1.8 - car.x, 3.5)), () => car.x > -7);
    h.camera('driver');
    yield* this.drive(() => this.stopAt(1.8 - car.x, 3.5), () => this.stopped() && car.x > 1.5);

    // 2. The display maps the free spaces (blue = the car fits); a touch chooses one
    h.camera('driver', 'display');
    yield* this.wait(1.8);
    h.tapSpace(true);
    yield* this.wait(0.8);
    h.command('select');
    yield* this.wait(0.4);
    h.tapSpace(false);
    yield* this.wait(0.6);

    // 3. The physical P button, under the display
    h.camera('driver', 'dash');
    yield* this.wait(1.8); // the button is in view, then it is pressed
    h.command('park'); // presses the button; lights on, preview of the manoeuvre
    yield* this.wait(1.2);

    // 4. The preview: where it gets close to obstacles, where it goes fastest
    h.camera('driver', 'display');
    yield* this.wait(2.5);
    say('Closest approach to an obstacle', 'closest');
    yield* this.wait(4);
    say('Fastest part of the manoeuvre', 'fastest');
    yield* this.wait(4);
    hush();
    yield* this.wait(2);

    // 5. Start: pressed straight away, the touch on the display is its own explanation
    yield* this.wait(1.2);
    h.tap('Start');
    yield* this.wait(0.8);
    h.command('start');
    h.tap(null);

    // 6. Manoeuvre: the driver's view takes most of the screen and looks at whichever mirror lights up
    // (the wheel turning in between); the outside view is a narrow panel on the right
    h.split(true);
    h.camera('driver', null, NATURAL_GAZE);
    yield* this.followMirrors(() => h.flow.screen === 'done' || h.flow.screen === 'autoStopped');
    h.split(false);
    yield* this.wait(2.5);

    // 7. Parked
    h.camera('chase');
    yield* this.wait(4);
  }

  /** Mirror whose light is following the manoeuvre right now (not the steady "armed" bar, not the pre-announcement). */
  private litSide(): 'left' | 'right' | 'both' | null {
    const b = this.host.bars();
    if (!b) return null;
    const a = this.host.barAlpha();
    const on = (v: BarView, alpha: number) => (v.kind !== 'off' && v.kind !== 'on' && v.kind !== 'announce' ? alpha : 0);
    const l = on(b.left, a.left);
    const r = on(b.right, a.right);
    if (Math.min(l, r) >= 0.5) return 'both'; // straight drive: both count down
    return Math.max(l, r) < 0.5 ? null : r >= l ? 'right' : 'left';
  }

  /**
   * Driver's eyes follow the lit mirror like a person's: head turning part of the way, wide field, wheel and cabin in view
   * (each look lasts at least MIRROR_HOLD s). Both lit (straight drive): one glance left, one right, then straight ahead, once per manoeuvre
   * (not again on the final centring). No light lit: straight ahead.
   */
  private *followMirrors(done: () => boolean): Frame {
    const h = this.host;
    const end = this.t + STEP_TIMEOUT * 2;
    let side: 'left' | 'right' | null = null;
    let since = this.t - MIRROR_HOLD; // the first look can start at once
    let bothSince: number | null = null;
    while (!done() && this.t < end) {
      const lit = this.litSide();
      if (lit === 'both' && bothSince === null) bothSince = this.t;
      const sweep = this.t - (bothSince ?? this.t);
      const want = lit === 'both' ? (sweep < BOTH_HOLD ? 'left' : sweep < 2 * BOTH_HOLD ? 'right' : null) : lit;
      if (want !== side && this.t - since >= MIRROR_HOLD) {
        side = want;
        since = this.t;
        h.camera('driver', want, NATURAL_GAZE);
      }
      yield;
    }
  }

  // ---------- helpers ----------

  /** Queues a line of the voice-over (the subtitle follows the voice). */
  private say(id: LineId) {
    if (!this.silent) this.host.voice.say(id);
  }

  /** Waits at least `seconds`, and until the voice has finished (a missing clip does not wait). */
  private *waitVoice(seconds: number): Frame {
    yield* this.wait(seconds);
    if (this.silent) return;
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
