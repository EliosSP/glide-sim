import * as THREE from 'three';
import GUI from 'lil-gui';
import { PHYSICS_DT, ROAD, START, TARGET_SPACE_LENGTH, VEHICLE } from './config';
import { DEFAULT_ASSIST } from './modes/assisted';
import { DEFAULT_BAR_STYLE, type BarStyle } from './mirrors/lightBar';
import { World, type Quality, type TimeOfDay } from './scene/world';
import { buildStreet } from './scene/street';
import { createCar, poseCar } from './vehicle/carModel';
import { VehicleState, type DriveInput } from './vehicle/kinematics';
import { Keyboard } from './vehicle/input';
import { DEBUG_LAYER, Views, VIEW_LABELS, type Glance } from './views/cameras';
import { Hud } from './ui/hud';
import { CentralDisplay, type ReconLabel } from './display/centralDisplay';
import { Collisions, type ContactKind } from './vehicle/collision';
import { MirrorReflection, aimMirror } from './mirrors/mirrorReflection';
import { LightBar, type BarView } from './mirrors/lightBar';
import type { ParkPlan } from './planner/parallelPlanner';
import { PHASE_LABELS } from './modes/assisted';
import { GlideFlow, type FlowEvent } from './modes/flow';
import { GlideAudio } from './audio/sounds';
import { Narrator } from './audio/narrator';
import { DemoDirector } from './modes/demo';
import { Subtitles, TrialIndicator } from './ui/overlay';
import { Logger, download } from './ui/logger';
import { bodyToCurb } from './vehicle/collision';
import { HeadTracker } from './tracking/headTracker';
import { WebcamHeadSource } from './tracking/headSource';
import { TrackingPreview } from './tracking/preview';
import { DEFAULT_MAPPING, mapHead, mirrorInView, type MirrorGlance } from './tracking/headMapping';
import { CalibrationGuide } from './tracking/calibration';
import { Actors, scenarioSettings, type ActorContext, type ActorSettings, type Scenario } from './actors/actors';
import { ReconView } from './display/recon';
import { RearCamera } from './display/rearCamera';

// Single simulation clock: every module receives `now` from here. With ?fixedStep=1 each frame advances
// a fixed 1/60 s whatever the real frame time (headless browsers, demo recording, automated tests).
const URL_PARAMS = new URLSearchParams(location.search);
const FIXED_STEP = URL_PARAMS.get('fixedStep') === '1';
const FRAME_DT = 1 / 60;
let simTime = 0;
const nowS = () => simTime;

const app = document.getElementById('app')!;
const world = new World(app);
// Target space length: ?space=<metres> (the street is built once, so it changes with a reload)
const spaceParam = Number(new URLSearchParams(location.search).get('space'));
const SPACE_LENGTH = spaceParam >= VEHICLE.length + 0.5 && spaceParam <= VEHICLE.length + 5 ? spaceParam : TARGET_SPACE_LENGTH;
const street = buildStreet(world, SPACE_LENGTH);

// Jacopo's mirrors sit higher than on the parked cars: the glass and its light bar stay above the door line
const rig = createCar({ color: 0x4f6d7a, interior: true, mirrorRaise: 0.06 });
world.scene.add(rig.root);
const car = new VehicleState();
car.reset(START.x, START.z, START.heading);

const collisions = new Collisions([...street.parkedCars, ...street.oppositeCars]);

// Mirrors: glass aimed from the driver's eye; right one convex (EU passenger side)
const eyeLocal = new THREE.Vector3(VEHICLE.eye.x, VEHICLE.eye.y, VEHICLE.eye.z);
const glassOf = (g: THREE.Object3D) => g.getObjectByName('glass') as THREE.Mesh;
aimMirror(rig.mirrors.left, glassOf(rig.mirrors.left), eyeLocal, new THREE.Vector3(-1, -0.02, -0.06));
aimMirror(rig.mirrors.right, glassOf(rig.mirrors.right), eyeLocal, new THREE.Vector3(-1, -0.07, 0.05));
const MIRROR_RES = { high: 1024, low: 512 }; // side mirrors; the rear-view mirror uses half
const mirrors = [
  new MirrorReflection(glassOf(rig.mirrors.left), 0.85, MIRROR_RES.high, 0.3),
  new MirrorReflection(glassOf(rig.mirrors.right), 0.55, MIRROR_RES.high, 0.3),
];
for (const m of mirrors) m.hide = [rig.mirrors.left, rig.mirrors.right];
// Interior rear-view mirror: flat, lower resolution, only rendered when the driver view is on screen
const rearMirrorGroup = rig.rearMirror!;
aimMirror(rearMirrorGroup, glassOf(rearMirrorGroup), eyeLocal, new THREE.Vector3(-1, -0.04, 0));
const rearMirror = new MirrorReflection(glassOf(rearMirrorGroup), 1, MIRROR_RES.high / 2, 0.45);
rearMirror.hide = [rearMirrorGroup];
let frameNo = 0;

// Light bars on the mirror rims; the zero end is always the one towards the car
const bars = {
  left: new LightBar(0.18, 0.016, false),
  right: new LightBar(0.18, 0.016, true),
};
// Bar look, edited live from the panel; turquoise variant for the autonomous mode
const barStyle: BarStyle = { ...DEFAULT_BAR_STYLE };
const barLook = { turquoiseAuto: false, grayscale: false, position: 'bottom' as 'bottom' | 'top' };

/** Light bar on the lower rim (concept) or on the upper rim of the mirror housing. */
function placeBars() {
  for (const g of [rig.mirrors.left, rig.mirrors.right]) g.getObjectByName('bar-mount')!.position.y = barLook.position === 'top' ? 0.06 : -0.0695;
}
const TURQUOISE = '#5fe8dc';
const autoBarStyle: BarStyle = { ...barStyle, color: TURQUOISE };
const AUTO_SCREENS = new Set(['autoRunning', 'autoReplan', 'autoStopped']);
rig.mirrors.left.getObjectByName('bar-mount')!.add(bars.left.mesh);
rig.mirrors.right.getObjectByName('bar-mount')!.add(bars.right.mesh);
placeBars();

