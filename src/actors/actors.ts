import * as THREE from 'three';
import { ROAD, VEHICLE } from '../config';
import { createCar, poseCar, type CarRig } from '../vehicle/carModel';
import type { Collisions } from '../vehicle/collision';
import { footprint, type Pose } from '../planner/geometry';
import { createCyclist, createPedestrian, type Rider, type Walker } from './figures';

export type Scenario = 'empty' | 'busy';

/** Panel settings; each actor can be switched on and off. */
export interface ActorSettings {
  scenario: Scenario;
  pedestrians: boolean;
  waitingCar: boolean;
  waitingGap: number; // m, between the waiting car and Jacopo's car
  tooClose: boolean; // the waiting car squeezes in too close
  cyclist: boolean; // from behind on the left, synchronised with the counter-steer
  traffic: boolean; // cars passing in the opposite lane
  hazard: boolean; // calls the empty onHazard hook (behaviour not defined by the group)
}

export function scenarioSettings(scenario: Scenario): Omit<ActorSettings, 'waitingGap' | 'hazard'> {
  const on = scenario === 'busy';
  return { scenario, pedestrians: on, waitingCar: on, tooClose: false, cyclist: on, traffic: on };
}

/** What the actors need to know about the manoeuvre. */
export interface ActorContext {
  maneuver: boolean; // Glide is active (from P to the end)
  counterSteer: boolean; // the counter-steer is about to start / in progress
  egoSpeed: number; // m/s, signed (< 0 reversing)
}

export interface HazardEvent {
  kind: 'cyclist' | 'pedestrian';
  distance: number; // m from the body
  t: number;
}

export interface ActorMarker {
  id: string;
  kind: 'car' | 'bike' | 'person';
  x: number; // centre
  z: number;
  heading: number;
}

const TOO_CLOSE_GAP = 0.6;
const CYCLIST_SPEED = 5.5; // m/s, ~20 km/h
const CENTRE = (VEHICLE.wheelbase + VEHICLE.frontOverhang - VEHICLE.rearOverhang) / 2;
const LANE_Z = 1.75; // Jacopo's lane (right)
const OPP_Z = -1.7; // opposite lane

/** A car driving along a lane in direction dir (+1 = +X), origin at the rear axle like Jacopo's. */
class LaneCar {
  readonly rig: CarRig;
  x = 0;
  speed = 0;
  spin = 0;
  active = false;

  constructor(color: number, readonly z: number, readonly dir: 1 | -1, scene: THREE.Scene) {
    this.rig = createCar({ color, interior: false });
    this.rig.root.visible = false;
    scene.add(this.rig.root);
  }

  get front() {
    return this.x + this.dir * (VEHICLE.wheelbase + VEHICLE.frontOverhang);
  }

  get centre() {
    return this.x + this.dir * CENTRE;
  }

  spawn(x: number, speed: number) {
    this.x = x;
    this.speed = speed;
    this.active = true;
    this.rig.root.visible = true;
  }

  despawn() {
    this.active = false;
    this.rig.root.visible = false;
  }

  /** Cruise at vDes, stopping `gap` before an obstacle `free` metres ahead of the front bumper. Never reverses. */
  drive(dt: number, vDes: number, free: number) {
    const allowed = Math.sqrt(2 * 2.2 * Math.max(0, free));
    const v = Math.min(vDes, allowed);
    const dv = v - this.speed;
    this.speed = Math.max(0, this.speed + Math.max(-5 * dt, Math.min(1.6 * dt, dv)));
    this.x += this.dir * this.speed * dt;
    this.spin += (this.speed * dt) / VEHICLE.wheelRadius;
    poseCar(this.rig, this.x, this.z, this.dir > 0 ? 0 : Math.PI, 0, this.spin, 0);
  }
}

interface PedestrianState {
  figure: Walker;
  x: number;
  z: number;
  dir: 1 | -1;
  speed: number;
  xMin: number;
  xMax: number;
  phase: number;
  near: boolean;
}

/**
 * Other actors of the street: pedestrians on the sidewalks, the car that arrives and waits
 * behind, the cyclist passing on the left during the counter-steer, traffic in the opposite lane.
 */
