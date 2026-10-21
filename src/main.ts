import * as THREE from 'three';
import GUI from 'lil-gui';
import { PHYSICS_DT, START, TARGET_SPACE_LENGTH, VEHICLE } from './config';
import { World, type Quality, type TimeOfDay } from './scene/world';
import { buildStreet } from './scene/street';
import { createCar, poseCar } from './vehicle/carModel';
import { VehicleState } from './vehicle/kinematics';
import { Keyboard } from './vehicle/input';
import { Views, VIEW_LABELS } from './views/cameras';
import { Hud } from './ui/hud';
import { CentralDisplay } from './display/centralDisplay';
import { Collisions, type ContactKind } from './vehicle/collision';
import { MirrorReflection, aimMirror } from './mirrors/mirrorReflection';
import { LightBar, type BarView } from './mirrors/lightBar';
import type { ParkPlan } from './planner/parallelPlanner';
import { PHASE_LABELS } from './modes/assisted';
import { GlideFlow } from './modes/flow';
import { ReconView } from './display/recon';
import { RearCamera } from './display/rearCamera';

const app = document.getElementById('app')!;
const world = new World(app);
const street = buildStreet(world, TARGET_SPACE_LENGTH);

const rig = createCar({ color: 0x4f6d7a, interior: true });
world.scene.add(rig.root);
const car = new VehicleState();
car.reset(START.x, START.z, START.heading);

const collisions = new Collisions([...street.parkedCars, ...street.oppositeCars]);

// Mirrors: glass aimed from the driver's eye; right one convex (EU passenger side)
const eyeLocal = new THREE.Vector3(VEHICLE.eye.x, VEHICLE.eye.y, VEHICLE.eye.z);
const glassOf = (g: THREE.Object3D) => g.getObjectByName('glass') as THREE.Mesh;
aimMirror(rig.mirrors.left, glassOf(rig.mirrors.left), eyeLocal, new THREE.Vector3(-1, -0.02, -0.06));
aimMirror(rig.mirrors.right, glassOf(rig.mirrors.right), eyeLocal, new THREE.Vector3(-1, -0.07, 0.05));
const mirrors = [
  new MirrorReflection(glassOf(rig.mirrors.left), 0.85),
  new MirrorReflection(glassOf(rig.mirrors.right), 0.55),
];
for (const m of mirrors) m.hide = [rig.mirrors.left, rig.mirrors.right];

// Light bars on the mirror rims; the zero end is always the one towards the car
const bars = {
  left: new LightBar(0.18, 0.014, false),
  right: new LightBar(0.18, 0.014, true),
};
rig.mirrors.left.getObjectByName('bar-mount')!.add(bars.left.mesh);
rig.mirrors.right.getObjectByName('bar-mount')!.add(bars.right.mesh);

// --- Glide flow: approach, space choice, P, mode choice, assisted manoeuvre, end ---
const flowSettings = { cameraWhileMoving: false, curbPoorlyVisible: false };
const flow = new GlideFlow(street.spaces, collisions, flowSettings, (e) => console.debug('[glide]', e), START.z);
let lastBarViews: { left: BarView; right: BarView } | null = null;
let shownPlan: ParkPlan | null = null;
const pathLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x35d0ff, depthTest: false, transparent: true, opacity: 0.8 }),
);
pathLine.renderOrder = 10;
pathLine.visible = false;
world.scene.add(pathLine);

/** Debug: planned rear-axle trajectory drawn on the road while the HUD is visible. */
function showPath(plan: ParkPlan | null) {
  if (plan !== shownPlan && plan) pathLine.geometry.setFromPoints(plan.path.map((p) => new THREE.Vector3(p.x, 0.03, p.z)));
  shownPlan = plan;
  pathLine.visible = !!plan && hud.visible;
}

const views = new Views(rig, world.renderer.domElement);
const display = new CentralDisplay(rig.displayMesh!);
const recon = new ReconView(street.parkedCars, street.oppositeCars, street.spaces, 640, 576);
const rearCam = new RearCamera(rig, 640, 576);
const hud = new Hud();
const keys = new Keyboard();

// --- parameters panel (F1); the full panel arrives in milestone 8 ---
const params = { time: 'day' as TimeOfDay, quality: 'high' as Quality };
const gui = new GUI({ title: 'Parametri' });
const sceneFolder = gui.addFolder('Scena');
const displayFolder = gui.addFolder('Display');
sceneFolder.add(params, 'time', { Giorno: 'day', Sera: 'evening' }).name('Ora').onChange((t: TimeOfDay) => world.setTime(t));
const qualityCtrl = sceneFolder
  .add(params, 'quality', { Alta: 'high', Bassa: 'low' })
  .name('Qualità grafica')
  .onChange((q: Quality) => setQuality(q));