// --- Glide flow: approach, space choice, P, mode choice, assisted manoeuvre, end ---
const flowSettings = {
  cameraWhileMoving: false,
  curbPoorlyVisible: false,
  speedProfile: 'fluid' as 'fluid' | 'abrupt',
  autoLead: 1.0,
  assist: { ...DEFAULT_ASSIST },
};
const audio = new GlideAudio();
const logger = new Logger();
const flow = new GlideFlow(street.spaces, collisions, flowSettings, onFlowEvent, START.z);

// --- other actors (scenario "Vuoto" / "Animato") ---
const actorSettings: ActorSettings = { ...scenarioSettings('empty'), waitingGap: 6, hazard: false };
const actors = new Actors(world.scene, collisions, actorSettings);
actors.onSettled = () => flow.onTrafficSettled(car, nowS(), "L'auto dietro è troppo vicina");
actors.onHazard = (e) => {
  console.debug('[glide] hazard', e);
  flow.onHazard(e);
};

/** Sounds (only short confirmations), the actors that react to Glide, and the test log. */
function onFlowEvent(e: FlowEvent) {
  console.debug('[glide]', e);
  logFlowEvent(e);
  switch (e.type) {
    case 'confirm':
    case 'pointReached':
      audio.confirm(e.side);
      break;
    case 'parkActive':
      audio.parkOn();
      actors.onParkActivated({ x: car.x, z: car.z, heading: car.heading });
      break;
    case 'autoStart':
      audio.start();
      break;
    case 'autoDone':
      audio.end();
      break;
    case 'phase':
      if (e.phase === 'done') audio.end();
      break;
  }
}

/** Flow events → rows of the test log (names as in the spec). */
function logFlowEvent(e: FlowEvent) {
  const now = nowS();
  const phase = flow.maneuver?.phase ?? flow.screen;
  const L = (event: string, f: Parameters<Logger['log']>[2] = {}) => logger.log(now, event, { phase, ...f });
  switch (e.type) {
    case 'parkButton': return L('park_button');
    case 'parkActive': return L('park_active', { extra: { recommended: flow.recommendation?.mode, reason: flow.recommendation?.reason } });
    case 'modeChosen': return L('mode_chosen', { value: e.mode });
    case 'phase':
      if (e.phase !== 'done') return L('phase', { phase: e.phase, value: e.phase });
      return; // logged with its result in the frame loop
    case 'confirm': return L('confirm', { side: e.side });
    case 'pointReached': return L('point_reached', { side: e.side });
    case 'over': return L('over', { value: e.what });
    case 'steerError': return L('steer_error', { phase: e.phase, value: e.error });
    case 'autoStart': return L('auto_start');
    case 'takeover': return L('takeover');
    case 'lowConfidence': return L('low_confidence');
    case 'trajectoryChange': return L('trajectory_change');
    case 'switchToAssisted': return L('switch_to_assisted', { value: e.from });
    case 'manual': return L('manual');
    case 'cancel':
      logger.setOutcome('cancel');
      return L('cancel', { value: e.from });
    case 'autoDone': {
      const pose = { x: car.x, z: car.z, heading: car.heading };
      const g = collisions.frontRearGaps(pose);
      logger.setOutcome('done');
      return L('auto_done', { value: e.seconds, extra: { minClearance: e.minClearance, curbGap: bodyToCurb(pose), frontGap: g.front, rearGap: g.rear } });
    }
  }
}

const MANEUVER_SCREENS = new Set<GlideFlow['screen']>(['choose', 'assisted', 'assistBlocked', 'autoPreview', 'autoRunning', 'autoStopped', 'autoReplan']);
const SENSOR_SCREENS = new Set<GlideFlow['screen']>(['assisted', 'autoRunning', 'autoReplan', 'autoStopped']);

function actorContext(): ActorContext {
  let counterSteer = flow.screen === 'assisted' && flow.maneuver?.phase === 'steer2';
  const a = flow.auto;
  if (a && flow.screen === 'autoRunning') {
    const t2 = a.timeline.stageStart('arc2');
    counterSteer = t2 !== null && a.t >= t2 - 2.5;
  }
  return { maneuver: MANEUVER_SCREENS.has(flow.screen), counterSteer, egoSpeed: car.speed };
}
let lastBarViews: { left: BarView; right: BarView } | null = null;
let shownPlan: ParkPlan | null = null;
const pathLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x35d0ff, depthTest: false, transparent: true, opacity: 0.8 }),
);
pathLine.renderOrder = 10;
pathLine.visible = false;
pathLine.layers.set(DEBUG_LAYER);
world.scene.add(pathLine);

/** Debug: planned rear-axle trajectory on the road (panel toggle), only in the outside views. */
function showPath(plan: ParkPlan | null) {
  if (plan !== shownPlan && plan) pathLine.geometry.setFromPoints(plan.path.map((p) => new THREE.Vector3(p.x, 0.03, p.z)));
  shownPlan = plan;
  pathLine.visible = !!plan && debug.showPath;
}

const views = new Views(rig, world.renderer.domElement);
const display = new CentralDisplay(rig.displayMesh!);
const recon = new ReconView(street.parkedCars, street.oppositeCars, street.spaces, 640, 576);
const rearCam = new RearCamera(rig, 640, 576);
const hud = new Hud();
const keys = new Keyboard();

