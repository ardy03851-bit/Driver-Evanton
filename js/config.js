/* ── shared maths & constants ─────────────────────────────────── */
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a), 0, 1);
export const smoothstep = (a, b, x) => { const t = invLerp(a, b, x); return t * t * (3 - 2 * t); };
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
export const dampVec = (v, target, k, dt) => v.addScaledVector(target.clone().sub(v), 1 - Math.exp(-k * dt));
export const sgn = (v) => (v < 0 ? -1 : 1);
export const round = (v, n = 0.1) => Math.round(v / n) * n;
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/* iPadOS Safari reports "pointer: fine" when a trackpad is attached and
   can report a coarse pointer on a desktop with a touchscreen. The
   reliable signals for "there is a finger, show the pads" are touch
   points and the absence of a hover-capable fine pointer. */
export const isTouch = navigator.maxTouchPoints > 0
  && (matchMedia('(pointer: coarse)').matches || !matchMedia('(hover: hover)').matches);
export const isTablet = isTouch && Math.min(screen.width, screen.height) >= 700;

export function rng(seed) {
  let a = seed | 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hash2(x, z) {
  let n = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
export function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  return lerp(lerp(hash2(ix, iz), hash2(ix + 1, iz), u), lerp(hash2(ix, iz + 1), hash2(ix + 1, iz + 1), u), v);
}
export function fbm(x, z, oct = 3) {
  let s = 0, a = 0.56, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += noise2(x * f + i * 17.3, z * f - i * 9.7) * a; n += a; a *= 0.48; f *= 2.03; }
  return s / n;
}

export const PAINTS = [
  { hex: '#c9201b', name: 'Rosso Corsa' },
  { hex: '#f0c11b', name: 'Giallo Modena' },
  { hex: '#0d0e10', name: 'Nero Daytona' },
  { hex: '#c9cccd', name: 'Argento Nürburgring' },
  { hex: '#16386e', name: 'Blu Tour de France' },
  { hex: '#ece9e0', name: 'Bianco Avus' },
  { hex: '#31503f', name: 'Verde British' },
  { hex: '#5c6064', name: 'Grigio Silverstone' },
];

export const TIMES = {
  golden: {
    label: 'Golden hour', icon: 'sunset',
    skyTop: '#39648f', skyMid: '#a9b4bd', skyHorizon: '#ffcf95',
    sun: '#ffd2a0', sunIntensity: 3.5, sunDir: [-0.55, 0.13, -0.82],
    hemiSky: '#b9cadb', hemiGround: '#5c5039', hemiIntensity: 1.3,
    fog: '#cdb894', fogNear: 140, fogFar: 900,
    exposure: 0.92, water: '#3f6470', cloud: '#ffe2c2', cloudOpacity: 0.5,
  },
  day: {
    label: 'Midday', icon: 'sun',
    skyTop: '#2f6da9', skyMid: '#93bcdd', skyHorizon: '#d7e4ea',
    sun: '#fff5e2', sunIntensity: 3.7, sunDir: [-0.25, 0.88, -0.4],
    hemiSky: '#cfe4f6', hemiGround: '#70745c', hemiIntensity: 1.4,
    fog: '#c9dae2', fogNear: 180, fogFar: 980,
    exposure: 0.82, water: '#3d6d7e', cloud: '#ffffff', cloudOpacity: 0.55,
  },
  dusk: {
    label: 'Dusk', icon: 'moon',
    skyTop: '#141c30', skyMid: '#4a4160', skyHorizon: '#c17a5a',
    sun: '#ff9a63', sunIntensity: 1.2, sunDir: [-0.68, 0.06, -0.73],
    hemiSky: '#4b5a78', hemiGround: '#2a2924', hemiIntensity: 0.55,
    fog: '#3b3a48', fogNear: 70, fogFar: 560,
    exposure: 1.05, water: '#243a46', cloud: '#8a6a70', cloudOpacity: 0.42,
  },
  overcast: {
    label: 'Overcast', icon: 'cloud',
    skyTop: '#6d7c86', skyMid: '#a3b0b5', skyHorizon: '#cdd5d5',
    sun: '#e6ebec', sunIntensity: 1.5, sunDir: [0.15, 0.55, -0.82],
    hemiSky: '#becbd0', hemiGround: '#5e6456', hemiIntensity: 1.5,
    fog: '#b7c1c1', fogNear: 90, fogFar: 700,
    exposure: 1.0, water: '#5b6d6d', cloud: '#d9dee0', cloudOpacity: 0.75,
  },
};

