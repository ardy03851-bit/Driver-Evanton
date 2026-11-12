import * as THREE from 'three';
import {
  CARS, PAINTS, QUALITY, TIMES, clamp, lerp, damp, smoothstep, isTouch, reducedMotion,
} from './config.js';
import { loadAssets } from './assets.js';
import { World, roadX, roadD, surfaceHeight, roadInfo, roadYaw } from './world.js';
import { buildCar } from './cars.js';
import { loadModelTemplate, buildModelCar } from './modelCar.js';
import { Vehicle } from './physics.js';
import { UI, regionAt } from './ui.js';
import { SimAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const STORE = 'evanton-drive-v3';

const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; }
})();

const settings = {
  car: CARS.some((c) => c.id === saved.car) ? saved.car : CARS[0].id,
  paint: saved.paint || CARS[0].paint,
  time: TIMES[saved.time] ? saved.time : 'golden',
  quality: QUALITY[saved.quality] ? saved.quality : (isTouch ? 'balanced' : 'high'),
  auto: saved.auto !== false,
  assist: !!saved.assist,
  sound: !!saved.sound,
  volume: typeof saved.volume === 'number' ? saved.volume : 0.55,
  camera: saved.camera || 0,
};

const persist = () => {
  try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch { /* private mode */ }
};

let renderer, scene, camera, world, vehicle, carAsset, carRig, ui, audio, carTemplate = null;
let mode = 'boot';
let panelOpen = false;
let photo = false;
let photoSnap = false;
let elapsed = 0;
let last = performance.now();
let chasePos = new THREE.Vector3();
let chaseLook = new THREE.Vector3();
let lookTarget = new THREE.Vector3();
let introAngle = 0;
let orbit = { theta: 0.7, phi: 1.22, radius: 8.4, dragging: false, lx: 0, ly: 0 };
let fovTarget = 54;
let dust;
let hintShown = false;
let frameTime = 0;
let fpsSamples = 0;
let lowFpsTime = 0;
let speedLinesT = 0;
const keys = new Set();
const tmpV = new THREE.Vector3();
const clock = new THREE.Clock();

const currentCar = () => CARS.find((c) => c.id === settings.car) || CARS[0];
const setLoading = (p, note) => ui?.bootProgress?.(p, note);

/* ═══════════════════════════════════════════════════════════════
   boot
   ═══════════════════════════════════════════════════════════════ */