export class Actors {
  onSettled: () => void = () => {}; // the waiting car has stopped behind
  onHazard: (e: HazardEvent) => void = () => {};

  private pedestrians: PedestrianState[] = [];
  private waiting: LaneCar;
  private waitingState: 'off' | 'coming' | 'leaving' = 'off';
  private settledX = -Infinity; // where the waiting car last stopped
  private traffic: LaneCar[];
  private trafficTimer = 2;
  private rider: Rider;
  private cyclist = { active: false, x: 0, z: 0.95, v: 0, dist: 0, armed: true, near: false };
  private time = 0;

  constructor(
    private scene: THREE.Scene,
    private collisions: Collisions,
    public settings: ActorSettings,
  ) {
    this.waiting = new LaneCar(0x7d8b5a, LANE_Z, 1, scene);
    this.traffic = [0xa7a9ac, 0x253247, 0x8c2f2a].map((c) => new LaneCar(c, OPP_Z, -1, scene));
    this.rider = createCyclist();
    this.rider.root.visible = false;
    scene.add(this.rider.root);
    this.buildPedestrians();
  }

  private buildPedestrians() {
    let seed = 1;
    for (const s of [-1, 1]) {
      // One walking line each, so they never overlap
      for (const off of [0.95, 1.4, 1.85, 2.3, 2.7]) {
        const figure = createPedestrian(seed);
        this.scene.add(figure.root);
        const xMin = -75 + ((seed * 23) % 30);
        const xMax = xMin + 45 + ((seed * 17) % 40);
        const p: PedestrianState = {
          figure,
          x: xMin + ((seed * 41) % 100) / 100 * (xMax - xMin),
          z: s * (ROAD.curbZ + off),
          dir: seed % 2 ? 1 : -1,
          speed: 1.05 + ((seed * 13) % 6) / 10,
          xMin,
          xMax,
          phase: seed,
          near: false,
        };
        this.pedestrians.push(p);
        seed++;
      }
    }
  }

  /** P accepted: a car arrives from behind and waits. */
  onParkActivated(ego: Pose) {
    if (!this.settings.waitingCar || this.waitingState !== 'off') return;
    this.waiting.spawn(ego.x - VEHICLE.rearOverhang - 34 - VEHICLE.wheelbase - VEHICLE.frontOverhang, 7);
    this.waitingState = 'coming';
    this.settledX = -Infinity;
  }

  /** Back to the start (Esc): manoeuvre-related actors disappear. */
  reset() {
    this.removeWaiting();
    this.cyclist.active = false;
    this.cyclist.armed = true;
    this.rider.root.visible = false;
  }

  /** Called after toggling actors in the panel. */
  applySettings() {
    if (!this.settings.waitingCar) this.removeWaiting();
    if (!this.settings.cyclist) {
      this.cyclist.active = false;
      this.rider.root.visible = false;
    }
    if (!this.settings.traffic) for (const [i, c] of this.traffic.entries()) this.removeTraffic(c, i);
    for (const p of this.pedestrians) p.figure.root.visible = this.settings.pedestrians;
  }

  private removeWaiting() {
    this.waiting.despawn();
    this.waitingState = 'off';
    this.collisions.removeObject('waiting-car');
  }

  private removeTraffic(c: LaneCar, i: number) {
    c.despawn();
    this.collisions.removeObject(`traffic-${i}`);
  }

  /** Markers for the reconstruction on the display. */
  markers(): ActorMarker[] {
    const out: ActorMarker[] = [];
    if (this.waiting.active) out.push({ id: 'waiting-car', kind: 'car', x: this.waiting.centre, z: this.waiting.z, heading: 0 });
    this.traffic.forEach((c, i) => c.active && out.push({ id: `traffic-${i}`, kind: 'car', x: c.centre, z: c.z, heading: Math.PI }));
    if (this.cyclist.active) out.push({ id: 'cyclist', kind: 'bike', x: this.cyclist.x, z: this.cyclist.z, heading: 0 });
    if (this.settings.pedestrians) this.pedestrians.forEach((p, i) => out.push({ id: `ped-${i}`, kind: 'person', x: p.x, z: p.z, heading: p.dir > 0 ? 0 : Math.PI }));
    return out;
  }

