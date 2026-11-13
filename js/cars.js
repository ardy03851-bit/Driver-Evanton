import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, smoothstep } from './config.js';

/* ═══════════════════════════════════════════════════════════════
   Procedural Ferrari coachwork — metres, origin on the road,
   +Z forward, wheels touching y = 0.
   ═══════════════════════════════════════════════════════════════ */

const shared = {
  rubber: new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.9, metalness: 0.04 }),
  rim: new THREE.MeshStandardMaterial({ color: 0xc3c7cb, roughness: 0.26, metalness: 1, envMapIntensity: 1.2 }),
  rimDark: new THREE.MeshStandardMaterial({ color: 0x33363a, roughness: 0.42, metalness: 0.92 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xcfd3d5, roughness: 0.14, metalness: 1 }),
  carbon: new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.42, metalness: 0.42 }),
  black: new THREE.MeshStandardMaterial({ color: 0x090a0b, roughness: 0.78, metalness: 0.12 }),
  mesh: new THREE.MeshStandardMaterial({ color: 0x0c0d0e, roughness: 0.6, metalness: 0.5 }),
  disc: new THREE.MeshStandardMaterial({ color: 0x75787a, roughness: 0.4, metalness: 0.9 }),
  caliper: null,
  glass: new THREE.MeshPhysicalMaterial({
    color: 0x0b1116, roughness: 0.045, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.02,
    transparent: true, opacity: 0.9, envMapIntensity: 2.1, side: THREE.DoubleSide,
  }),
  head: new THREE.MeshStandardMaterial({ color: 0xfff6e2, emissive: 0xffe8bd, emissiveIntensity: 1.0, roughness: 0.22, metalness: 0.25 }),
  drl: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3da, emissiveIntensity: 1.8, roughness: 0.15, metalness: 0.2 }),
  reverse: new THREE.MeshStandardMaterial({ color: 0xcfd0cb, emissive: 0xffffff, emissiveIntensity: 0.1, roughness: 0.35 }),
};
shared.caliper = new THREE.MeshStandardMaterial({ color: 0xd8b34a, roughness: 0.35, metalness: 0.35 });

const shadowTexture = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,.66)');
  grd.addColorStop(0.42, 'rgba(0,0,0,.44)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

/* ── helpers ─────────────────────────────────────────────────── */
function profileAt(points, x) {
  if (x <= points[0][0]) return points[0][1];
  if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
  let a = points[0], b = points[points.length - 1];
  for (let i = 0; i < points.length - 1; i++) {
    if (x >= points[i][0] && x <= points[i + 1][0]) { a = points[i]; b = points[i + 1]; break; }
  }
  const t = clamp((x - a[0]) / (b[0] - a[0] || 1), 0, 1);
  return lerp(a[1], b[1], t * t * (3 - 2 * t));
}

function makePaint(hex) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(hex), metalness: 0.42, roughness: 0.235,
    clearcoat: 1, clearcoatRoughness: 0.045, envMapIntensity: 1.55,
  });
}

function addMesh(parent, geo, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}

