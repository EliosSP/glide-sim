import * as THREE from 'three';
import { ONE_MANOEUVRE_MIN_EXTRA, VEHICLE, WIDE_SPACE_MIN } from '../config';
import type { FreeSpace } from '../scene/parkingLayout';
import type { VehicleState } from '../vehicle/kinematics';
import type { Collisions } from '../vehicle/collision';
import type { BarView } from '../mirrors/lightBar';
import { advance, type Pose } from '../planner/geometry';
import { planParallel } from '../planner/parallelPlanner';
import { AssistedManeuver, DEFAULT_ASSIST, type AssistEvent, type AssistedPhase } from './assisted';

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
  | { kind: 'approach'; evaluation: Evaluation | null; hint: string }
  | { kind: 'choose'; recommended: ModeChoice; reason: string }
  | { kind: 'assisted'; title: string; line: string; mirror: 'left' | 'right' | null; camera: boolean }
  | { kind: 'inside'; front: number; rear: number; line: string }
  | { kind: 'done'; title: string; lines: string[] };

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

export type FlowEvent = AssistEvent | { type: 'parkButton'; t: number } | { type: 'modeChosen'; mode: ModeChoice; t: number };

export interface FlowSettings {
  cameraWhileMoving: boolean; // display during movement (optional rear camera)
  curbPoorlyVisible: boolean; // scenario: sensors unsure about the curb
}

const OFF: BarView = { kind: 'off' };
const SLOW = 15 / 3.6; // approach view below this speed
const FAST = 20 / 3.6;
const PARK_MAX_SPEED = 10 / 3.6;

const PHASE_LINES: Record<AssistedPhase, { title: string; line: string; mirror: 'left' | 'right' | null }> = {
  positioning: { title: 'Assistito attivo', line: "Mettiti parallelo all'auto davanti", mirror: 'right' },
  steer1: { title: 'Sterza', line: 'Da fermo, verso destra', mirror: 'right' },
  reverse1: { title: 'Retro', line: 'Segui lo specchietto destro', mirror: 'right' },
  steer2: { title: 'Controsterza', line: 'Da fermo, verso sinistra', mirror: 'left' },
  reverse2: { title: 'Retro', line: 'Segui lo specchietto sinistro', mirror: 'left' },
  inside: { title: 'Dentro lo spazio', line: 'Raddrizza le ruote', mirror: null },
  done: { title: 'Fatto', line: '', mirror: null },
};

/** Steps 1–5 and 11–12 of the experience, plus the assisted manoeuvre. */
export class GlideFlow {
  screen: 'drive' | 'approach' | 'choose' | 'assisted' | 'done' = 'drive';
  blinker: Blinker = null;
  chosen: FreeSpace | null = null;
  locked = false;
  evaluation: Evaluation | null = null;
  maneuver: AssistedManeuver | null = null;
  recommendation: { mode: ModeChoice; reason: string } | null = null;
  guide: CameraGuide | null = null;
  /** Spaces where the car fits in one manoeuvre (from the lane), for the reconstruction colours. */
  readonly fits = new Map<string, boolean>();

  private toast: { text: string; until: number } | null = null;
  private toastScreen: GlideFlow['screen'] = 'drive';
  private doneInfo: { title: string; lines: string[] } | null = null;
  private contactsAtStart = 0;
  private lastPose: Pose = { x: 0, z: 0, heading: 0 };

  constructor(
    private spaces: FreeSpace[],
    private collisions: Collisions,
    public settings: FlowSettings,
    private emit: (e: FlowEvent) => void,
    laneZ: number,
  ) {
    for (const s of spaces) this.fits.set(s.id, planParallel(s, collisions, laneZ) !== null);
  }

  reset() {
    this.screen = 'drive';
    this.blinker = null;
    this.chosen = null;
    this.locked = false;
    this.evaluation = null;
    this.maneuver = null;
    this.recommendation = null;
    this.toast = null;
    this.doneInfo = null;
  }

  private say(text: string, now: number) {
    this.toast = { text, until: now + 3 };
    this.toastScreen = this.screen;
  }

  // ---------- inputs ----------

  onBlinker(side: 'left' | 'right', car: VehicleState, now: number) {
    this.blinker = this.blinker === side ? null : side;
    this.locked = false;
    this.evaluation = null;
    if (this.blinker === 'right' && this.chosen && this.screen === 'approach') {
      this.locked = true;
      this.evaluation = this.evaluate(this.chosen, car.z);
    }
    if (!this.blinker && this.screen === 'choose') this.screen = 'approach';
    void now;
  }

  onParkButton(car: VehicleState, now: number, contacts: number) {
    this.emit({ type: 'parkButton', t: now });
    if (this.screen === 'assisted') {
      this.maneuver = null;
      this.screen = 'approach';
      this.say('Assistenza annullata', now);
      return;
    }
    if (this.screen === 'choose') {
      this.screen = 'approach';
      return;
    }
    if (!this.evaluation) return this.say('Metti la freccia a destra per scegliere lo spazio', now);
    if (!this.evaluation.fits) return this.say('Questo spazio non va bene: scegline un altro', now);
    if (Math.abs(car.speed) > PARK_MAX_SPEED) return this.say('Rallenta per attivare Glide', now);
    this.recommendation = this.recommend(this.evaluation.space, car.z);
    this.screen = 'choose';
    this.contactsAtStart = contacts;
  }