function setQuality(q: Quality) {
  world.setQuality(q);
  for (const m of mirrors) m.setResolution(q === 'high' ? 640 : 320);
}
displayFolder.add(flowSettings, 'cameraWhileMoving').name('Telecamera in movimento');
let guiVisible = false;
gui.show(guiVisible);
world.setTime('day');

// --- commands ---
let gearMsg = '';
keys.on('KeyR', () => (gearMsg = car.setGear('R') ? '' : 'Fermati per inserire la retro'));
keys.on('KeyD', () => (gearMsg = car.setGear('D') ? '' : 'Fermati per inserire la marcia'));
keys.on('KeyC', () => views.cycle());
keys.on('KeyV', () => (views.split = !views.split));
keys.on('KeyH', () => hud.toggle());
const nowS = () => performance.now() / 1000;
keys.on('KeyE', () => flow.onBlinker('right', car, nowS()));
keys.on('KeyQ', () => flow.onBlinker('left', car, nowS()));
keys.on('KeyP', () => flow.onParkButton(car, nowS(), contacts));
keys.on('Digit1', () => flow.onModeChosen('assisted', car, nowS()));
keys.on('Digit2', () => flow.onModeChosen('auto', car, nowS()));
keys.on('F1', () => gui.show((guiVisible = !guiVisible)));
keys.on('Escape', () => {
  car.reset(START.x, START.z, START.heading);
  views.resetChase();
  gearMsg = '';
  contacts = 0;
  inContact = null;
  flow.reset();
});

window.addEventListener('resize', () => world.resize());

// --- loop ---
const timer = new THREE.Timer();
timer.connect(document);
let acc = 0;
let fpsTime = 0;
let fpsFrames = 0;
let fps = 60;
let lowFpsSeconds = 0;
let autoDowngraded = false;

// Contacts: the car stops at the last free pose. A contact counts once, until the car
// has moved at least CONTACT_RELEASE metres away from where it happened.
const CONTACT_RELEASE = 0.15;
let contacts = 0;
let inContact: ContactKind | null = null;
let contactAt = { x: 0, z: 0 };
const CONTACT_LABEL: Record<ContactKind, string> = { auto: 'auto parcheggiata', cordolo: 'cordolo' };

function physicsStep(input: ReturnType<Keyboard['drive']>) {
  const before = car.snapshot();
  car.step(input, PHYSICS_DT);
  const hit = collisions.check(car.x, car.z, car.heading, car.steer);
  // Already overlapping (e.g. after a reset onto an obstacle): let the car move out
  const wasHit = hit && collisions.check(before.x, before.z, before.heading, before.steer);
  if (hit && !wasHit) {
    car.restore(before);
    if (!inContact) contacts++;
    inContact = hit;
    contactAt = { x: car.x, z: car.z };
  } else if (inContact && Math.hypot(car.x - contactAt.x, car.z - contactAt.z) > CONTACT_RELEASE) {
    inContact = null;
  }
}