function loft(ringsData, ringPoints = 30, material) {
  const pos = [], uv = [], idx = [];
  const n = ringsData.length;
  for (let i = 0; i < n; i++) {
    const r = ringsData[i];
    const cy = (r.top + r.bottom) / 2;
    const hy = Math.max(0.001, (r.top - r.bottom) / 2);
    for (let j = 0; j < ringPoints; j++) {
      const a = (j / ringPoints) * Math.PI * 2;
      const cx = Math.cos(a), sy = Math.sin(a);
      const ex = r.exp || 3.1;
      const px = r.halfW * Math.sign(cx) * Math.pow(Math.abs(cx), 2 / ex);
      const py = cy + hy * Math.sign(sy) * Math.pow(Math.abs(sy), 2 / ex);
      pos.push(px, py, r.z);
      uv.push(j / ringPoints, i / (n - 1));
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < ringPoints; j++) {
    const a = i * ringPoints + j, b = i * ringPoints + ((j + 1) % ringPoints);
    const c = (i + 1) * ringPoints + j, d = (i + 1) * ringPoints + ((j + 1) % ringPoints);
    idx.push(a, b, c, b, d, c);
  }
  const cap = (ringIndex, flip) => {
    const base = ringIndex * ringPoints;
    const center = pos.length / 3;
    let cx = 0, cy = 0;
    for (let j = 0; j < ringPoints; j++) { cx += pos[(base + j) * 3]; cy += pos[(base + j) * 3 + 1]; }
    cx /= ringPoints; cy /= ringPoints;
    pos.push(cx, cy, ringsData[ringIndex].z);
    uv.push(0.5, 0.5);
    for (let j = 0; j < ringPoints; j++) {
      const a = base + j, b = base + ((j + 1) % ringPoints);
      if (flip) idx.push(center, b, a); else idx.push(center, a, b);
    }
  };
  cap(0, false); cap(n - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, material);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

/* ── wheel ───────────────────────────────────────────────────── */
function buildWheel(spec, def, isFront) {
  const R = isFront ? spec.tyreF : spec.tyreR;
  const W = isFront ? spec.widthF : spec.widthR;
  const pivot = new THREE.Group();
  const spin = new THREE.Group();
  pivot.add(spin);

  const tyrePts = [
    new THREE.Vector2(R * 0.76, -W * 0.5),
    new THREE.Vector2(R * 0.89, -W * 0.495),
    new THREE.Vector2(R * 0.968, -W * 0.4),
    new THREE.Vector2(R * 0.996, -W * 0.26),
    new THREE.Vector2(R, -W * 0.1),
    new THREE.Vector2(R, W * 0.1),
    new THREE.Vector2(R * 0.996, W * 0.26),
    new THREE.Vector2(R * 0.968, W * 0.4),
    new THREE.Vector2(R * 0.89, W * 0.495),
    new THREE.Vector2(R * 0.76, W * 0.5),
  ];
  const tyreGeo = new THREE.LatheGeometry(tyrePts, 48);
  tyreGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.Mesh(tyreGeo, shared.rubber);
  tyre.castShadow = true; tyre.receiveShadow = true;
  spin.add(tyre);

  const barrelGeo = new THREE.CylinderGeometry(R * 0.77, R * 0.77, W * 0.9, 36, 1, true);
  barrelGeo.rotateZ(Math.PI / 2);
  spin.add(new THREE.Mesh(barrelGeo, shared.rimDark));

  const rimStyle = def.shape.rims;
  const pairs = rimStyle === 'turbine' ? 10 : 5;
  const spokes = [];
  const spokeLen = R * 0.645;
  for (const side of [-1, 1]) {
    for (let i = 0; i < pairs; i++) {
      const a = (i / pairs) * Math.PI * 2;
      const tang = rimStyle === 'turbine' ? 0.022 : 0.05;
      const geo = new THREE.BoxGeometry(0.03, spokeLen, tang);
      geo.translate(0, spokeLen * 0.5 + R * 0.1, 0);
      const p = geo.attributes.position;
      for (let v = 0; v < p.count; v++) {
        const y = p.getY(v);
        const k = y > spokeLen * 0.55 ? 0.55 : 1;
        p.setX(v, p.getX(v) * k);
        p.setZ(v, p.getZ(v) * (rimStyle === 'turbine' ? 2.1 : 0.78));
      }
      geo.computeVertexNormals();
      geo.rotateX(a);
      geo.translate(side * W * 0.4, 0, 0);
      spokes.push(geo);
      if (pairs === 5) {
        const twin = new THREE.BoxGeometry(0.028, spokeLen * 0.97, 0.028);
        twin.translate(0, spokeLen * 0.5 + R * 0.1, 0);
        twin.rotateX(a + 0.19);
        twin.translate(side * W * 0.4, 0, 0);
        spokes.push(twin);
      }
    }
    // rim lip
    const lip = new THREE.TorusGeometry(R * 0.77, 0.019, 6, 44);
    lip.rotateY(Math.PI / 2);
    lip.translate(side * W * 0.44, 0, 0);
    spokes.push(lip);
    // dish
    const dish = new THREE.CylinderGeometry(R * 0.6, R * 0.6, 0.012, 24);
    dish.rotateZ(Math.PI / 2);
    dish.translate(side * W * 0.12, 0, 0);
    spokes.push(dish);
    // centre cap
    const cap = new THREE.CylinderGeometry(R * 0.105, R * 0.105, 0.03, 18);
    cap.rotateZ(Math.PI / 2);
    cap.translate(side * (W * 0.44 + 0.012), 0, 0);
    spokes.push(cap);
  }
  const spokeMesh = new THREE.Mesh(mergeGeometries(spokes, false), shared.rim);
  spokeMesh.castShadow = true;
  spin.add(spokeMesh);
  spokes.forEach((g) => g.dispose());

  // badge
  for (const side of [-1, 1]) {
    const b = new THREE.CylinderGeometry(R * 0.055, R * 0.055, 0.036, 14);
    b.rotateZ(Math.PI / 2);
    b.translate(side * (W * 0.455 + 0.012), 0, 0);
    spin.add(new THREE.Mesh(b, new THREE.MeshStandardMaterial({ color: 0xe0b62a, roughness: 0.3, metalness: 0.55 })));
  }

  const discGeo = new THREE.CylinderGeometry(R * 0.67, R * 0.67, 0.028, 32);
  discGeo.rotateZ(Math.PI / 2);
  const disc = new THREE.Mesh(discGeo, shared.disc);
  disc.position.x = -W * 0.01;
  spin.add(disc);

  const calMat = new THREE.MeshStandardMaterial({ color: def.shape.accent, roughness: 0.34, metalness: 0.4 });
  const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.05, R * 0.36, R * 0.26), calMat);
  caliper.position.set(-W * 0.02, R * 0.3, -R * 0.5);
  caliper.castShadow = true;
  pivot.add(caliper);

  return { pivot, spin, radius: R, width: W };
}