async function init() {
  ui = new UI({
    onStart: startDriving,
    onCarPreview: previewCar,
    onCarCommit: commitCar,
    onPaint: (hex) => {
      settings.paint = hex;
      carAsset?.setPaint(hex);
      persist();
    },
    onTime: (t) => { settings.time = t; ui.state.time = t; world.setTime(t); applyLights(); ui.toast(`${TIMES[t].label} light`, TIMES[t].icon); persist(); },
    onQuality: (q) => { settings.quality = q; applyQuality(); persist(); },
    onAuto: (a) => { settings.auto = a; if (vehicle) vehicle.auto = a; persist(); },
    onAssist: (a) => { settings.assist = a; if (vehicle) vehicle.assist = a; persist(); },
    onSoundToggle: toggleSound,
    onVolume: (v) => { settings.volume = v; audio.setVolume(v); persist(); },
    onCamera: cycleCamera,
    onPhoto: togglePhoto,
    onSnap: snapshot,
    onOrbitReset: () => { orbit.theta = 0.8; orbit.phi = 1.2; orbit.radius = 8.4; },
    onResetTrip: () => { if (vehicle) { vehicle.reset(-vehicle.z); vehicle.distance = 0; vehicle.topSpeed = 0; } },
    onPanel: (name) => {
      panelOpen = !!name;
      if (name === 'pause' && vehicle) ui.pauseLabel(vehicle);
    },
  });

  /* restore UI state */
  Object.assign(ui.state, {
    carId: settings.car, paint: settings.paint, time: settings.time, quality: settings.quality,
    auto: settings.auto, assist: settings.assist, sound: settings.sound, volume: settings.volume,
    camera: settings.camera,
  });
  ui.buildIntroCars();
  ui.setCar(settings.car, settings.paint);
  ui.syncButtons({ sound: settings.sound });

  setLoading(0.04, 'Waking the valley…');

  /* renderer */
  const q = QUALITY[settings.quality];
  renderer = new THREE.WebGLRenderer({
    canvas: $('view'), antialias: q.aa, powerPreference: 'high-performance', preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, q.dpr));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = q.shadow > 0;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = true;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(54, innerWidth / innerHeight, 0.08, 6200);

  vehicle = new Vehicle(currentCar());
  vehicle.auto = settings.auto;
  vehicle.assist = settings.assist;

  setLoading(0.12, 'Laying fresh tarmac…');
  await loadAssets((done, total, key) => {
    setLoading(0.12 + (done / total) * 0.36, `Loading ${key} surface…`);
  });

  setLoading(0.52, 'Planting the pine valley…');
  world = new World(scene, renderer, settings.quality);
  world.setTime(settings.time, true);
  ui.state.time = settings.time;

  setLoading(0.6, 'Rolling the 458 Spider out of the garage…');
  try { carTemplate = await loadModelTemplate(); } catch (err) { console.warn('[evanton] 458 model unavailable, procedural body will be used', err); }
  setLoading(0.7, `Unveiling the ${currentCar().full}…`);
  carRig = new THREE.Group();
  scene.add(carRig);
  carAsset = makeCarAsset(currentCar(), settings.paint);
  carRig.add(carAsset.group);
  carAsset.setLights(settings.time === 'dusk');
  carRig.position.set(vehicle.x, vehicle.y, vehicle.z);
  carRig.rotation.y = vehicle.yaw;

  buildDust();
  audio = new SimAudio();
  audio.volume = settings.volume;
  audio.voiceFor(vehicle);

  /* camera starts on a slow orbit around the car for the intro */
  camera.position.set(vehicle.x + 6.4, vehicle.y + 2.1, vehicle.z - 5.4);
  camera.lookAt(vehicle.x, vehicle.y + 0.75, vehicle.z);
  chasePos.copy(camera.position);
  chaseLook.set(vehicle.x, vehicle.y + 0.7, vehicle.z);
  lookTarget.copy(chaseLook);

  setLoading(0.8, 'Growing the forests…');
  await prebuildWorld();

  setLoading(0.97, 'Adjusting the light…');
  bindGlobalEvents();
  resize();
  renderer.render(scene, camera);
  if (isTouch) document.body.classList.add('touch-ui');

  await new Promise((r) => setTimeout(r, 320));
  setLoading(1, 'Ready when you are.');
  ui.bootDone();
  mode = 'intro';
  requestAnimationFrame(loop);
}