function frame(time: number) {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  acc += dt;
  const input = keys.drive();
  while (acc >= PHYSICS_DT) {
    physicsStep(input);
    acc -= PHYSICS_DT;
  }

  poseCar(rig, car.x, car.z, car.heading, car.steer, car.wheelSpin, car.steeringWheelDeg);
  rig.root.updateMatrixWorld();
  views.update(car.x, car.z, car.heading, dt);
  world.followSun(car.x, car.z);
  views.glance = keys.isDown('KeyZ') ? 'left' : keys.isDown('KeyX') ? 'right' : null;

  const now = performance.now() / 1000;
  const out = flow.update(car, now, contacts);
  bars.left.draw(out.bars.left, now);
  bars.right.draw(out.bars.right, now);
  lastBarViews = out.bars;
  showPath(flow.maneuver?.plan ?? null);

  // Spaces in the reconstruction: blue where the car fits, highlighted when chosen
  for (const sp of street.spaces) {
    const fits = flow.evaluation?.space === sp ? flow.evaluation.fits : flow.fits.get(sp.id)!;
    const chosen = flow.chosen === sp && (flow.screen === 'approach' || flow.screen === 'choose');
    recon.setSpaceLook(sp.id, chosen ? (fits ? 'chosen' : 'chosenNoFit') : fits ? 'fits' : 'noFit');
  }
  const vp = CentralDisplay.viewportFor(out.display);
  if (vp === 'recon') recon.render(world.renderer, { x: car.x, z: car.z, heading: car.heading }, dt);
  if (vp === 'camera') {
    world.renderer.shadowMap.needsUpdate = true;
    rearCam.render(world.renderer, world.scene);
  }
  display.update(out.display, now, recon.target.texture, rearCam, flow.guide);

  render();

  // FPS and automatic low-quality fallback
  fpsFrames++;
  fpsTime += dt;
  if (fpsTime >= 0.5) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0;
    fpsTime = 0;
    lowFpsSeconds = fps < 40 ? lowFpsSeconds + 0.5 : 0;
    if (!autoDowngraded && params.quality === 'high' && lowFpsSeconds >= 3) {
      autoDowngraded = true;
      params.quality = 'low';
      setQuality('low');
      qualityCtrl.updateDisplay();
    }
  }

  hud.set([
    `Vista     ${views.split ? 'Split' : VIEW_LABELS[views.current]}`,
    `Marcia    ${car.gear}`,
    `Velocità  ${(car.speed * 3.6).toFixed(1)} km/h`,
    `Ruote     ${THREE.MathUtils.radToDeg(car.steer).toFixed(1)}°`,
    `Volante   ${car.steeringWheelDeg.toFixed(0)}°`,
    `Posizione x ${car.x.toFixed(2)}  z ${car.z.toFixed(2)}  ψ ${THREE.MathUtils.radToDeg(car.heading).toFixed(1)}°`,
    `Contatti  ${contacts}${inContact ? `  ⚠ contatto con ${CONTACT_LABEL[inContact]}` : ''}`,
    ...assistHud(),
    `FPS       ${fps.toFixed(0)}${autoDowngraded ? ' (qualità bassa automatica)' : ''}`,
    gearMsg,
  ]);
  requestAnimationFrame(frame);
}

function assistHud(): string[] {
  const m = flow.maneuver;
  if (!m) return [`Flusso    ${flow.screen}${flow.chosen ? ` · spazio ${flow.chosen.id}` : ''}`];
  const pl = m.plan;
  const deg = (r: number) => THREE.MathUtils.radToDeg(r).toFixed(0);
  const lines = [
    `Fase      ${PHASE_LABELS[m.phase]} — ${m.instruction}`,
    `Piano     sterzo ${deg(pl.steer1)}° / controsterzo ${deg(pl.steer2)}°, margine min ${(pl.minCarClearance * 100).toFixed(0)} cm`,
    `Oltre     ${m.overs}   errori sterzo ${m.steerErrors.map((e) => (e * 100).toFixed(0) + '%').join(' ')}`,
  ];
  if (m.result) {
    const r = m.result;
    lines.push(
      `Risultato ${r.seconds.toFixed(0)} s, cordolo ${(r.curbGap * 100).toFixed(0)} cm, davanti ${(r.frontGap * 100).toFixed(0)} cm, dietro ${(r.rearGap * 100).toFixed(0)} cm`,
    );
  }
  return lines;
}

const eyeWorld = new THREE.Vector3();

function render() {
  const r = world.renderer;
  const w = window.innerWidth;
  const h = window.innerHeight;

  // Shadow map once per frame, shared by the mirror and main passes
  r.shadowMap.needsUpdate = true;
  // Mirrors reflect what the driver sees; from the chase view, what an outside observer sees
  if (views.split || views.current !== 'top') {
    (views.split || views.current === 'driver' ? views.driver : views.chase).getWorldPosition(eyeWorld);
    for (const m of mirrors) m.render(r, world.scene, eyeWorld);
  }
  if (!views.split) {
    r.setScissorTest(false);
    r.setViewport(0, 0, w, h);
    views.setAspect(views.current, w / h);
    r.render(world.scene, views.active);
    hud.setSplitLabels(null, null);
    return;
  }
  r.setScissorTest(true);
  const half = Math.floor(w / 2);
  views.setAspect('driver', half / h);
  views.setAspect('chase', (w - half) / h);
  r.setViewport(0, 0, half, h);
  r.setScissor(0, 0, half, h);
  r.render(world.scene, views.driver);
  r.setViewport(half, 0, w - half, h);
  r.setScissor(half, 0, w - half, h);
  r.render(world.scene, views.chase);
  hud.setSplitLabels(VIEW_LABELS.driver, VIEW_LABELS.chase);
}

// Expose for debugging in the console
Object.assign(window, { car, street, world, views, rig, getManeuver: () => flow.maneuver, flow, flowSettings, getBars: () => lastBarViews });
requestAnimationFrame(frame);