  update(dt: number, now: number, ego: Pose, ctx: ActorContext) {
    this.time += dt;
    const body = footprint(ego);
    if (this.settings.pedestrians) this.updatePedestrians(dt, now, body);
    this.updateWaiting(dt, ego, body, ctx);
    if (this.settings.traffic) this.updateTraffic(dt, ego, body);
    if (this.settings.cyclist) this.updateCyclist(dt, now, ego, body, ctx);
  }

  private updatePedestrians(dt: number, now: number, body: [number, number][]) {
    for (const p of this.pedestrians) {
      p.x += p.dir * p.speed * dt;
      if (p.x > p.xMax) p.dir = -1;
      else if (p.x < p.xMin) p.dir = 1;
      p.phase += (p.speed / 0.7) * Math.PI * dt; // ~0.7 m per step
      p.figure.root.position.set(p.x, ROAD.curbHeight, p.z);
      p.figure.root.rotation.y = p.dir > 0 ? 0 : Math.PI;
      p.figure.animate(p.phase, p.speed);
      p.near = this.checkHazard(p.near, p.x, p.z, body, 'pedestrian', now);
    }
  }

  /** Smallest x of Jacopo's body that intrudes into a lane band [zMin, zMax], or null. */
  private intrusion(body: [number, number][], zMin: number, zMax: number, pick: 'min' | 'max') {
    const inBand = body.filter(([, z]) => z > zMin && z < zMax);
    // A diagonal body can cross the band with corners on both sides
    const crosses = body.some(([, z]) => z <= zMin) && body.some(([, z]) => z >= zMax);
    if (!inBand.length && !crosses) return null;
    const xs = (inBand.length ? inBand : body).map(([x]) => x);
    return pick === 'min' ? Math.min(...xs) : Math.max(...xs);
  }

  private updateWaiting(dt: number, ego: Pose, body: [number, number][], ctx: ActorContext) {
    const c = this.waiting;
    if (!c.active) return;
    const band = [c.z - 1.1, c.z + 1.1] as const;
    const egoX = this.intrusion(body, band[0], band[1], 'min');
    const gap = this.settings.tooClose ? TOO_CLOSE_GAP : this.settings.waitingGap;
    let free = egoX === null || egoX < c.front - 0.5 ? Infinity : egoX - c.front - gap;
    // Waiting for the manoeuvre: once stopped, it moves up only if Jacopo drives forward, straight
    const straight = Math.abs(ego.heading) < 0.03;
    if (ctx.maneuver && this.settledX > -Infinity && egoX !== null && !(ctx.egoSpeed > 0.1 && straight)) free = 0;
    // Jacopo has finished (or left the lane): drive on
    if (this.waitingState === 'coming' && !ctx.maneuver && egoX === null) this.waitingState = 'leaving';
    c.drive(dt, this.waitingState === 'leaving' ? 9 : 7, free);
    // Stopped somewhere new (even after creeping a few centimetres): Glide re-checks its trajectory
    if (c.speed < 0.01 && Math.abs(c.x - this.settledX) > 0.02) {
      this.settledX = c.x;
      if (this.waitingState === 'coming') this.onSettled();
    }
    this.collisions.addObject('waiting-car', c.centre, c.z, VEHICLE.length / 2, VEHICLE.width / 2, 'car');
    const egoFront = Math.max(...body.map(([x]) => x));
    if ((this.waitingState === 'leaving' && c.x > egoFront + 90) || c.x < egoFront - 150) this.removeWaiting();
  }