/* ── car ─────────────────────────────────────────────────────── */
export function buildCar(def, paintHex) {
  const spec = def.spec, sh = def.shape;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const paint = makePaint(paintHex || def.paint);
  const paint2 = paint.clone();
  const paintMats = [paint, paint2];
  const tailMat = shared.head.clone();
  tailMat.color.set(0x380403);
  tailMat.emissive.set(0xd41a0a);
  tailMat.emissiveIntensity = 1.1;
  tailMat.roughness = 0.3;
  tailMat.metalness = 0.15;
  const headMat = shared.head.clone();
  const drlMat = shared.drl.clone();

  const L = spec.length, W = spec.width, half = L / 2;
  const zF = spec.wheelbase / 2, zR = -spec.wheelbase / 2;
  const trackF = spec.trackF / 2, trackR = spec.trackR / 2;
  const Rf = spec.tyreF, Rr = spec.tyreR;

  const topPts = [
    [1.0, sh.nose], [0.82, sh.nose + (sh.hood - sh.nose) * 0.55], [0.56, sh.hood],
    [0.26, sh.waist], [-0.16, sh.deck + 0.02], [-0.54, sh.deck], [-0.84, sh.tail + 0.01], [-1.0, sh.tail - 0.04],
  ];
  const widthPts = [
    [1.0, 0.6], [0.88, 0.79], [0.64, 0.915], [0.4, 0.98], [0.0, 1.0],
    [-0.44, 1.005], [-0.7, 0.99], [-0.9, 0.92], [-1.0, 0.79],
  ];
  const hwAt = (z) => (W / 2) * profileAt(widthPts, clamp(z / half, -1, 1));
  const arch = (z, zc, rad, lift) => lift * Math.exp(-Math.pow((z - zc) / rad, 4));

  /* body shell */
  const stations = 60, ringPoints = 34;
  const rings = [];
  for (let i = 0; i <= stations; i++) {
    const z = -half + (i / stations) * L;
    const zn = clamp(z / half, -1, 1);
    const top = profileAt(topPts, zn);
    let hw = hwAt(z);
    hw += 0.022 * Math.exp(-Math.pow((z - zF) / 0.72, 4)) + 0.03 * Math.exp(-Math.pow((z - zR) / 0.8, 4));
    hw *= 1 - 0.2 * Math.pow(smoothstep(0.86, 1, Math.abs(zn)), 1.5);
    let bottom = sh.sill + arch(z, zF, 0.64, sh.archLift) + arch(z, zR, 0.68, sh.archLift * 1.06);
    bottom += 0.075 * smoothstep(0.86, 1, Math.abs(zn));
    rings.push({ z, halfW: hw, bottom, top, exp: 3.05 + 0.55 * (1 - Math.abs(zn)) });
  }
  body.add(loft(rings, ringPoints, paint));

  /* glasshouse */
  const cF = sh.cabinFront, cR = sh.cabinRear;
  const cabinRings = [];
  for (let i = 0; i <= 28; i++) {
    const t = i / 28;
    const z = lerp(cR, cF, t);
    const base = profileAt(topPts, clamp(z / half, -1, 1));
    const k = smoothstep(cF, cF - 0.5, z) * smoothstep(cR, cR + 0.66, z);
    const roof = lerp(base + 0.012, sh.roofHeight, k);
    const hw = sh.cabinHalf * (0.5 + 0.5 * Math.sqrt(k)) * (0.92 + 0.08 * Math.sin(Math.PI * t));
    cabinRings.push({ z, halfW: Math.max(0.04, hw), bottom: base - 0.05, top: Math.max(base + 0.015, roof), exp: 2.35 });
  }
  const cabin = loft(cabinRings, 28, shared.glass);
  cabin.castShadow = false; cabin.receiveShadow = false;
  body.add(cabin);

  /* painted roof */
  const roofRings = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const z = lerp(cR + 0.34, cF - 0.3, t);
    const base = profileAt(topPts, clamp(z / half, -1, 1));
    const k = smoothstep(cF - 0.24, cF - 0.62, z) * smoothstep(cR + 0.4, cR + 1.05, z);
    const roof = lerp(base + 0.02, sh.roofHeight + 0.004, k);
    const hw = sh.cabinHalf * (0.46 + 0.54 * Math.sqrt(k)) * 0.8;
    roofRings.push({ z, halfW: Math.max(0.03, hw), bottom: roof - 0.045, top: roof + 0.012, exp: 2.1 });
  }
  body.add(loft(roofRings, 20, paint2));

  /* cabin base trim */
  for (const s of [-1, 1]) {
    const trim = addMesh(body, new THREE.BoxGeometry(0.035, 0.045, (cF - cR) * 0.9), shared.carbon, s * sh.cabinHalf * 0.96, sh.waist - 0.005, (cF + cR) / 2);
    trim.rotation.z = s * -0.04;
  }

  /* floor & aero */
  const floor = new THREE.Mesh(new THREE.BoxGeometry(W * 0.84, 0.09, L * 0.8), shared.black);
  floor.position.set(0, sh.sill + 0.02, 0);
  floor.receiveShadow = true;
  body.add(floor);

  const splitter = addMesh(body, new THREE.BoxGeometry(W * 0.94, 0.032, 0.5), shared.carbon, 0, sh.nose - 0.075, half - 0.2);
  splitter.rotation.x = -0.04;
  const skirtGeo = new THREE.BoxGeometry(0.075, 0.075, spec.wheelbase * 1.03);
  addMesh(body, skirtGeo, shared.carbon, W / 2 - 0.075, sh.sill - 0.045, 0);
  addMesh(body, skirtGeo, shared.carbon, -W / 2 + 0.075, sh.sill - 0.045, 0);

  /* rear diffuser */
  const diff = addMesh(body, new THREE.BoxGeometry(W * 0.7, 0.05, 0.54), shared.carbon, 0, 0.185, -half + 0.18);
  diff.rotation.x = 0.2;
  for (let i = -2; i <= 2; i++) {
    const fin = addMesh(body, new THREE.BoxGeometry(0.016, 0.15, 0.4), shared.carbon, i * 0.2, 0.2, -half + 0.17);
    fin.rotation.x = 0.2;
  }

  /* side intakes, correctly seated on the skin */
  for (const s of [-1, 1]) {
    const z = -0.62;
    const hw = hwAt(z) + 0.02;
    const intake = new THREE.Mesh(new THREE.CircleGeometry(0.2, 20), shared.black);
    intake.position.set(s * (hw - 0.015), sh.waist - 0.16, z);
    intake.rotation.y = s * Math.PI / 2;
    intake.scale.set(1.45, 0.72, 1);
    body.add(intake);
    const blade = addMesh(body, new THREE.BoxGeometry(0.045, 0.028, 0.5), paint, s * (hw - 0.02), sh.waist - 0.08, z);
    blade.rotation.z = s * 0.08;
    // fender shield badge
    const badge = addMesh(body, new THREE.BoxGeometry(0.012, 0.075, 0.06), new THREE.MeshStandardMaterial({ color: 0xdfb427, roughness: 0.3, metalness: 0.5 }), s * (hwAt(0.55) + 0.005), sh.waist - 0.22, 0.55);
  }

  /* mirrors */
  for (const s of [-1, 1]) {
    const z = cF - 0.12;
    const hw = hwAt(z);
    const stalk = addMesh(body, new THREE.BoxGeometry(0.19, 0.02, 0.035), shared.carbon, s * (hw + 0.03), sh.waist + 0.035, z);
    stalk.rotation.z = s * -0.11;
    const mirror = addMesh(body, new THREE.BoxGeometry(0.2, 0.075, 0.115), paint, s * (hw + 0.13), sh.waist + 0.07, z - 0.015);
    mirror.rotation.y = s * 0.1;
    const mglass = addMesh(body, new THREE.BoxGeometry(0.012, 0.052, 0.085), shared.glass, s * (hw + 0.232), sh.waist + 0.07, z - 0.015);
    mglass.rotation.y = s * 0.1;
  }

  /* front intakes & hood vents */
  addMesh(body, new THREE.BoxGeometry(W * 0.58, 0.13, 0.07), shared.black, 0, sh.nose - 0.16, half - 0.06);
  for (const s of [-1, 1]) {
    const scoop = addMesh(body, new THREE.BoxGeometry(0.3, 0.095, 0.055), shared.mesh, s * W * 0.32, sh.nose - 0.1, half - 0.075);
    scoop.rotation.z = s * 0.14;
  }
  for (const s of [-1, 1]) {
    const vent = addMesh(body, new THREE.BoxGeometry(0.34, 0.014, 0.22), shared.black, s * W * 0.27, profileAt(topPts, 0.86 / half) + 0.004, 0.86);
    vent.rotation.x = -0.06;
    vent.rotation.z = s * 0.05;
  }

  /* engine cover louvres */
  for (let i = 0; i < 4; i++) {
    const z = -1.46 - i * 0.16;
    const y = profileAt(topPts, z / half) + 0.006;
    const louvre = addMesh(body, new THREE.BoxGeometry(W * 0.5 - i * 0.012, 0.012, 0.075), shared.carbon, 0, y, z);
    louvre.rotation.x = 0.12;
  }

  /* headlights */
  const headZ = half - 0.045;
  for (const s of [-1, 1]) {
    const housing = addMesh(body, new THREE.BoxGeometry(0.38, 0.105, 0.13), shared.black, s * W * 0.3, sh.nose + 0.1, headZ);
    housing.rotation.set(0.05, s * -0.16, s * 0.1);
    const lens = addMesh(body, new THREE.BoxGeometry(0.33, 0.06, 0.11), headMat, s * W * 0.3, sh.nose + 0.105, headZ + 0.008);
    lens.rotation.copy(housing.rotation);
    const drl = addMesh(body, new THREE.BoxGeometry(0.33, 0.013, 0.1), drlMat, s * W * 0.3, sh.nose + 0.055, headZ + 0.004);
    drl.rotation.copy(housing.rotation);
  }

  /* tail */
  const tailZ = -half + 0.02;
  addMesh(body, new THREE.BoxGeometry(W * 0.68, 0.24, 0.055), shared.mesh, 0, sh.tail - 0.19, tailZ);
  for (const s of [-1, 1]) {
    if (sh.lights === 'bar') {
      const housing = addMesh(body, new THREE.BoxGeometry(W * 0.4, 0.075, 0.05), shared.black, s * W * 0.2, sh.tail - 0.035, tailZ + 0.01);
      const bar = addMesh(body, new THREE.BoxGeometry(W * 0.34, 0.032, 0.045), tailMat, s * W * 0.2, sh.tail - 0.035, tailZ + 0.015);
    } else {
      const housing = addMesh(body, new THREE.BoxGeometry(0.34, 0.13, 0.055), shared.black, s * W * 0.26, sh.tail - 0.035, tailZ + 0.01);
      housing.rotation.y = s * -0.08;
      const duo = sh.lights === 'slim';
      for (const dz of duo ? [-0.075, 0.075] : [-0.06]) {
        const lamp = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.021, 7, 20), tailMat);
        lamp.position.set(s * (W * 0.26 + dz * 0.08), sh.tail - 0.035 + dz * 0.25, tailZ + 0.02);
        body.add(lamp);
        const glow = addMesh(body, new THREE.CircleGeometry(0.06, 16), tailMat, s * (W * 0.26 + dz * 0.08), sh.tail - 0.035 + dz * 0.25, tailZ + 0.012);
        glow.rotation.y = Math.PI;
      }
    }
  }
  // high centre brake strip + reverse lamps
  addMesh(body, new THREE.BoxGeometry(W * 0.5, 0.012, 0.03), tailMat, 0, sh.tail + 0.03, tailZ + 0.005);
  for (const s of [-1, 1]) addMesh(body, new THREE.BoxGeometry(0.16, 0.026, 0.03), shared.reverse, s * W * 0.11, sh.tail - 0.17, tailZ + 0.008);

  /* exhausts */
  const exGeo = new THREE.CylinderGeometry(0.052, 0.058, 0.15, 16, 1, true);
  exGeo.rotateX(Math.PI / 2);
  const exY = sh.tail - 0.29;
  const exX = sh.exhaust === 'quad' ? [-0.34, -0.22, 0.22, 0.34] : [-0.14, 0.14];
  for (const x of exX) {
    const tip = new THREE.Mesh(exGeo, shared.chrome);
    tip.position.set(x, exY, tailZ - 0.04);
    body.add(tip);
    const inner = new THREE.Mesh(new THREE.CircleGeometry(0.045, 14), shared.black);
    inner.position.set(x, exY, tailZ - 0.115);
    inner.rotation.y = Math.PI;
    body.add(inner);
  }

  /* wing */
  let wing = null;
  if (sh.wing === 'lip') {
    wing = addMesh(body, new THREE.BoxGeometry(W * 0.78, 0.022, 0.14), shared.carbon, 0, sh.tail + 0.055, -half + 0.1);
    wing.rotation.x = -0.12;
  } else {
    const wingGroup = new THREE.Group();
    for (const s of [-1, 1]) {
      const support = addMesh(wingGroup, new THREE.BoxGeometry(0.026, 0.16, 0.17), shared.carbon, s * W * 0.28, sh.tail + 0.055, -half + 0.26);
      support.rotation.x = -0.12;
    }
    wing = addMesh(wingGroup, new THREE.BoxGeometry(W * 0.88, 0.026, 0.31), shared.carbon, 0, sh.tail + 0.14, -half + 0.28);
    wing.rotation.x = -0.15;
    body.add(wingGroup);
    wing.userData.assembly = wingGroup;
  }

  /* wiper */
  addMesh(body, new THREE.BoxGeometry(0.42, 0.01, 0.016), shared.black, -0.22, profileAt(topPts, cF / half) + 0.03, cF - 0.03).rotation.y = 0.18;

  /* contact shadow */
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.3, L * 1.1),
    new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: 0.8 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.01;
  shadow.renderOrder = 2;
  group.add(shadow);

  /* wheels */
  const wheels = [];
  for (const [isFront, zc, track] of [[true, zF, trackF], [true, zF, -trackF], [false, zR, trackR], [false, zR, -trackR]]) {
    const w = buildWheel(spec, def, isFront);
    w.pivot.position.set(track, isFront ? Rf : Rr, zc);
    w.front = isFront;
    w.side = Math.sign(track);
    group.add(w.pivot);
    wheels.push(w);
  }

  /* beams */
  const beams = [];
  for (const s of [-1, 1]) {
    const light = new THREE.SpotLight(0xffe7c0, 0, 68, 0.42, 0.6, 1.1);
    light.position.set(s * W * 0.27, sh.nose + 0.12, half - 0.1);
    light.target.position.set(s * W * 0.8, 0.02, half + 30);
    group.add(light, light.target);
    beams.push(light);
  }

  const setPaint = (hex) => {
    const c = new THREE.Color(hex);
    paintMats.forEach((m) => m.color.copy(c));
  };

  return {
    group, body, wheels, beams, wing, paintMats, setPaint, def, spec,
    setBrake(on) { tailMat.emissiveIntensity = on ? 2.8 : 1.05; },
    setLights(on) {
      headMat.emissiveIntensity = on ? 3.4 : 1.0;
      drlMat.emissiveIntensity = on ? 4.2 : 1.8;
      beams.forEach((b) => { b.intensity = on ? 2.2 : 0; });
    },
    dispose() {
      group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      paintMats.forEach((m) => m.dispose());
      headMat.dispose(); drlMat.dispose(); tailMat.dispose();
      group.removeFromParent();
    },
  };
}
