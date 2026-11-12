import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

/* ═══════════════════════════════════════════════════════════════
   Real Ferrari 458 Spider — glTF model by vicent091036 (CC BY 4.0),
   distributed with the three.js examples. Loaded from assets/models/.
   ═══════════════════════════════════════════════════════════════ */

let TEMPLATE = null;

export async function loadModelTemplate() {
  if (TEMPLATE) return TEMPLATE;
  const draco = new DRACOLoader();
  draco.setDecoderPath('vendor/draco/');
  draco.setWorkerLimit(2);
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);
  const gltf = await loader.loadAsync('assets/models/458italia.glb');
  TEMPLATE = gltf.scene;
  TEMPLATE.updateMatrixWorld(true);
  return TEMPLATE;
}

const tyre = () => new THREE.MeshStandardMaterial({ color: 0x0b0c0d, roughness: 0.88, metalness: 0.03 });
const chrome = () => new THREE.MeshStandardMaterial({ color: 0xd6d9da, roughness: 0.12, metalness: 1, envMapIntensity: 1.5 });
const brushed = () => new THREE.MeshStandardMaterial({ color: 0x9ea2a5, roughness: 0.32, metalness: 0.95, envMapIntensity: 1.2 });
const carbon = () => new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.4, metalness: 0.5, envMapIntensity: 0.9 });
const glass = () => new THREE.MeshPhysicalMaterial({
  color: 0x0b1013, roughness: 0.04, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.02,
  transparent: true, opacity: 0.72, envMapIntensity: 2.4, side: THREE.DoubleSide,
});
const darkTrim = () => new THREE.MeshStandardMaterial({ color: 0x161718, roughness: 0.55, metalness: 0.35 });

export function buildModelCar(def, paintHex, template) {
  const spec = def.spec;
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const source = (template || TEMPLATE).clone(true);
  const shell = new THREE.Group();
  shell.rotation.y = Math.PI;
  shell.add(source);
  body.add(shell);

  const paint = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(paintHex || def.paint),
    metalness: 0.08, roughness: 0.26, clearcoat: 1, clearcoatRoughness: 0.022, envMapIntensity: 2.0,
  });
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff2d8, emissive: 0xffe2ad, emissiveIntensity: 1.5, roughness: 0.2, metalness: 0.2,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x320302, emissive: 0xd4180a, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0.15,
    transparent: false,
  });
  const indicator = new THREE.MeshStandardMaterial({ color: 0x3a0d04, emissive: 0xb63a0c, emissiveIntensity: 0.5, roughness: 0.4 });
  const owned = new Set();
  const own = (m) => { owned.add(m); return m; };
  const upgrade = (mat) => {
    switch (mat.name) {
      case 'Body_Color': return paint;
      case 'Glass_Gray': return own(glass());
      case 'Tires': return own(tyre());
      case 'Taillight_Glass': return tailMat;
      case 'Turn_Signal_LED': return indicator;
      case 'Projector_Glass': return headMat;
      case 'metal_chrome': return own(chrome());
      case 'metal_gray': return own(brushed());
      case 'Carbon_Fiber': return own(carbon());
      case 'plastic_gray': return own(darkTrim());
      case '_0098_DodgerBlue': return own(new THREE.MeshStandardMaterial({ color: 0x2a6db5, roughness: 0.4, metalness: 0.25 }));
      case 'Ferrari_Yellow': return own(new THREE.MeshStandardMaterial({ color: 0xe8c02c, roughness: 0.3, metalness: 0.55, emissive: 0x2a1e00, emissiveIntensity: 0.15 }));
      case 'Leather_red': return own(new THREE.MeshStandardMaterial({ color: 0x401819, roughness: 0.75, metalness: 0.05 }));
      default: return mat;
    }
  };

  source.traverse((o) => {
    if (!o.isMesh) return;
    const wasGlass = o.material?.name === 'Glass_Gray';
    const wasTail = o.material?.name === 'Taillight_Glass';
    o.castShadow = !wasGlass && !wasTail;
    o.receiveShadow = true;
    o.material = upgrade(o.material);
  });

  /* ── size & placement ─────────────────────────────────────── */
  source.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(shell);
  let size = box.getSize(new THREE.Vector3());
  const targetLen = spec.length;
  const scale = targetLen / Math.max(size.z, 0.01);
  shell.scale.setScalar(scale);
  shell.updateMatrixWorld(true);
  box.setFromObject(shell);
  const centre = box.getCenter(new THREE.Vector3());
  shell.position.x -= centre.x;
  shell.position.z -= centre.z;
  shell.position.y -= box.min.y;

  /* ── wheels: wrap so they can steer and spin ──────────────── */
  const wheels = [];
  const wheelRadius = 0.358 * scale;
  for (const [name, front] of [['wheel_fl', true], ['wheel_fr', true], ['wheel_rl', false], ['wheel_rr', false]]) {
    const node = source.getObjectByName(name);
    if (!node) continue;
    const parent = node.parent;
    node.updateMatrixWorld(true);
    const pivot = new THREE.Group();
    pivot.name = `${name}_steer`;
    pivot.position.copy(node.position);
    parent.add(pivot);
    node.position.set(0, 0, 0);
    pivot.add(node);
    pivot.updateMatrixWorld(true);
    // calipers should not rotate with the disc
    [...node.children].forEach((c) => {
      if (/brake/i.test(c.name)) pivot.attach(c);
    });
    /* does this node's local +X point along the car's +X? decides roll sign */
    node.updateWorldMatrix(true, false);
    const axle = new THREE.Vector3(1, 0, 0).transformDirection(node.matrixWorld);
    wheels.push({ pivot, spin: node, radius: wheelRadius, spinSign: Math.sign(axle.x) || 1, front, name });
  }

  /* sit the tyres exactly on the road, whatever the model's bounding box says */
  if (wheels.length) {
    group.updateMatrixWorld(true);
    const tyreBox = new THREE.Box3();
    for (const w of wheels) tyreBox.expandByObject(w.pivot);
    if (Number.isFinite(tyreBox.min.y)) shell.position.y -= tyreBox.min.y;
    group.updateMatrixWorld(true);
  }

  /* headlight beams */
  const beams = [];
  for (const s of [-1, 1]) {
    const light = new THREE.SpotLight(0xffe8c4, 0, 72, 0.4, 0.62, 1.05);
    light.position.set(s * spec.width * 0.3, 0.62, -spec.length / 2 + 0.15);
    light.target.position.set(s * spec.width * 0.75, 0.02, -spec.length / 2 - 34);
    group.add(light, light.target);
    beams.push(light);
  }

  const shadowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,.85)');
    grd.addColorStop(0.5, 'rgba(0,0,0,.5)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(spec.width * 1.28, spec.length * 1.06),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.95 })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.014;
  shadow.renderOrder = 2;
  group.add(shadow);

  return {
    group, body, wheels, beams, wing: null, paintMats: [paint], paint, setPaint(hex) {
      paint.color.set(hex);
    },
    def, spec,
    setBrake(on) { tailMat.emissiveIntensity = on ? 3.4 : 1.15; },
    setLights(on) {
      headMat.emissiveIntensity = on ? 4.4 : 1.5;
      beams.forEach((b) => { b.intensity = on ? 2.6 : 0; });
    },
    dispose() {
      owned.forEach((m) => m.dispose());
      paint.dispose(); headMat.dispose(); tailMat.dispose(); indicator.dispose();
      group.removeFromParent();
    },
  };
}