async function prebuildWorld() {
  const fakeCam = camera;
  for (let i = 0; i < 56; i++) {
    world.update(0.016, { x: vehicle.x, y: vehicle.y, z: vehicle.z }, fakeCam, 0);
    if (i % 6 === 0) {
      setLoading(0.8 + (i / 56) * 0.15, 'Growing the forests…');
      await new Promise((r) => setTimeout(r, 0));
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   car management
   ═══════════════════════════════════════════════════════════════ */
function makeCarAsset(def, paint) {
  const asset = def.model === 'gltf458' && carTemplate
    ? buildModelCar(def, paint, carTemplate)
    : buildCar(def, paint);
  asset.setPaint(paint);
  asset.setLights(settings.time === 'dusk');
  return asset;
}

function createAsset(def, paint) {
  if (carAsset) {
    carAsset.group.removeFromParent();
    carAsset.dispose();
  }
  carAsset = makeCarAsset(def, paint);
  carRig.add(carAsset.group);
}

function previewCar(id, paint) {
  const def = CARS.find((c) => c.id === id);
  if (!def) return;
  settings.car = id;
  settings.paint = paint || def.paint;
  const state = { x: vehicle.x, z: vehicle.z, y: vehicle.y, yaw: vehicle.yaw, vLong: vehicle.vLong, vLat: vehicle.vLat, distance: vehicle.distance, topSpeed: vehicle.topSpeed };
  vehicle = new Vehicle(def);
  vehicle.auto = settings.auto;
  vehicle.assist = settings.assist;
  Object.assign(vehicle, state);
  vehicle.spec = def.spec;
  createAsset(def, settings.paint);
  carAsset.setLights(settings.time === 'dusk');
  ui.setCar(id, settings.paint);
  audio.voiceFor(vehicle);
  persist();
}

function commitCar(id, paint) {
  if (id !== settings.car || paint !== settings.paint) previewCar(id, paint);
  ui.toast(`${currentCar().full} — keys in hand`, 'car');
}

/* ═══════════════════════════════════════════════════════════════
   start / pause
   ═══════════════════════════════════════════════════════════════ */
function startDriving() {
  if (mode === 'driving') return;
  mode = 'driving';
  document.body.classList.add('driving');
  ui.closePanel();
  ui.toast(`${currentCar().full} · ${regionAt(Math.max(0, -vehicle.z))}`, 'route');
  if (settings.sound) enableSound();
  // snap the camera behind the car so the transition is clean
  updateChaseTargets(0);
  camera.position.copy(chasePos);
  chaseLook.set(vehicle.x, vehicle.y + 1.0, vehicle.z);
  lookTarget.set(vehicle.x, vehicle.y + 1.0, vehicle.z);
  if (!hintShown) {
    hintShown = true;
    setTimeout(() => ui.hideHint(), 11000);
  }
}

function pauseGame(open) {
  if (mode === 'intro') return;
  if (open) { ui.openPanel('pause'); }
  else ui.closePanel();
}

/* ═══════════════════════════════════════════════════════════════
   cameras
   ═══════════════════════════════════════════════════════════════ */
const CAM_NAMES = ['Chase', 'Wide', 'Bumper'];
function cycleCamera() {
  settings.camera = (settings.camera + 1) % 3;
  persist();
  ui.toast(`${CAM_NAMES[settings.camera]} camera`, 'camera');
  updateChaseTargets(0.016);
  camera.position.copy(chasePos);
}

function updateChaseTargets(dt) {
  const forward = tmpV.set(Math.sin(vehicle.yaw), 0, Math.cos(vehicle.yaw));
  const speed = Math.abs(vehicle.vLong);
  const sway = reducedMotion ? 0 : Math.sin(elapsed * 0.33) * 0.06;
  const mode = settings.camera;
  const narrow = innerWidth < 700;
  let back, height, ahead, side = 0;
  if (mode === 0) { back = narrow ? 9.6 : 7.0; height = narrow ? 2.75 : 1.98; ahead = narrow ? 13 : 11; }
  else if (mode === 1) { back = (narrow ? 13.4 : 11.6) + smoothstep(0, 70, speed) * 2.2; height = narrow ? 4.5 : 3.55; ahead = narrow ? 18 : 18; side = 1.7; }
  else { back = -1.15; height = 1.05; ahead = 40; }

  if (mode === 2) {
    chasePos.set(
      vehicle.x + forward.x * 1.15,
      vehicle.y + 1.06,
      vehicle.z + forward.z * 1.15
    );
    lookTarget.set(vehicle.x + forward.x * 34, vehicle.y + 0.72, vehicle.z + forward.z * 34);
    return;
  }
  const right = new THREE.Vector3(Math.cos(vehicle.yaw), 0, -Math.sin(vehicle.yaw));
  chasePos.set(
    vehicle.x - forward.x * back + right.x * (side + sway),
    vehicle.y + height + smoothstep(0, 100, speed) * 0.25,
    vehicle.z - forward.z * back + right.z * (side + sway)
  );
  chaseLook.set(
    vehicle.x + forward.x * ahead,
    vehicle.y + 1.02,
    vehicle.z + forward.z * ahead
  );
}

function updateCamera(dt) {
  if (photo) {
    const target = new THREE.Vector3(vehicle.x, vehicle.y + 0.62, vehicle.z);
    const radius = orbit.radius;
    camera.position.set(
      target.x + radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
      target.y + radius * Math.cos(orbit.phi) * 0.85 + 0.55,
      target.z + radius * Math.sin(orbit.phi) * Math.sin(orbit.theta)
    );
    camera.lookAt(target);
    if (camera.fov !== 46) { camera.fov = 46; camera.updateProjectionMatrix(); }
    return;
  }
  if (mode === 'intro') {
    introAngle += dt * 0.07;
    const narrow = innerWidth < 700;
    const r = narrow ? 17.5 : 9.6;
    const target = new THREE.Vector3(vehicle.x, vehicle.y + (narrow ? 0.95 : 0.66), vehicle.z);
    const px = vehicle.x + Math.sin(introAngle + 0.6) * r;
    const pz = vehicle.z + Math.cos(introAngle + 0.6) * r;
    camera.position.lerp(new THREE.Vector3(px, vehicle.y + (narrow ? 4.1 : 2.0) + Math.sin(introAngle * 0.5) * 0.2, pz), 1 - Math.exp(-1.6 * dt));
    /* on wide screens keep the car out of the copy: aim slightly left of it */
    if (innerWidth > 980) {
      const dir = target.clone().sub(camera.position).normalize();
      const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
      target.addScaledVector(right, -0.8);
    }
    camera.lookAt(target);
    if (Math.abs(camera.fov - 46) > 0.01) { camera.fov = 46; camera.updateProjectionMatrix(); }
    return;
  }
  if (panelOpen) return;
  updateChaseTargets(dt);
  const k = settings.camera === 2 ? 26 : settings.camera === 1 ? 4.2 : 6.4;
  const posLerp = 1 - Math.exp(-k * dt);
  camera.position.lerp(chasePos, posLerp);
  chaseLook.lerp(lookTarget, 1 - Math.exp(-(k * 1.12) * dt));
  camera.lookAt(chaseLook);

  const speedFov = 54 + smoothstep(20, 320, vehicle.speedKmh) * 12;
  fovTarget = settings.camera === 2 ? 60 : speedFov;
  camera.fov = damp(camera.fov, fovTarget, 3.2, dt);
  camera.updateProjectionMatrix();

  /* very subtle high-speed vibration, never body bounce */
  const shake = reducedMotion ? 0 : smoothstep(160, 330, vehicle.speedKmh) * 0.014;
  if (shake > 0.0001) {
    camera.position.x += Math.sin(elapsed * 31.7) * shake;
    camera.position.y += Math.sin(elapsed * 41.3 + 1.4) * shake * 0.6;
  }
}

/* ═══════════════════════════════════════════════════════════════
   world / visuals
   ═══════════════════════════════════════════════════════════════ */
function applyCarVisuals(dt) {
  carRig.position.set(vehicle.x, vehicle.y, vehicle.z);
  carRig.rotation.y = vehicle.yaw;
  carAsset.body.rotation.set(-vehicle.pitch, 0, vehicle.roll);
  carAsset.body.position.y = 0.012;

  for (const w of carAsset.wheels) {
    if (w.front) w.pivot.rotation.y = vehicle.steer;
    w.spin.rotation.x += (w.spinSign ?? 1) * (vehicle.vLong / w.radius) * dt;
  }
  carAsset.setBrake(vehicle.braking);
  if (carAsset.wing?.userData?.assembly) {
    const target = -0.16 - smoothstep(90, 240, vehicle.speedKmh) * 0.26 - (vehicle.braking ? 0.18 : 0);
    carAsset.wing.rotation.x = damp(carAsset.wing.rotation.x, target, 4, dt);
  }
}

function applyLights() {
  carAsset?.setLights(settings.time === 'dusk');
  ui?.state && (ui.state.time = settings.time);
}

/* ═══════════════════════════════════════════════════════════════
   dust / gravel particles
   ═══════════════════════════════════════════════════════════════ */
function buildDust() {
  const N = 160;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3);
  const alpha = new Float32Array(N);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setDrawRange(0, N);
  const tex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    gr.addColorStop(0, 'rgba(220,205,175,.9)');
    gr.addColorStop(0.5, 'rgba(200,185,155,.35)');
    gr.addColorStop(1, 'rgba(200,185,155,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  const mat = new THREE.PointsMaterial({
    map: tex, size: 1.15, sizeAttenuation: true, transparent: true, opacity: 0.34,
    depthWrite: false, color: 0xd6c7a9, blending: THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  dust = { points, pos, N, particles: [], cursor: 0, geo };
  for (let i = 0; i < N; i++) { dust.pos[i * 3 + 1] = -999; dust.particles.push({ life: 0 }); }
}

function updateDust(dt) {
  if (!dust) return;
  const car = vehicle;
  const speed = Math.abs(car.vLong);
  const surf = roadInfo(car.x, car.z);
  const active = !surf.onRoad && speed > 3.2;
  if (active) {
    const rate = Math.min(30, speed * 1.8) * (car.surfaceInfo?.dust || 0.4);
    dust._acc = (dust._acc || 0) + rate * dt;
    const forward = { x: Math.sin(car.yaw), z: Math.cos(car.yaw) };
    const right = { x: Math.cos(car.yaw), z: -Math.sin(car.yaw) };
    while (dust._acc > 1) {
      dust._acc -= 1;
      const idx = dust.cursor = (dust.cursor + 1) % dust.N;
      const side = Math.random() > 0.5 ? 1 : -1;
      const p = dust.particles[idx];
      p.life = 0.6 + Math.random() * 0.8;
      p.max = p.life;
      p.x = car.x - forward.x * 1.25 + right.x * side * 0.85;
      p.z = car.z - forward.z * 1.25 + right.z * side * 0.85;
      p.y = car.y + 0.12;
      p.vx = (Math.random() - 0.5) * 1.2 - forward.x * speed * 0.06;
      p.vz = (Math.random() - 0.5) * 1.2 - forward.z * speed * 0.06;
      p.vy = 0.5 + Math.random() * 0.8;
      p.size = 0.5 + Math.random() * 0.8;
    }
  }
  for (let i = 0; i < dust.N; i++) {
    const p = dust.particles[i];
    if (p.life > 0) {
      p.life -= dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.vy += 0.35 * dt;
      p.vx *= 0.985; p.vz *= 0.985;
      dust.pos[i * 3] = p.x;
      dust.pos[i * 3 + 1] = p.life > 0 ? p.y : -999;
      dust.pos[i * 3 + 2] = p.z;
    } else {
      dust.pos[i * 3 + 1] = -999;
    }
  }
  dust.geo.attributes.position.needsUpdate = true;
}

/* ═══════════════════════════════════════════════════════════════
   settings application
   ═══════════════════════════════════════════════════════════════ */
function applyQuality() {
  const q = QUALITY[settings.quality];
  renderer.setPixelRatio(Math.min(devicePixelRatio, q.dpr));
  renderer.setSize(innerWidth, innerHeight);
  const wantsShadow = q.shadow > 0;
  renderer.shadowMap.enabled = wantsShadow;
  if (world) {
    world.setQuality(settings.quality);
    world.sun.castShadow = wantsShadow;
    if (world.sun.shadow.map) { world.sun.shadow.map.dispose(); world.sun.shadow.map = null; }
    world.sun.shadow.mapSize.set(Math.max(512, q.shadow), Math.max(512, q.shadow));
    world.sun.shadow.needsUpdate = true;
    world._firstPass = true;
    world.lastKey = '';
  }
  ui.toast(`${settings.quality[0].toUpperCase() + settings.quality.slice(1)} rendering`, 'bolt');
}

async function enableSound() {
  const ok = await audio.enable();
  ui.syncButtons({ sound: ok, assist: settings.assist });
  settings.sound = ok;
  persist();
  if (ok) ui.toast('Engine sound on', 'sound');
}
function toggleSound() {
  if (settings.sound) {
    audio.disable();
    settings.sound = false;
    ui.syncButtons({ sound: false });
    persist();
  } else {
    enableSound();
  }
}

/* ═══════════════════════════════════════════════════════════════
   photo mode
   ═══════════════════════════════════════════════════════════════ */
function togglePhoto() {
  if (mode !== 'driving') return;
  photo = !photo;
  ui.setPhoto(photo);
  if (photo) {
    ui.closePanel();
    orbit.theta = Math.atan2(vehicle.z - camera.position.z, vehicle.x - camera.position.x);
    orbit.phi = 1.18;
    orbit.radius = 8.5;
    ui.toast('Photo mode — drag to orbit', 'camera');
  } else {
    updateChaseTargets(0.016);
    camera.position.copy(chasePos);
  }
}

function snapshot() {
  photoSnap = true;
  renderer.render(scene, camera);
  renderer.domElement.toBlob((blob) => {
    if (!blob) { ui.toast('Could not save image', 'close'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `evanton-${settings.car}-${Date.now().toString(36)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    ui.toast('Photo saved to downloads', 'download');
  }, 'image/png');
  photoSnap = false;
}

/* ═══════════════════════════════════════════════════════════════
   input
   ═══════════════════════════════════════════════════════════════ */
function readInput() {
  const touch = ui.touch || { gas: 0, brake: 0 };
  const left = keys.has('a') || keys.has('arrowleft') || ui.touchSteer === -1;
  const right = keys.has('d') || keys.has('arrowright') || ui.touchSteer === 1;
  const gas = keys.has('w') || keys.has('arrowup') || !!touch.gas;
  const brake = keys.has('s') || keys.has('arrowdown') || !!touch.brake;
  return {
    throttle: gas ? 1 : 0,
    brake: brake ? 1 : 0,
    steer: (right ? 1 : 0) - (left ? 1 : 0),
    handbrake: keys.has(' '),
    shiftUp: false,
    shiftDown: false,
  };
}

function bindGlobalEvents() {
  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['tab', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    if (e.repeat) return;
    keys.add(k);
    if (mode === 'intro' && (k === 'enter' || k === ' ')) startDriving();
    if (mode !== 'driving' && !panelOpen) return;
    if (k === 'escape') {
      if (photo) { togglePhoto(); return; }
      if (panelOpen) ui.closePanel(); else if (mode === 'driving') ui.openPanel('pause');
    }
    if (k === 'c' && !panelOpen) cycleCamera();
    if (k === 'g') { photo ? togglePhoto() : (panelOpen ? ui.closePanel() : ui.openPanel('garage')); }
    if (k === 'tab') { panelOpen && ui.state.panel === 'map' ? ui.closePanel() : ui.openPanel('map'); }
    if (k === 'p') togglePhoto();
    if (k === 'm') toggleSound();
    if (k === 'u') { settings.assist = !settings.assist; vehicle.assist = settings.assist; ui.state.assist = settings.assist; ui.syncButtons({ assist: settings.assist }); ui.toast(settings.assist ? 'Assist engaged' : 'Assist off', 'compass'); persist(); }
    if (k === 'r' && mode === 'driving') { vehicle.reset(-vehicle.z); ui.toast('Recovered to the road', 'reset'); }
    if (k === 'f') toggleFullscreen();
    if (k === 'shift') { if (!vehicle.auto) pulseShift(1); }
    if (k === 'control') { if (!vehicle.auto) pulseShift(-1); }
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());

  /* mouse / touch orbit in photo mode */
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    if (!photo) return;
    orbit.dragging = true;
    orbit.lx = e.clientX; orbit.ly = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!photo || !orbit.dragging) return;
    orbit.theta -= (e.clientX - orbit.lx) * 0.005;
    orbit.phi = clamp(orbit.phi - (e.clientY - orbit.ly) * 0.004, 0.35, 1.55);
    orbit.lx = e.clientX; orbit.ly = e.clientY;
  });
  addEventListener('pointerup', () => { orbit.dragging = false; });
  canvas.addEventListener('wheel', (e) => {
    if (!photo) return;
    e.preventDefault();
    orbit.radius = clamp(orbit.radius + e.deltaY * 0.006, 3.4, 22);
  }, { passive: false });

  addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && mode === 'driving' && !panelOpen) ui.openPanel('pause');
  });
}

function pulseShift(dir) {
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, shiftUp: dir > 0, shiftDown: dir < 0 };
  vehicle.update(1 / 120, inp, elapsed);
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch { ui.toast('Fullscreen unavailable', 'close'); }
}

function resize() {
  if (!renderer || !camera) return;
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

/* ═══════════════════════════════════════════════════════════════
   loop
   ═══════════════════════════════════════════════════════════════ */
let accumulator = 0;
const FIXED = 1 / 120;

function loop(now) {
  requestAnimationFrame(loop);
  const rawDt = Math.min(0.05, (now - last) / 1000 || 0.016);
  last = now;
  elapsed += rawDt;

  const paused = panelOpen || photo;
  const input = readInput();
  const simDt = paused ? 0 : rawDt;

  /* physics */
  accumulator = Math.min(accumulator + simDt, 0.12);
  let steps = 0;
  while (accumulator >= FIXED && steps < 8) {
    vehicle.update(FIXED, input, elapsed);
    accumulator -= FIXED;
    steps++;
  }

  /* visuals */
  applyCarVisuals(simDt);
  world.update(simDt, vehicle, camera, elapsed);
  world.tickTime(rawDt);
  updateDust(simDt);
  updateCamera(rawDt);
  audio.update(vehicle, rawDt);

  /* HUD */
  if (mode === 'driving') {
    ui.update(rawDt, vehicle, elapsed);
    if (settings.camera !== undefined) ui.state.camera = settings.camera;
  }
  ui.updateMapState(vehicle);

  /* adaptive resolution if the machine is struggling */
  frameTime += rawDt;
  fpsSamples++;
  if (frameTime > 3) {
    const avg = fpsSamples / frameTime;
    frameTime = 0; fpsSamples = 0;
    if (avg < 42 && !isTouch && renderer.getPixelRatio() > 1.05) {
      lowFpsTime += 3;
      if (lowFpsTime >= 6) {
        lowFpsTime = 0;
        renderer.setPixelRatio(Math.max(1, renderer.getPixelRatio() - 0.2));
        ui.toast('Resolution lowered to hold 60 fps', 'bolt');
      }
    } else lowFpsTime = 0;
  }

  renderer.render(scene, camera);
}

/* ═══════════════════════════════════════════════════════════════
   util & launch
   ═══════════════════════════════════════════════════════════════ */
window.evanton = {
  get status() {
    return {
      mode, car: settings.car, speed: Math.round(vehicle?.speedKmh || 0), gear: vehicle?.gear,
      surface: vehicle?.surface, distance: +(vehicle?.distance || 0).toFixed(1),
      drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles,
      fps: Math.round(1 / Math.max(0.001, rawAvg())),
      chunks: world ? world.terrain.size : 0,
    };
  },
  start: startDriving,
  debug: {
    speed: (kmh) => { vehicle.vLong = clamp(kmh / 3.6, 0, 120); },
    orbit: (theta, phi, radius) => { orbit.theta = theta; orbit.phi = phi; orbit.radius = radius; },
    camera: (x, y, z) => { camera.position.set(x, y, z); },
    input: () => ({ keys: [...keys], ...readInput() }),
    state: () => ({ vLong: +vehicle.vLong.toFixed(2), steer: +vehicle.steer.toFixed(3), auto: vehicle.auto, gear: vehicle.gear, rpm: Math.round(vehicle.rpm), mode, photo, panelOpen, paused: vehicle.paused }),
    wheels: () => (carAsset?.wheels || []).map((w) => ({
      front: !!w.front,
      spin: +(w.spin?.rotation.x ?? 0).toFixed(3),
      steer: +(w.pivot?.rotation.y ?? 0).toFixed(3),
      sign: w.spinSign ?? 1,
    })),
    ride: () => ({
      y: +carRig.position.y.toFixed(4),
      pitch: +carAsset?.group.rotation.x.toFixed(4),
      roll: +carAsset?.group.rotation.z.toFixed(4),
      paint: carAsset?.paint?.color?.getHexString?.(),
      meshes: (() => { let n = 0; carAsset?.group.traverse((o) => { if (o.isMesh) n++; }); return n; })(),
    }),
  },
};
let _fps = 0;
function rawAvg() { return _fps; }
(function trackFps() {
  let lastT = performance.now(), frames = 0;
  function tick(t) {
    frames++;
    if (t - lastT > 1000) { _fps = frames / ((t - lastT) / 1000); frames = 0; lastT = t; }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

init().catch((err) => {
  console.error('[evanton] fatal', err);
  const msg = String(err?.message || err);
  document.body.classList.add('booted');
  setTimeout(() => ui?.showFatal?.(msg), 300);
});