  onModeChosen(mode: ModeChoice, car: VehicleState, now: number) {
    if (this.screen !== 'choose' || !this.evaluation) return;
    this.emit({ type: 'modeChosen', mode, t: now });
    if (mode === 'auto') return this.say('Modalità autonoma: arriva con la milestone 5', now);
    const plan = planParallel(this.evaluation.space, this.collisions, car.z);
    if (!plan) return this.say('Da qui non riesco a calcolare la manovra', now);
    this.maneuver = new AssistedManeuver(plan, this.collisions, DEFAULT_ASSIST, (e) => this.emit(e), now);
    this.screen = 'assisted';
  }

  // ---------- logic ----------

  private evaluate(space: FreeSpace, laneZ: number): Evaluation {
    const len = space.xEnd - space.xStart;
    const extra = Math.round((len - VEHICLE.length) * 100);
    const plan = planParallel(space, this.collisions, laneZ);
    if (plan) return { space, fits: true, title: 'Ci sta', line: `${extra} cm più lungo della tua auto` };
    if (extra <= 0) return { space, fits: false, title: 'Non ci sta', line: `${-extra} cm più corto della tua auto` };
    return {
      space,
      fits: false,
      title: 'Non ci sta in una manovra',
      line: `${extra} cm più lungo della tua auto, ne servono ${Math.round(ONE_MANOEUVRE_MIN_EXTRA * 100)}`,
    };
  }

  private recommend(space: FreeSpace, laneZ: number): { mode: ModeChoice; reason: string } {
    if (this.settings.curbPoorlyVisible) return { mode: 'assisted', reason: 'il cordolo si vede poco, i sensori non sono sicuri' };
    const len = space.xEnd - space.xStart;
    if (len >= WIDE_SPACE_MIN) return { mode: 'auto', reason: 'spazio ampio e ben rilevato' };
    const plan = planParallel(space, this.collisions, laneZ);
    const margin = plan ? Math.round(plan.minCarClearance * 100) : 0;
    return { mode: 'assisted', reason: `spazio stretto, ${margin} cm di margine minimo` };
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

  update(car: VehicleState, now: number, contacts: number): { bars: { left: BarView; right: BarView }; display: DisplayModel } {
    const speed = Math.abs(car.speed);
    const pose: Pose = { x: car.x, z: car.z, heading: car.heading };
    this.lastPose = pose;
    let bars = { left: OFF, right: OFF };
    this.guide = null;

    // Step 1–2: approach view and automatic highlight of the nearest space
    if (this.screen === 'drive' && speed < SLOW && this.nearestSpace(car.x)) this.screen = 'approach';
    if (this.screen === 'approach' && speed > FAST && !this.blinker) this.screen = 'drive';
    if ((this.screen === 'approach' || this.screen === 'drive') && !this.locked) this.chosen = this.nearestSpace(car.x);

    if (this.screen === 'assisted' && this.maneuver) {
      bars = this.maneuver.update(car, now);
      if (this.maneuver.guide) this.guide = this.buildGuide(pose, this.maneuver.guide, bars);
      if (this.maneuver.phase === 'done' && this.maneuver.result) {
        const r = this.maneuver.result;
        const clean = r.overs === 0 && contacts === this.contactsAtStart;
        this.doneInfo = {
          title: clean ? 'Parcheggiato al primo tentativo' : 'Parcheggiato',
          lines: [
            `${Math.round(r.curbGap * 100)} cm dal marciapiede`,
            `${Math.round(r.frontGap * 100)} cm davanti · ${Math.round(r.rearGap * 100)} cm dietro`,
          ],
        };
        this.screen = 'done';
        this.blinker = null;
        this.locked = false;
        this.evaluation = null;
      }
    }
    if (this.screen === 'done' && car.gear === 'D' && car.speed > 1) {
      this.screen = 'drive';
      this.maneuver = null;
    }

    // A message belongs to the screen it was shown on
    if (this.toast && (now > this.toast.until || this.screen !== this.toastScreen)) this.toast = null;
    return {
      bars,
      display: {
        gear: this.screen === 'done' ? 'P' : car.gear,
        speedKmh: speed * 3.6,
        blinker: this.blinker,
        screen: this.displayScreen(),
        toast: this.toast?.text ?? null,
      },
    };
  }

  private displayScreen(): DisplayScreen {
    switch (this.screen) {
      case 'drive':
        return { kind: 'drive' };
      case 'approach':
        return {
          kind: 'approach',
          evaluation: this.evaluation,
          hint: this.evaluation
            ? this.evaluation.fits ? 'Premi P per parcheggiare' : 'Togli la freccia e scegline un altro'
            : this.chosen ? 'Metti la freccia per valutare lo spazio' : 'Cerco spazi liberi',
        };
      case 'choose':
        return { kind: 'choose', recommended: this.recommendation!.mode, reason: this.recommendation!.reason };
      case 'assisted': {
        const m = this.maneuver!;
        if (m.phase === 'inside') {
          const g = this.collisions.frontRearGaps(this.lastPose);
          return { kind: 'inside', front: g.front, rear: g.rear, line: m.instruction };
        }
        const pl = PHASE_LINES[m.phase];
        const moving = m.phase === 'reverse1' || m.phase === 'reverse2';
        return { kind: 'assisted', title: pl.title, line: pl.line, mirror: pl.mirror, camera: moving && this.settings.cameraWhileMoving };
      }
      case 'done':
        return { kind: 'done', title: this.doneInfo!.title, lines: this.doneInfo!.lines };
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
