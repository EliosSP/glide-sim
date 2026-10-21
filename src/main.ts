import * as THREE from 'three';
import GUI from 'lil-gui';
import { PHYSICS_DT, START } from './config';
import { World, type Quality, type TimeOfDay } from './scene/world';
import { buildStreet } from './scene/street';
import { createCar, poseCar } from './vehicle/carModel';
import { VehicleState } from './vehicle/kinematics';
import { Keyboard } from './vehicle/input';
import { Views, VIEW_LABELS } from './views/cameras';
import { Hud } from './ui/hud';
import { CentralDisplay } from './display/centralDisplay';

const app = document.getElementById('app')!;
const world = new World(app);
const street = buildStreet(world);

const rig = createCar({ color: 0x4f6d7a, interior: true });
world.scene.add(rig.root);
const car = new VehicleState();
car.reset(START.x, START.z, START.heading);

const views = new Views(rig, world.renderer.domElement);
const display = new CentralDisplay(rig.displayMesh!);
const hud = new Hud();
const keys = new Keyboard();

// --- parameters panel (F1); the full panel arrives in milestone 8 ---
const params = { time: 'day' as TimeOfDay, quality: 'high' as Quality };
const gui = new GUI({ title: 'Parametri' });
const sceneFolder = gui.addFolder('Scena');
sceneFolder.add(params, 'time', { Giorno: 'day', Sera: 'evening' }).name('Ora').onChange((t: TimeOfDay) => world.setTime(t));
const qualityCtrl = sceneFolder
  .add(params, 'quality', { Alta: 'high', Bassa: 'low' })
  .name('Qualità grafica')
  .onChange((q: Quality) => world.setQuality(q));
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
keys.on('F1', () => gui.show((guiVisible = !guiVisible)));
keys.on('Escape', () => {
  car.reset(START.x, START.z, START.heading);
  views.resetChase();
  gearMsg = '';
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

function frame(time: number) {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  acc += dt;
  const input = keys.drive();
  while (acc >= PHYSICS_DT) {
    car.step(input, PHYSICS_DT);
    acc -= PHYSICS_DT;
  }

  poseCar(rig, car.x, car.z, car.heading, car.steer, car.wheelSpin, car.steeringWheelDeg);
  rig.root.updateMatrixWorld();
  views.update(car.x, car.z, car.heading, dt);
  world.followSun(car.x, car.z);
  display.update(car.gear, Math.abs(car.speed) * 3.6);

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
      world.setQuality('low');
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
    `FPS       ${fps.toFixed(0)}${autoDowngraded ? ' (qualità bassa automatica)' : ''}`,
    gearMsg,
  ]);
  requestAnimationFrame(frame);
}

function render() {
  const r = world.renderer;
  const w = window.innerWidth;
  const h = window.innerHeight;
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
Object.assign(window, { car, street, world });
requestAnimationFrame(frame);