  private updateTraffic(dt: number, ego: Pose, body: [number, number][]) {
    this.trafficTimer -= dt;
    const free = this.traffic.find((c) => !c.active);
    const last = this.traffic.filter((c) => c.active).sort((a, b) => b.x - a.x)[0];
    // A new car appears ahead, far enough from the previous one
    if (this.trafficTimer <= 0 && free && (!last || last.x < ego.x + 100)) {
      free.spawn(ego.x + 120, 8.3);
      this.trafficTimer = 5 + ((this.time * 7.3) % 7);
    }
    // Front to back (towards -X): each car follows Jacopo's intrusion, the cyclist and the car ahead
    const order = this.traffic.filter((c) => c.active).sort((a, b) => a.x - b.x);
    order.forEach((c, k) => {
      let free = Infinity;
      const egoX = this.intrusion(body, c.z - 1.1, c.z + 1.1, 'max');
      if (egoX !== null && egoX < c.front + 0.5) free = Math.min(free, c.front - egoX - 2.5);
      if (this.cyclist.active && this.cyclist.z < c.z + 1.2 && this.cyclist.x < c.front + 0.5) free = Math.min(free, c.front - this.cyclist.x - 4);
      const ahead = order[k - 1];
      if (ahead) free = Math.min(free, c.front - (ahead.x + VEHICLE.rearOverhang) - 3);
      c.drive(dt, 8.3, free);
    });
    this.traffic.forEach((c, i) => {
      if (!c.active) return;
      if (c.x < ego.x - 80) this.removeTraffic(c, i);
      else this.collisions.addObject(`traffic-${i}`, c.centre, c.z, VEHICLE.length / 2, VEHICLE.width / 2, 'car');
    });
  }

  private updateCyclist(dt: number, now: number, ego: Pose, body: [number, number][], ctx: ActorContext) {
    const cy = this.cyclist;
    if (!ctx.maneuver) cy.armed = true;
    // Launched once per manoeuvre so that it passes Jacopo's front ~3.5 s after the counter-steer starts
    if (ctx.counterSteer && cy.armed && !cy.active) {
      cy.armed = false;
      cy.active = true;
      const frontX = Math.max(...body.map(([x]) => x));
      cy.x = frontX - CYCLIST_SPEED * 3.5;
      cy.z = 0.95;
      cy.v = CYCLIST_SPEED;
      this.rider.root.visible = true;
    }
    if (!cy.active) return;
    // Keep clear on the left of Jacopo's body and of the waiting car, looking a few metres ahead
    let edge = Infinity;
    for (const [x, z] of body) if (x > cy.x - 1.5 && x < cy.x + 8) edge = Math.min(edge, z);
    const w = this.waiting;
    if (w.active && w.front > cy.x - 1.5 && w.x - VEHICLE.rearOverhang < cy.x + 8) edge = Math.min(edge, w.z - VEHICLE.width / 2);
    const target = Math.min(0.95, edge - 0.75);
    // Swerving into the opposite lane only when no car is coming
    const oncoming = this.traffic.some((c) => c.active && c.front > cy.x && c.front < cy.x + 30);
    const wait = target < -0.3 && oncoming;
    cy.v = Math.max(0, Math.min(CYCLIST_SPEED, cy.v + (wait ? -3 : 1.2) * dt));
    const v = Math.max(cy.v, 0.01);
    cy.x += cy.v * dt;
    cy.dist += cy.v * dt;
    const dz = wait ? 0 : Math.max(-0.9 * dt, Math.min(0.9 * dt, target - cy.z)) * Math.min(1, cy.v / 2);
    cy.z += dz;
    this.rider.root.position.set(cy.x, 0, cy.z);
    this.rider.root.rotation.y = -Math.atan2(dz / dt, v);
    this.rider.animate(cy.dist);
    cy.near = this.checkHazard(cy.near, cy.x, cy.z, body, 'cyclist', now);
    if (cy.x > ego.x + 70) {
      cy.active = false;
      this.rider.root.visible = false;
    }
  }

  /** Empty hook for the hazard behaviour (to be designed by the group): called once per approach. */
  private checkHazard(wasNear: boolean, x: number, z: number, body: [number, number][], kind: HazardEvent['kind'], now: number) {
    if (!this.settings.hazard) return false;
    let d = Infinity;
    for (let i = 0; i < 4; i++) {
      const [ax, az] = body[i];
      const [bx, bz] = body[(i + 1) % 4];
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
      d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)));
    }
    if (d < 1.0 && !wasNear) this.onHazard({ kind, distance: d, t: now });
    return d < 1.0 ? true : d > 2.0 ? false : wasNear;
  }
}