// --- parameters panel (F1); the full panel arrives in milestone 8 ---
const params = { time: 'day' as TimeOfDay, quality: 'high' as Quality };
const debug = { showPath: false };
const gui = new GUI({ title: 'Parametri' });
const sceneFolder = gui.addFolder('Scena');
const actorsFolder = gui.addFolder('Scenario e attori');
const soundFolder = gui.addFolder('Suoni');
const displayFolder = gui.addFolder('Display');
sceneFolder.add(params, 'time', { Giorno: 'day', Sera: 'evening' }).name('Ora').onChange((t: TimeOfDay) => world.setTime(t));
const qualityCtrl = sceneFolder
  .add(params, 'quality', { Alta: 'high', Bassa: 'low' })
  .name('Qualità grafica')
  .onChange((q: Quality) => setQuality(q));
function setQuality(q: Quality) {
  world.setQuality(q);
  for (const m of mirrors) m.setResolution(MIRROR_RES[q]);
  rearMirror.setResolution(MIRROR_RES[q] / 2);
}
displayFolder.add(flowSettings, 'cameraWhileMoving').name('Telecamera in movimento');
const scenarioFolder = gui.addFolder('Autonomo e scenari');
scenarioFolder.add(flowSettings, 'speedProfile', { Fluido: 'fluid', Brusco: 'abrupt' }).name('Profilo velocità');
scenarioFolder.add(flowSettings, 'autoLead', 0.5, 1.5, 0.05).name('Anticipo barra (s)');
scenarioFolder.add(flowSettings, 'curbPoorlyVisible').name('Cordolo poco visibile (I2)');
scenarioFolder.add({ obstacle: () => placeObstacle() }, 'obstacle').name('Ostacolo imprevisto (I3)');
actorsFolder
  .add(actorSettings, 'scenario', { Vuoto: 'empty', Animato: 'busy' })
  .name('Scenario (N)')
  .onChange((sc: Scenario) => setScenario(sc));
actorsFolder.add(actorSettings, 'pedestrians').name('Pedoni').onChange(() => actors.applySettings());
actorsFolder.add(actorSettings, 'waitingCar').name('Auto che aspetta dietro').onChange(() => actors.applySettings());
actorsFolder.add(actorSettings, 'waitingGap', 1.5, 8, 0.1).name('Distanza auto dietro (m)');
actorsFolder.add(actorSettings, 'tooClose').name('Si infila troppo vicina');
actorsFolder.add(actorSettings, 'cyclist').name('Ciclista (controsterzo)').onChange(() => actors.applySettings());
actorsFolder.add(actorSettings, 'traffic').name('Traffico corsia opposta').onChange(() => actors.applySettings());
actorsFolder.add(actorSettings, 'hazard').name('Pericolo (hook onHazard)');
soundFolder.add(audio, 'volume', 0, 1, 0.05).name('Volume');

// Mirror bar and assisted grammar: all live, the next frame uses the new values
const barFolder = gui.addFolder('Barra luminosa');
barFolder.add(flowSettings.assist, 'notchTol', 0.05, 0.1, 0.005).name('Tolleranza tacca (± escursione)');
barFolder.add(flowSettings.assist, 'announceLead', 1.0, 2.5, 0.05).name('Anticipo preannuncio (s)');
barFolder.add(flowSettings.assist, 'segments', 4, 12, 1).name('Segmenti countdown');
barFolder.add(barStyle, 'blinkCount', 1, 4, 1).name('Lampeggi di conferma');
barFolder.add(barStyle, 'blinkOn', 0.05, 0.4, 0.01).name('Lampeggio acceso (s)');
barFolder.add(barStyle, 'blinkOff', 0.05, 0.4, 0.01).name('Lampeggio spento (s)');
let lastBarColor = barStyle.color;
const colorCtrl = barFolder.addColor(barStyle, 'color').name('Colore barra').onChange((c: string) => {
  // The light must never look like a turn signal
  if (isOrange(c)) {
    barStyle.color = lastBarColor;
    colorCtrl.updateDisplay();
    colorCtrl.name('Colore barra (arancione non ammesso)');
    setTimeout(() => colorCtrl.name('Colore barra'), 2500);
  } else {
    lastBarColor = c;
  }
});
barFolder.add(barStyle, 'brightness', 0.3, 1.5, 0.05).name('Luminosità barra');
barFolder.add(barLook, 'position', { Sotto: 'bottom', Sopra: 'top' }).name('Posizione barra').onChange(() => placeBars());
barFolder.add(barLook, 'turquoiseAuto').name('Turchese in autonomo');
barFolder.add(barLook, 'grayscale').name('Scala di grigi').onChange((g: boolean) => {
  world.renderer.domElement.style.filter = g ? 'grayscale(1)' : '';
});

function isOrange(hex: string) {
  const hsl = new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 });
  const h = hsl.h * 360;
  return h >= 12 && h <= 52 && hsl.s > 0.35 && hsl.l > 0.2 && hsl.l < 0.9;
}

// Target space length: the street is rebuilt with a reload (?space=)
const spaceFolder = gui.addFolder('Spazio target');
const space = { length: SPACE_LENGTH };
spaceFolder.add(space, 'length', VEHICLE.length + 0.5, VEHICLE.length + 5, 0.1).name('Lunghezza (m)');
spaceFolder.add({ apply: () => reloadWith({ space: space.length.toFixed(2) }) }, 'apply').name('Applica (ricarica la pagina)');

function reloadWith(p: Record<string, string>) {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(p)) q.set(k, v);
  location.search = q.toString();
}