/*
  ── the stable ────────────────────────────────────────────────
  Real geometry, real power units, real gear sets. Each car gets a
  distinct torque curve, drivetrain, mass and suspension tune; nothing
  is a reskin.
*/
export const CARS = [
  {
    id: '458',
    name: '458 Spider',
    full: 'Ferrari 458 Spider',
    year: 2011,
    tag: 'The open-top icon',
    blurb: 'The last of the normally aspirated mid-engined V8s, and arguably the sweetest. 9,000 rpm, no turbos, roof folded away, a chassis that talks to your fingertips. This is the one everyone remembers.',
    character: ['V8', '9,000 rpm', 'Open top'],
    paint: '#c9201b',
    model: 'gltf458',
    spec: {
      power: 562, torque: 540, torqueRpm: 6000, redline: 9000, idle: 900, limiter: 9200,
      mass: 1380, distF: 0.42, wheelbase: 2.65, trackF: 1.67, trackR: 1.63,
      length: 4.527, width: 1.937, height: 1.213,
      gears: [3.53, 2.29, 1.65, 1.30, 1.05, 0.88, 0.74], final: 4.85,
      shiftTime: 0.05, drive: 'RWD', driveBias: 0,
      cdA: 0.78, downforce: 2.0, rolling: 0.014,
      gripF: 1.30, gripR: 1.36, brake: 1.50, steerLock: 0.58,
      spring: 48, damper: 8.8, arbF: 1.0, arbR: 0.95, ride: 0.11,
      tcs: 0.70, abs: 0.92, engineBrake: 0.20, torqueFall: 0.20,
      tyreF: 0.352, tyreR: 0.360, widthF: 0.265, widthR: 0.335,
      zero: 3.5, vmax: 320,
    },
    sound: { cyl: 8, note: 1.18, turbo: 0.0, rasp: 0.55 },
    shape: {
      sill: 0.235, archLift: 0.30, nose: 0.60, hood: 0.81, waist: 0.98, deck: 0.92, tail: 0.84,
      roofFront: 0.36, roofRear: -1.24, roofHeight: 1.19, roofWidth: 0.30,
      cabinFront: 0.72, cabinRear: -1.32, cabinHalf: 0.69,
      wing: 'lip', lights: 'slim', exhaust: 'quad', rims: 'forged5', accent: '#d8b34a',
    },
  },
  {
    id: 'f8',
    name: 'F8 Tributo',
    full: 'Ferrari F8 Tributo',
    year: 2019,
    tag: 'The sharper edge',
    blurb: 'The last of the pure twin-turbo V8 mid-engines, turned up to 710 hp. Sharper turn-in, a shorter final drive and a rear end that moves with you rather than after you.',
    character: ['Agile', '710 hp', 'Sharp'],
    paint: '#f0c11b',
    spec: {
      power: 710, torque: 770, torqueRpm: 3250, redline: 8000, idle: 850, limiter: 8250,
      mass: 1435, distF: 0.455, wheelbase: 2.65, trackF: 1.68, trackR: 1.66,
      length: 4.611, width: 1.979, height: 1.206,
      gears: [3.75, 2.35, 1.72, 1.34, 1.07, 0.88, 0.74], final: 4.31,
      shiftTime: 0.06, drive: 'RWD', driveBias: 0,
      cdA: 0.80, downforce: 2.2, rolling: 0.013,
      gripF: 1.38, gripR: 1.43, brake: 1.58, steerLock: 0.56,
      spring: 52, damper: 9.2, arbF: 1.06, arbR: 1.0, ride: 0.105,
      tcs: 0.66, abs: 0.93, engineBrake: 0.18,
      tyreF: 0.352, tyreR: 0.360, widthF: 0.265, widthR: 0.345,
      zero: 2.9, vmax: 340,
    },
    sound: { cyl: 8, note: 1.05, turbo: 0.85, rasp: 0.5 },
    shape: {
      sill: 0.225, archLift: 0.31, nose: 0.58, hood: 0.78, waist: 1.0, deck: 0.90, tail: 0.83,
      roofFront: 0.32, roofRear: -1.20, roofHeight: 1.18, roofWidth: 0.30,
      cabinFront: 0.70, cabinRear: -1.34, cabinHalf: 0.70,
      wing: 'lip', lights: 'slim', exhaust: 'quad', rims: 'forged5', accent: '#c9a23c',
    },
  },
  {
    id: 'sf90',
    name: 'SF90 Stradale',
    full: 'Ferrari SF90 Stradale',
    year: 2019,
    tag: 'The hybrid hammer',
    blurb: '986 hp and three electric motors driving all four wheels. Traction is enormous, the nose bites, and the horizon arrives sooner than your brain expects.',
    character: ['986 hp', 'AWD', 'Hybrid'],
    paint: '#0d0e10',
    spec: {
      power: 986, torque: 800, torqueRpm: 3000, redline: 8000, idle: 800, limiter: 8250,
      mass: 1570, distF: 0.47, wheelbase: 2.65, trackF: 1.68, trackR: 1.66,
      length: 4.710, width: 1.972, height: 1.186,
      gears: [3.75, 2.35, 1.72, 1.34, 1.07, 0.88, 0.74], final: 4.12,
      shiftTime: 0.055, drive: 'AWD', driveBias: 0.34,
      cdA: 0.76, downforce: 3.4, rolling: 0.013,
      gripF: 1.46, gripR: 1.48, brake: 1.66, steerLock: 0.55,
      spring: 56, damper: 9.8, arbF: 1.12, arbR: 1.06, ride: 0.10,
      tcs: 0.9, abs: 0.95, engineBrake: 0.14, launch: 1,
      tyreF: 0.355, tyreR: 0.365, widthF: 0.265, widthR: 0.345,
      electricBoost: 0.32, zero: 2.5, vmax: 340,
    },
    sound: { cyl: 8, note: 1.12, turbo: 0.95, rasp: 0.55 },
    shape: {
      sill: 0.225, archLift: 0.30, nose: 0.56, hood: 0.75, waist: 1.0, deck: 0.88, tail: 0.86,
      roofFront: 0.34, roofRear: -1.18, roofHeight: 1.15, roofWidth: 0.29,
      cabinFront: 0.68, cabinRear: -1.30, cabinHalf: 0.70,
      wing: 'active', lights: 'slit', exhaust: 'twin-high', rims: 'turbine', accent: '#c0392b',
    },
  },
  {
    id: 'laferrari',
    name: 'LaFerrari',
    full: 'Ferrari LaFerrari',
    year: 2013,
    tag: 'The V12 legend',
    blurb: '6.3 litres, naturally aspirated, 9,250 rpm. No turbos, no delay — just a rising wall of sound and a chassis that wants to be told what to do.',
    character: ['V12', '949 hp', 'Raw'],
    paint: '#c9201b',
    spec: {
      power: 949, torque: 900, torqueRpm: 6750, redline: 9250, idle: 950, limiter: 9400,
      mass: 1585, distF: 0.41, wheelbase: 2.65, trackF: 1.70, trackR: 1.66,
      length: 4.702, width: 1.992, height: 1.116,
      gears: [3.42, 2.26, 1.71, 1.35, 1.10, 0.92, 0.78], final: 4.36,
      shiftTime: 0.05, drive: 'RWD', driveBias: 0,
      cdA: 0.82, downforce: 3.8, rolling: 0.014,
      gripF: 1.42, gripR: 1.40, brake: 1.62, steerLock: 0.52,
      spring: 62, damper: 10.4, arbF: 1.18, arbR: 1.1, ride: 0.095,
      tcs: 0.6, abs: 0.95, engineBrake: 0.22,
      tyreF: 0.355, tyreR: 0.365, widthF: 0.265, widthR: 0.345,
      electricBoost: 0.18, zero: 2.6, vmax: 350,
    },
    sound: { cyl: 12, note: 1.42, turbo: 0.0, rasp: 0.35 },
    shape: {
      sill: 0.215, archLift: 0.32, nose: 0.50, hood: 0.70, waist: 1.02, deck: 0.86, tail: 0.80,
      roofFront: 0.22, roofRear: -1.12, roofHeight: 1.11, roofWidth: 0.28,
      cabinFront: 0.56, cabinRear: -1.26, cabinHalf: 0.68,
      wing: 'fixed', lights: 'slit', exhaust: 'twin-high', rims: 'forged5', accent: '#d8b34a',
    },
  },
  {
    id: 'roma',
    name: 'Roma',
    full: 'Ferrari Roma',
    year: 2019,
    tag: 'The grand tourer',
    blurb: 'Softer springs, longer legs, a calmer diff. The Roma is the one you take when the road is the point — unhurried, elegant, still very quick.',
    character: ['GT', 'Comfort', 'V8'],
    paint: '#5c6064',
    spec: {
      power: 612, torque: 760, torqueRpm: 3000, redline: 7500, idle: 780, limiter: 7700,
      mass: 1574, distF: 0.48, wheelbase: 2.67, trackF: 1.65, trackR: 1.63,
      length: 4.656, width: 1.974, height: 1.301,
      gears: [3.60, 2.30, 1.69, 1.31, 1.05, 0.87, 0.72], final: 4.05,
      shiftTime: 0.09, drive: 'RWD', driveBias: 0,
      cdA: 0.84, downforce: 1.4, rolling: 0.015,
      gripF: 1.24, gripR: 1.28, brake: 1.42, steerLock: 0.62,
      spring: 34, damper: 7.4, arbF: 0.82, arbR: 0.76, ride: 0.13,
      tcs: 0.8, abs: 0.9, engineBrake: 0.12,
      tyreF: 0.352, tyreR: 0.358, widthF: 0.255, widthR: 0.315,
      zero: 3.4, vmax: 320,
    },
    sound: { cyl: 8, note: 0.92, turbo: 0.7, rasp: 0.3 },
    shape: {
      sill: 0.25, archLift: 0.26, nose: 0.68, hood: 0.88, waist: 0.96, deck: 0.98, tail: 0.92,
      roofFront: 0.38, roofRear: -1.22, roofHeight: 1.31, roofWidth: 0.32,
      cabinFront: 0.74, cabinRear: -1.36, cabinHalf: 0.72,
      wing: 'lip', lights: 'bar', exhaust: 'quad', rims: 'turbine', accent: '#9aa0a4',
    },
  },
  {
    id: '296',
    name: '296 GTB',
    full: 'Ferrari 296 GTB',
    year: 2021,
    tag: 'The featherweight',
    blurb: 'A 120° V6 with an electric motor, 819 hp, and the shortest wheelbase here. Lighter on its feet than anything else in the garage — it changes direction like a thought.',
    character: ['V6 hybrid', 'Nimble', '819 hp'],
    paint: '#16386e',
    spec: {
      power: 819, torque: 740, torqueRpm: 6250, redline: 8500, idle: 820, limiter: 8700,
      mass: 1470, distF: 0.435, wheelbase: 2.60, trackF: 1.66, trackR: 1.64,
      length: 4.565, width: 1.958, height: 1.187,
      gears: [3.81, 2.43, 1.78, 1.38, 1.10, 0.90, 0.75], final: 4.22,
      shiftTime: 0.06, drive: 'RWD', driveBias: 0,
      cdA: 0.77, downforce: 2.6, rolling: 0.013,
      gripF: 1.40, gripR: 1.44, brake: 1.6, steerLock: 0.60,
      spring: 50, damper: 8.9, arbF: 1.02, arbR: 0.98, ride: 0.108,
      tcs: 0.78, abs: 0.94, engineBrake: 0.17,
      tyreF: 0.350, tyreR: 0.358, widthF: 0.255, widthR: 0.325,
      electricBoost: 0.26, zero: 2.9, vmax: 330,
    },
    sound: { cyl: 6, note: 1.25, turbo: 0.8, rasp: 0.6 },
    shape: {
      sill: 0.23, archLift: 0.30, nose: 0.58, hood: 0.79, waist: 0.99, deck: 0.90, tail: 0.84,
      roofFront: 0.30, roofRear: -1.16, roofHeight: 1.16, roofWidth: 0.29,
      cabinFront: 0.66, cabinRear: -1.28, cabinHalf: 0.69,
      wing: 'lip', lights: 'slim', exhaust: 'twin-high', rims: 'turbine', accent: '#c9a23c',
    },
  },
];

export const QUALITY = {
  /* dpr is capped again against devicePixelRatio, and the streamed
     radius is what keeps a tablet's draw calls under control */
  high: { dpr: 1.75, shadow: 2048, radius: 4, terrainRes: 34, foliage: 1.0, aa: true, water: true },
  balanced: { dpr: 1.35, shadow: 1024, radius: 3, terrainRes: 26, foliage: 0.7, aa: true, water: true },
  eco: { dpr: 1.0, shadow: 0, radius: 2, terrainRes: 20, foliage: 0.45, aa: false, water: true },
};

export const SURFACES = {
  tarmac: { label: 'Tarmac', grip: 1.0, drag: 1.0, dust: 0.05, rumble: 0.0 },
  shoulder: { label: 'Shoulder', grip: 0.78, drag: 1.08, dust: 0.45, rumble: 0.3 },
  gravel: { label: 'Gravel', grip: 0.58, drag: 1.3, dust: 0.85, rumble: 0.75 },
  grass: { label: 'Meadow', grip: 0.48, drag: 1.55, dust: 0.35, rumble: 0.35 },
  sand: { label: 'Sand', grip: 0.4, drag: 1.7, dust: 0.6, rumble: 0.2 },
};