// Presets: every panel value in a JSON file, so each test session starts identical
const presetFolder = gui.addFolder('Preset');
presetFolder.add({ save: () => savePreset() }, 'save').name('Salva preset (JSON)');
presetFolder.add({ load: () => presetInput.click() }, 'load').name('Carica preset…');
const presetInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'application/json,.json' });
presetInput.addEventListener('change', async () => {
  const f = presetInput.files?.[0];
  presetInput.value = '';
  if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    gui.load(p.panel);
    if (p.panel?.folders?.['Spazio target'] && Math.abs(space.length - SPACE_LENGTH) > 0.01) {
      flow.notice('Preset caricato: per la lunghezza dello spazio premi "Applica"', nowS());
    } else {
      flow.notice('Preset caricato', nowS());
    }
  } catch (err) {
    console.warn('Preset non valido', err);
    flow.notice('Preset non valido', nowS());
  }
});

function savePreset() {
  const panel = gui.save() as { folders: Record<string, unknown> };
  // Participant, trial and demo are not part of a test condition
  delete panel.folders['Sessione di test'];
  delete panel.folders['Demo'];
  const d = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, panel }, null, 2)], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `glide_preset_${d}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

gui.addFolder('Debug').add(debug, 'showPath').name('Mostra traiettoria (debug)');

// --- Head tracking (webcam, all local; only angles are kept). Off by default. Hook 1/3: setup ---
const tracker = new HeadTracker();
const trackingPreview = new TrackingPreview();
const gaze = { follow: false, preview: false, mirrorTolerance: 12 }; // ° view-to-mirror to log a glance
const mapping = { ...DEFAULT_MAPPING }; // [to be tuned with real users]
let glanceSource: 'head' | 'key' | null = null;
const calibration = new CalibrationGuide(tracker);
const gazeMessage = Object.assign(document.createElement('div'), { className: 'gaze-message hidden' });
document.body.append(gazeMessage);
const gazeFolder = gui.addFolder('Sguardo');
const followCtrl = gazeFolder.add(gaze, 'follow').name('Segui la testa (webcam) (T)').onChange((on: boolean) => setHeadTracking(on));
gazeFolder.add({ calibrate: () => calibration.start() }, 'calibrate').name('Calibra (Shift+T)');
gazeFolder.add(gaze, 'preview').name('Mostra anteprima webcam');
gazeFolder.add(mapping, 'deadZone', 0, 10, 0.5).name('Zona morta (°)');
gazeFolder.add(mapping, 'gainYaw', 1, 8, 0.1).name('Guadagno yaw');
gazeFolder.add(mapping, 'gainPitch', 1, 6, 0.1).name('Guadagno pitch');
gazeFolder.add(gaze, 'mirrorTolerance', 3, 25, 1).name('Sguardo registrato entro (°)');
gazeFolder.add(tracker.settings, 'minCutoff', 0.1, 5, 0.1).name('Smoothing minCutoff (Hz)');
gazeFolder.add(tracker.settings, 'beta', 0, 0.2, 0.005).name('Smoothing beta');
gazeFolder.add(tracker.settings, 'invertYaw').name('Inverti yaw');
gazeFolder.add(tracker.settings, 'invertPitch').name('Inverti pitch');
tracker.onStatus = (s, prev) => {
  const now = nowS();
  if (s === 'lost') logger.log(now, 'tracking_lost', { phase: flow.maneuver?.phase ?? flow.screen });
  if (s === 'tracking' && prev === 'lost') logger.log(now, 'tracking_recovered', { phase: flow.maneuver?.phase ?? flow.screen });
  if (s === 'tracking' && prev === 'calibrating') logger.log(now, 'tracking_calibrated', { extra: { mapping: { ...mapping }, tracker: { ...tracker.settings }, mirrorTolerance: gaze.mirrorTolerance } });
  if (s === 'error') {
    // Permission denied or no camera: back to the keys, no blocking error
    gaze.follow = false;
    followCtrl.updateDisplay();
    flow.notice(`${tracker.error}: uso i tasti Z/X`, nowS());
  }
};

/** Detection time and rate of the webcam source, for the latency estimate. */
function headStats() {
  const src = headSource;
  return src ? ` · rilevamento ${src.stats.detectMs.toFixed(1)} ms a ${src.stats.rate.toFixed(0)} Hz` : '';
}
let headSource: WebcamHeadSource | null = null;

function setHeadTracking(on: boolean) {
  gaze.follow = on;
  followCtrl.updateDisplay();
  if (on) {
    headSource = new WebcamHeadSource();
    void tracker.start(headSource);
    calibration.start();
  } else {
    tracker.stop();
    calibration.cancel();
  }
}

function setScenario(sc: Scenario) {
  applyScenario(sc);
  resetAll();
  flow.notice(sc === 'busy' ? 'Scenario animato' : 'Scenario vuoto', nowS());
}

function applyScenario(sc: Scenario) {
  Object.assign(actorSettings, scenarioSettings(sc));
  for (const c of actorsFolder.controllers) c.updateDisplay();
  actors.applySettings();
}
actors.applySettings();

let guiVisible = false;
gui.show(guiVisible);
world.setTime('day');

// --- test mode (?test=1): no debug information for the participant, discreet trial indicator ---
const session = { participant: '', trial: 1, testMode: false, indicator: true };
const indicator = new TrialIndicator();
const sessionFolder = gui.addFolder('Sessione di test');
sessionFolder.add(session, 'testMode').name('Modalità test').onChange((on: boolean) => setTestMode(on));
sessionFolder.add(session, 'participant').name('ID partecipante').onChange(() => {
  logger.setParticipant(session.participant);
  updateIndicator();
});
sessionFolder.add(session, 'trial').name('Prova n.').listen().disable();
sessionFolder.add(session, 'indicator').name('Indicatore (I)').onChange(() => updateIndicator());
const logState = { active: true };
sessionFolder.add(logState, 'active').name('Log attivo').onChange(() => updateLogEnabled());
sessionFolder.add({ exportCsv: () => exportLog() }, 'exportCsv').name('Esporta CSV (L)');
sessionFolder.add({ newSession: () => newSession() }, 'newSession').name('Nuova sessione…');

function updateLogEnabled() {
  logger.enabled = logState.active && !demo.active;
}

function exportLog() {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const base = `glide_${(session.participant || 'anonimo').replace(/[^\w-]+/g, '_')}_${day}`;
  download(`${base}_events.csv`, logger.eventsCsv());
  download(`${base}_summary.csv`, logger.summaryCsv(nowS()));
}

function newSession() {
  if (!confirm(`Nuova sessione: il log in memoria (${logger.eventCount} eventi) verrà cancellato. Hai già esportato i CSV?`)) return;
  logger.newSession();
  session.trial = 1;
  logger.startTrial(session.trial, session.participant, nowS(), trialParams());
  updateIndicator();
}

/** Every active parameter, stored with each trial. */
function trialParams() {
  return {
    scenario: actorSettings.scenario,
    actors: { ...actorSettings },
    speedProfile: flowSettings.speedProfile,
    autoLead: flowSettings.autoLead,
    cameraWhileMoving: flowSettings.cameraWhileMoving,
    curbPoorlyVisible: flowSettings.curbPoorlyVisible,
    assist: { ...flowSettings.assist },
    bar: { ...barStyle, ...barLook },
    spaceLength: SPACE_LENGTH,
    time: params.time,
    quality: params.quality,
    volume: audio.volume,
    testMode: session.testMode,
    headTracking: gaze.follow ? { mapping: { ...mapping }, tracker: { ...tracker.settings }, mirrorTolerance: gaze.mirrorTolerance } : false,
  };
}

function updateIndicator() {
  indicator.set(session.participant, session.trial);
  indicator.show(session.testMode && session.indicator && !demo.active);
}

function setTestMode(on: boolean) {
  session.testMode = on;
  hud.setVisible(!on);
  debug.showPath = false;
  if (on) {
    views.split = false;
    views.current = 'driver';
    gui.show((guiVisible = false));
  }
  for (const c of gui.controllersRecursive()) c.updateDisplay();
  updateIndicator();
}

// --- pitch demo (?demo=1 or 0): scripted, no input, 16:9, debug UI hidden ---
const subtitles = new Subtitles();
const demoSettings = { subtitles: true, takeover: false };
// Voice-over: mp3 per line in public/voice/ (see README); the subtitles are its transcript
const narrator = new Narrator();
narrator.onLine = (text) => {
  subtitleText = demoSettings.subtitles ? text : null;
};
let demoGlance: Glance = null;
const demo = new DemoDirector(
  {
    car,
    flow,
    bars: () => lastBarViews,
    command: (c) => {
      const now = nowS();
      if (c === 'blinkerRight') flow.onBlinker('right', car, now);
      else if (c === 'park') flow.onParkButton(car, now, contacts);
      else if (c === 'assisted') flow.onModeChosen('assisted', car, now);
      else if (c === 'auto') flow.onModeChosen('auto', car, now);
      else if (c === 'start') flow.onStart(car, now);
      else car.setGear(c === 'gearR' ? 'R' : 'D');
    },
    reset: (sc, x) => {
      applyScenario(sc);
      resetAll(x);
    },
    camera: (view, glance = null, opts = {}) => {
      views.split = false;
      views.current = view;
      views.glanceZoom = opts.zoom ?? null;
      views.closeUp = opts.closeUp ?? null;
      demoGlance = glance;
    },
    voice: narrator,
  },
  demoSettings,
);
let subtitleText: string | null = null;
let hudBeforeDemo = true;
const demoFolder = gui.addFolder('Demo');
demoFolder.add(demoSettings, 'subtitles').name('Sottotitoli (inglese)');
demoFolder.add(narrator, 'enabled').name('Voce narrante');
demoFolder.add(narrator, 'volume', 0, 1, 0.05).name('Volume voce');
demoFolder.add(demoSettings, 'takeover').name('Presa di controllo');
demoFolder.add({ go: () => toggleDemo() }, 'go').name('Avvia / ferma demo (0)');

function toggleDemo() {
  if (demo.active) {
    demo.stop();
    keys.allow = null;
    hud.setVisible(hudBeforeDemo && !session.testMode);
    updateLogEnabled();
    resetAll();
  } else {
    hudBeforeDemo = hud.visible;
    hud.setVisible(false);
    gui.show((guiVisible = false));
    debug.showPath = false;
    keys.allow = new Set(['Digit0', 'Escape', 'KeyF']);
    logger.endTrial(nowS(), 'reset');
    demo.start();
    updateLogEnabled();
  }
  demoGlance = null;
  views.glanceZoom = null;
  views.closeUp = null;
  subtitleText = null;
  layout();
  updateIndicator();
}

/** Full window, or the largest 16:9 picture centred in it during the demo. */
function layout() {
  let w = window.innerWidth;
  let h = window.innerHeight;
  if (demo.active) {
    w = Math.min(w, Math.round((h * 16) / 9));
    h = Math.round((w * 9) / 16);
  }
  world.resize(w, h);
  const c = world.renderer.domElement;
  c.style.position = 'absolute';
  c.style.left = `${Math.round((window.innerWidth - w) / 2)}px`;
  c.style.top = `${Math.round((window.innerHeight - h) / 2)}px`;
}

// --- commands ---
let gearMsg = '';
keys.on('KeyR', () => (gearMsg = car.setGear('R') ? '' : 'Fermati per inserire la retro'));
keys.on('KeyD', () => (gearMsg = car.setGear('D') ? '' : 'Fermati per inserire la marcia'));
keys.on('KeyC', () => views.cycle());
keys.on('KeyV', () => (views.split = !views.split));
keys.on('KeyH', () => hud.toggle());
keys.on('KeyE', () => blinker('right'));
keys.on('KeyQ', () => blinker('left'));
keys.on('KeyL', () => exportLog());
// Head tracking: T on/off, Shift+T recalibrate
keys.on('KeyT', () => (keys.isDown('ShiftLeft') || keys.isDown('ShiftRight') ? calibration.start() : setHeadTracking(!gaze.follow)));

function blinker(side: 'left' | 'right') {
  flow.onBlinker(side, car, nowS());
  const ev = flow.evaluation;
  if (ev) logger.log(nowS(), 'space_evaluated', { phase: flow.screen, side, value: ev.fits ? 'fits' : 'no_fit', extra: { space: ev.space.id, title: ev.title, line: ev.line } });
}
keys.on('KeyP', () => flow.onParkButton(car, nowS(), contacts));
keys.on('Digit1', () => flow.onModeChosen('assisted', car, nowS()));
keys.on('Digit2', () => flow.onModeChosen('auto', car, nowS()));
keys.on('Enter', () => flow.onStart(car, nowS()));
keys.on('NumpadEnter', () => flow.onStart(car, nowS()));
keys.on('KeyA', () => flow.onSwitchToAssisted(car, nowS()));
keys.on('KeyM', () => flow.onManual(nowS()));
keys.on('F1', () => gui.show((guiVisible = !guiVisible)));
keys.on('KeyG', () => gui.show((guiVisible = !guiVisible))); // F1 changes the brightness on Macs
keys.on('KeyF', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
});
keys.on('KeyN', () => setScenario(actorSettings.scenario === 'empty' ? 'busy' : 'empty'));
keys.on('Escape', () => (demo.active ? toggleDemo() : resetAll()));
keys.on('Backspace', () => resetAll()); // in fullscreen Esc only leaves fullscreen
keys.on('Digit0', () => toggleDemo());
keys.on('KeyI', () => {
  session.indicator = !session.indicator;
  updateIndicator();
});

/** Back to the start of the street; every reset is a new trial. */
function resetAll(x: number = START.x) {
  // Every reset outside the demo closes the trial and starts a new one
  if (!demo.active) {
    logger.endTrial(nowS(), 'reset');
    session.trial++;
    logger.startTrial(session.trial, session.participant, nowS(), trialParams());
  }
  updateIndicator();
  car.reset(x, START.z, START.heading);
  views.resetChase();
  gearMsg = '';
  contacts = 0;
  inContact = null;
  flow.reset();
  removeObstacle();
  actors.reset();
}

// --- I3 test: an object appears at the back of the space (bin by the curb) ---
const binMesh = new THREE.Mesh(
  new THREE.CylinderGeometry(0.32, 0.3, 1.0, 20),
  new THREE.MeshStandardMaterial({ color: 0x3c4a3f, roughness: 0.7 }),
);
binMesh.castShadow = true;
binMesh.visible = false;
world.scene.add(binMesh);

function placeObstacle() {
  const plan = flow.autoPlanNow;
  if (!plan) return;
  // Just behind where the car would end up: the end position must move forward, a single manoeuvre still fits
  const x = plan.final.x - VEHICLE.rearOverhang - 0.22;
  const z = ROAD.curbZ - 0.45;
  binMesh.position.set(x, 0.5, z);
  binMesh.visible = true;
  collisions.addObject('i3', x, z, 0.32, 0.32);
  recon.setObject('i3', { x, z });
  flow.onObstacle(car, nowS());
}

function removeObstacle() {
  binMesh.visible = false;
  collisions.removeObject('i3');
  recon.setObject('i3', null);
}

window.addEventListener('resize', () => layout());
layout();
// The log survives a reload: trial numbers continue in the same session
session.trial = logger.lastTrial + 1;
session.participant = logger.lastParticipant;
logger.startTrial(session.trial, session.participant, nowS(), trialParams());
if (URL_PARAMS.get('test') === '1') setTestMode(true);
else updateIndicator();
// The demo starts once the environment has had a moment to load
if (URL_PARAMS.get('demo') === '1') setTimeout(() => toggleDemo(), 1500);

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

function physicsStep(input: DriveInput, now: number) {
  const before = car.snapshot();
  // Autonomous: Glide moves the car along its trajectory; after a takeover it brakes
  const control = flow.autoControl();
  if (control === 'auto') flow.autoStep(car, PHYSICS_DT, input, now);
  else if (control === 'braking') car.step(flow.brakeInput(input), PHYSICS_DT);
  else if (control === 'hold') flow.holdStep(car, input, now);
  else car.step(input, PHYSICS_DT);
  const hit = collisions.check(car.x, car.z, car.heading, car.steer);
  // Already overlapping (e.g. after a reset onto an obstacle): let the car move out
  const wasHit = hit && collisions.check(before.x, before.z, before.heading, before.steer);
  if (hit && !wasHit) {
    car.restore(before);
    if (control === 'auto') flow.autoHalt(car);
    if (!inContact) {
      contacts++;
      logger.log(now, 'contact', { phase: flow.maneuver?.phase ?? flow.screen, value: hit });
    }
    inContact = hit;
    contactAt = { x: car.x, z: car.z };
  } else if (inContact && Math.hypot(car.x - contactAt.x, car.z - contactAt.z) > CONTACT_RELEASE) {
    inContact = null;
  }
}

function frame(time: number) {
  timer.update(time);
  const realDt = Math.min(timer.getDelta(), 0.1);
  const dt = FIXED_STEP ? FRAME_DT : realDt;
  acc += dt;
  const input = demo.active ? demo.update(dt) : keys.drive();
  let steps = FIXED_STEP ? Math.round(FRAME_DT / PHYSICS_DT) : Math.floor(acc / PHYSICS_DT);
  acc = FIXED_STEP ? 0 : acc - steps * PHYSICS_DT;
  while (steps-- > 0) {
    simTime += PHYSICS_DT;
    physicsStep(input, simTime);
  }

  poseCar(rig, car.x, car.z, car.heading, car.steer, car.wheelSpin, car.steeringWheelDeg);
  rig.root.updateMatrixWorld();
  // Head tracking, hook 2/3: the view follows the head (a held Z/X/W key wins)
  tracker.update();
  const keyGlance: MirrorGlance | null = keys.isDown('KeyZ') ? 'left' : keys.isDown('KeyX') ? 'right' : keys.isDown('KeyW') ? 'rear' : null;
  if (demo.active) {
    views.headLook = null;
    views.glance = demoGlance;
    glanceSource = null;
  } else if (tracker.active) {
    views.headLook = mapHead(tracker, mapping);
    views.glance = keyGlance; // a held Z/X/W still snaps onto a mirror
    glanceSource = keyGlance ? 'key' : null;
  } else {
    views.headLook = null;
    views.glance = keyGlance;
    glanceSource = keyGlance ? 'key' : null;
  }
  views.update(car.x, car.z, car.heading, dt);
  world.followSun(car.x, car.z);
  subtitles.set(demo.active ? subtitleText : null, world.renderer.domElement.getBoundingClientRect());

  const now = nowS();
  actors.update(dt, now, { x: car.x, z: car.z, heading: car.heading }, actorContext());
  recon.syncActors(actors.markers());
  parkingSensors(now);
  const out = flow.update(car, now, contacts);
  const auto = barLook.turquoiseAuto && AUTO_SCREENS.has(flow.screen);
  if (auto) Object.assign(autoBarStyle, barStyle, { color: TURQUOISE });
  bars.left.painter.style = bars.right.painter.style = auto ? autoBarStyle : barStyle;
  bars.left.draw(out.bars.left, now);
  bars.right.draw(out.bars.right, now);
  frameDt = dt;
  logFrame(now);
  // Head tracking, hook 3/3: calibration guide and preview (full preview never in test mode)
  const calibMsg = tracker.active ? calibration.update() : null;
  gazeMessage.textContent = calibMsg ?? '';
  gazeMessage.classList.toggle('hidden', !calibMsg || demo.active);
  const showPreview = gaze.preview || calibration.active || tracker.status === 'starting' || tracker.status === 'error';
  trackingPreview.draw(tracker, session.testMode ? 'dot' : showPreview && tracker.status !== 'off' ? 'full' : 'none', mapping, null);
  lastBarViews = out.bars;
  showPath(flow.maneuver?.plan ?? null);

  // Spaces in the reconstruction: blue where the car fits, highlighted when chosen
  for (const sp of street.spaces) {
    const fits = flow.evaluation?.space === sp ? flow.evaluation.fits : flow.fits.get(sp.id)!;
    const chosen = flow.chosen === sp && (flow.screen === 'approach' || flow.screen === 'choose');
    recon.setSpaceLook(sp.id, chosen ? (fits ? 'chosen' : 'chosenNoFit') : fits ? 'fits' : 'noFit');
  }
  const vp = CentralDisplay.viewportFor(out.display);
  const autoInfo = flow.reconInfo(now);
  const labels: ReconLabel[] = autoInfo ? autoInfo.preview.points.map((p) => ({ position: p.position, text: p.label })) : [];
  if (vp === 'recon') recon.render(world.renderer, { x: car.x, z: car.z, heading: car.heading }, dt, autoInfo, flow.auto?.timeline ?? null);
  if (vp === 'camera') {
    world.renderer.shadowMap.needsUpdate = true;
    rearCam.render(world.renderer, world.scene);
  }
  display.update(out.display, now, recon, rearCam, flow.guide, labels);

  render();

  // FPS and automatic low-quality fallback
  fpsFrames++;
  fpsTime += realDt;
  if (fpsTime >= 0.5) {
    fps = fpsFrames / fpsTime;
    fpsFrames = 0;
    fpsTime = 0;
    lowFpsSeconds = fps < 40 ? lowFpsSeconds + 0.5 : 0;
    if (!FIXED_STEP && !autoDowngraded && params.quality === 'high' && lowFpsSeconds >= 3) {
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
    `Scenario  ${actorSettings.scenario === 'busy' ? 'Animato' : 'Vuoto'}`,
    `Contatti  ${contacts}${inContact ? `  ⚠ contatto con ${CONTACT_LABEL[inContact]}` : ''}`,
    ...assistHud(),
    ...(tracker.active
      ? [`Testa     ${tracker.status} · yaw ${tracker.yaw.toFixed(1)}° pitch ${tracker.pitch.toFixed(1)}°${headStats()}`]
      : []),
    `FPS       ${fps.toFixed(0)}${autoDowngraded ? ' (qualità bassa automatica)' : ''}`,
    gearMsg,
  ]);
  requestAnimationFrame(frame);
}

// Parking sensors: during the manoeuvre or in reverse, while moving (and 1 s after), last centimetres only
let lastMoving = -Infinity;
function parkingSensors(now: number) {
  if (!SENSOR_SCREENS.has(flow.screen) && car.gear !== 'R') return;
  if (Math.abs(car.speed) > 0.02) lastMoving = now;
  if (now - lastMoving > 1) return;
  const n = collisions.nearest({ x: car.x, z: car.z, heading: car.heading });
  if (!n) return;
  const lateral = -(n.point[0] - car.x) * Math.sin(car.heading) + (n.point[1] - car.z) * Math.cos(car.heading);
  audio.sensors(n.distance, lateral > 0.3 ? 'right' : lateral < -0.3 ? 'left' : null, now);
}

// Log of what is not a flow event: screens reached, end of the assisted manoeuvre, mirror glances
let loggedScreen = flow.screen;
let loggedDone = false;
let loggedGlance: Glance = null;
let glanceStart = 0;
function logFrame(now: number) {
  if (flow.screen !== loggedScreen) {
    loggedScreen = flow.screen;
    if (flow.screen === 'approach') logger.log(now, 'approach', { phase: 'approach' });
    if (flow.screen === 'autoPreview') logger.log(now, 'preview_shown', { phase: 'autoPreview', value: flow.auto?.preview.seconds ?? '' });
  }
  const r = flow.maneuver?.result;
  if (r && !loggedDone) {
    loggedDone = true;
    logger.setOutcome('done');
    logger.log(now, 'done', { phase: 'done', value: r.seconds, extra: { curbGap: r.curbGap, frontGap: r.frontGap, rearGap: r.rearGap, overs: r.overs } });
  } else if (!r) loggedDone = false;
  // Mirror glances (a proxy of the gaze, which is filmed separately): from the keys,
  // or, with the continuous head view, from where the view points
  const gz = settledGaze(gazeTarget(), now);
  const g = gz?.side ?? null;
  const phase = flow.maneuver?.phase ?? flow.screen;
  if (g !== loggedGlance || (gz && gz.source !== loggedGlanceSource)) {
    const ctx = { screen: flow.screen, lit: litMirrors() };
    if (loggedGlance) logger.log(now, 'glance_end', { phase, side: loggedGlance, value: loggedGlanceSource ?? '', extra: { s: Math.round((now - glanceStart) * 100) / 100, ...ctx } });
    if (gz) logger.log(gz.since, 'glance_start', { phase, side: gz.side, value: gz.source, extra: ctx });
    loggedGlance = g;
    loggedGlanceSource = gz?.source ?? null;
    glanceStart = gz?.since ?? now;
  }
  // Time spent reversing, and the share of it looking at the lit mirror
  if (car.speed < -0.05 && (flow.screen === 'assisted' || flow.screen === 'autoRunning')) {
    logger.accumulate('reverse_s', frameDt);
    if (g && (g === 'left' || g === 'right') && litMirrors().includes(g)) logger.accumulate('reverse_on_lit_mirror_s', frameDt);
  }
}

let loggedGlanceSource: 'head' | 'key' | null = null;
let gazeCandidate: { side: MirrorGlance; source: 'head' | 'key'; since: number } | null = null;
const GAZE_DWELL = 0.15; // s: the head-driven view must rest on a mirror this long (not just sweep past it)

/** Keys count at once; a mirror merely crossed by the head-driven view does not. */
function settledGaze(t: { side: MirrorGlance; source: 'head' | 'key' } | null, now: number) {
  if (!t) {
    gazeCandidate = null;
    return null;
  }
  if (!gazeCandidate || gazeCandidate.side !== t.side || gazeCandidate.source !== t.source) gazeCandidate = { ...t, since: now };
  const continuous = t.source === 'head' && !views.glance;
  if (continuous && now - gazeCandidate.since < GAZE_DWELL) return loggedGlance ? { side: loggedGlance as MirrorGlance, source: loggedGlanceSource ?? 'head', since: glanceStart } : null;
  return gazeCandidate;
}
let frameDt = 0;

/** What the driver is looking at: Z/X/W, else the mirror the head-driven view points to. */
function gazeTarget(): { side: MirrorGlance; source: 'head' | 'key' } | null {
  if (demo.active) return null;
  const g = views.glance;
  if (g && g !== 'display') return { side: g, source: glanceSource ?? 'key' };
  if (!views.headLook || tracker.status !== 'tracking') return null;
  const side = mirrorInView(views.look, views.mirrorDirections, gaze.mirrorTolerance);
  return side ? { side, source: 'head' } : null;
}

/** Mirrors with a lit bar right now (the pre-announcement counts as not lit). */
function litMirrors(): ('left' | 'right')[] {
  const b = lastBarViews;
  if (!b) return [];
  return (['left', 'right'] as const).filter((s) => b[s].kind !== 'off' && b[s].kind !== 'announce');
}

function assistHud(): string[] {
  const m = flow.maneuver;
  const a = flow.auto;
  if (a) {
    const pv = a.preview;
    return [
      `Flusso    ${flow.screen} · tratto ${a.stage} · ${a.t.toFixed(1)}/${a.timeline.total.toFixed(1)} s · ${a.timeline.profile}`,
      `Previsto  ${pv.points.map((p) => p.label).join(' | ')}`,
      `Min visto ${a.minSeen ? (a.minSeen.distance * 100).toFixed(0) + ' cm' : '—'}`,
    ];
  }
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
  const size = r.getSize(new THREE.Vector2());
  const w = size.x;
  const h = size.y;

  // Shadow map once per frame, shared by the mirror and main passes
  r.shadowMap.needsUpdate = true;
  // Mirrors reflect what the driver sees; from the chase view, what an outside observer sees
  if (views.split || views.current !== 'top') {
    (views.split || views.current === 'driver' ? views.driver : views.chase).getWorldPosition(eyeWorld);
    for (const m of mirrors) m.render(r, world.scene, eyeWorld);
  }
  // Rear-view mirror: only seen from the driver's seat; every other frame in low quality
  frameNo++;
  if ((views.split || views.current === 'driver') && (world.quality === 'high' || frameNo % 2 === 0)) {
    views.driver.getWorldPosition(eyeWorld);
    rearMirror.render(r, world.scene, eyeWorld);
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
Object.assign(window, { placeBars, tracker, gaze, getHeadSource: () => headSource, mapping, calibration, getGlanceSource: () => glanceSource, actors, audio, actorSettings, debug, gui, demo, demoSettings, session, logger, barStyle, barLook, placeObstacle, car, street, world, views, rig, getManeuver: () => flow.maneuver, flow, flowSettings, getBars: () => lastBarViews });
requestAnimationFrame(frame);
