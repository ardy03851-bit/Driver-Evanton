import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TAU, clamp, lerp, smoothstep, rng, fbm, TIMES, QUALITY } from './config.js';
import { TEX, tiled } from './assets.js';

const WIND = { uTime: { value: 0 } };
const TILE = 200;
const ROAD_HALF = 5.15;
const SHOULDER = 7.0;
const LANE = 3.58;

/* ═══════════════════════════════════════════════════════════════
   route parametrisation — a long, calm alpine road
   ═══════════════════════════════════════════════════════════════ */
export const roadX = (s) => Math.sin(s * 0.00235) * 92 + Math.sin(s * 0.0067 + 1.3) * 25 + Math.sin(s * 0.0172 + 0.4) * 4.6;
export const roadY = (s) => 7.4 + Math.sin(s * 0.0034) * 3.6 + Math.sin(s * 0.0011 + 2.1) * 6.2 + Math.sin(s * 0.0081) * 0.75;
export const roadD = (s) => Math.cos(s * 0.00235) * 0.2162 + Math.cos(s * 0.0067 + 1.3) * 0.1675 + Math.cos(s * 0.0172 + 0.4) * 0.0791;
export const roadYaw = (s) => Math.atan2(roadD(s), -1);
export const roadPoint = (s, off = 0, raise = 0) => {
  const d = roadD(s), n = Math.sqrt(1 + d * d);
  return new THREE.Vector3(roadX(s) + off / n, roadY(s) + raise, -s + (off * d) / n);
};

export function groundHeight(x, z) {
  const s = -z;
  const d = x - roadX(s);
  const n = Math.sqrt(1 + roadD(s) ** 2);
  const ad = Math.abs(d) / n;
  const blend = smoothstep(11, 52, ad);
  const nx = x * 0.0075, nz = s * 0.0075;
  const hills = (fbm(nx * 1.7 + 4, nz * 1.7 - 2, 3) - 0.24) * 26;
  const detail = (fbm(x * 0.028, s * 0.028, 2) - 0.5) * 2.4;
  const basin = -Math.exp(-Math.pow((ad - 168) / 96, 2)) * 20;
  const ridge = smoothstep(120, 380, ad) * (fbm(x * 0.0038 + 11, s * 0.0038 + 7, 3) - 0.2) * 74;
  const base = roadY(s) - 1.1 + hills + detail + basin + ridge;
  return lerp(roadY(s) - 0.22, base, blend);
}

export function surfaceHeight(x, z) {
  const s = -z;
  const d = x - roadX(s);
  const off = d * Math.sqrt(1 + roadD(s) ** 2);
  const ao = Math.abs(off);
  const h = groundHeight(x, z);
  if (ao <= ROAD_HALF) return roadY(s);
  if (ao <= SHOULDER) return lerp(roadY(s) - 0.05, h, smoothstep(ROAD_HALF, SHOULDER, ao));
  return h;
}

export function roadInfo(x, z) {
  const s = -z;
  const off = (x - roadX(s)) * Math.sqrt(1 + roadD(s) ** 2);
  const ao = Math.abs(off);
  let surface = 'grass';
  if (ao <= LANE + 0.1) surface = 'tarmac';
  else if (ao <= ROAD_HALF + 0.35) surface = 'shoulder';
  else if (ao <= SHOULDER) surface = 'gravel';
  else if (surfaceHeight(x, z) < 1.2) surface = 'sand';
  return { s, offset: off, surface, onRoad: ao <= SHOULDER };
}

/* ═══════════════════════════════════════════════════════════════
   environment reflection (sky + earth + sun)
   ═══════════════════════════════════════════════════════════════ */
function buildEnvMap(renderer) {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      top: { value: new THREE.Color(0x6f9cc4) },
      ground: { value: new THREE.Color(0x5d5b4a) },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 ground;
      void main(){ float h = normalize(vP).y;
        vec3 c = mix(ground, top, smoothstep(-0.15, 0.5, h));
        c = mix(c, vec3(1.0,0.88,0.66), pow(max(h,0.0), 40.0)*0.9);
        gl_FragColor = vec4(c,1.0); }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 12), new THREE.MeshBasicMaterial({ color: 0xfff2d8 }));
  sun.position.set(-4, 4.6, -6);
  scene.add(sun);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(scene, 0.02).texture;
  geo.dispose(); mat.dispose(); sun.geometry.dispose(); sun.material.dispose();
  pmrem.dispose();
  return tex;
}

/* ═══════════════════════════════════════════════════════════════
   World
   ═══════════════════════════════════════════════════════════════ */
export class World {
  constructor(scene, renderer, quality = 'high') {
    this.scene = scene;
    this.renderer = renderer;
    this.quality = QUALITY[quality] || QUALITY.high;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.terrain = new Map();
    this.roads = new Map();
    this.pending = [];
    this.lastKey = '';
    this.fade = 0;
    this.time = 'golden';
    this.palette = null;
    this.wind = WIND;
    this._firstPass = true;

    scene.environment = buildEnvMap(renderer);
    scene.environmentIntensity = 0.8;

    /* lights */
    this.hemi = new THREE.HemisphereLight(0xcfe0ee, 0x5f5946, 1.0);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffd9b0, 2.8);
    this.sun.castShadow = this.quality.shadow > 0;
    this.sun.shadow.mapSize.set(this.quality.shadow, this.quality.shadow);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    const d = 62;
    Object.assign(this.sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 2.2;
    scene.add(this.sun, this.sun.target);
    this.fill = new THREE.DirectionalLight(0xb9cfe6, 0.55);
    this.fill.position.set(60, 40, -40);
    scene.add(this.fill);

    /* sky */
    this.skyUniforms = {
      uTop: { value: new THREE.Color(0x4b6c88) },
      uMid: { value: new THREE.Color(0xe2b083) },
      uHorizon: { value: new THREE.Color(0xffd9a1) },
      uSunColor: { value: new THREE.Color(0xffe6c0) },
      uSunDir: { value: new THREE.Vector3(-0.52, 0.2, -0.83).normalize() },
      uCloud: { value: new THREE.Color(0xffe2c2) },
      uCloudAmount: { value: 0.5 },
      uTime: WIND.uTime,
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(3000, 40, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false, uniforms: this.skyUniforms,
        vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: `
          varying vec3 vDir;
          uniform vec3 uTop,uMid,uHorizon,uSunColor,uCloud;
          uniform vec3 uSunDir; uniform float uCloudAmount,uTime;
          float h21(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
          float n2(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
            return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
          float fbm2(vec2 p){ float v=0.0,a=0.55; for(int i=0;i<5;i++){ v+=a*n2(p); p=p*2.03+vec2(7.3,3.1); a*=0.5; } return v; }
          void main(){
            vec3 dir = normalize(vDir);
            float h = clamp(dir.y, -0.08, 1.0);
            vec3 col = mix(uHorizon, uMid, smoothstep(-0.01, 0.22, h));
            col = mix(col, uTop, smoothstep(0.08, 0.55, h));
            float sd = max(dot(dir, normalize(uSunDir)), 0.0);
            col += uSunColor * (pow(sd, 1400.0) * 6.0 + pow(sd, 22.0) * 0.20 + pow(sd, 4.0) * 0.05);
            // high, thin cloud field
            vec2 cuv = dir.xz / max(dir.y + 0.22, 0.08);
            float cn = fbm2(cuv * 0.55 + vec2(uTime * 0.0016, uTime * 0.0007));
            float band = smoothstep(0.48, 0.79, cn) * smoothstep(-0.01, 0.20, dir.y) * (1.0 - smoothstep(0.55, 0.95, h));
            col = mix(col, uCloud, band * uCloudAmount * 0.75);
            // slight horizon haze
            col = mix(col, uHorizon, pow(max(0.0, 1.0 - h), 22.0) * 0.22);
            gl_FragColor = vec4(col, 1.0);
          }`,
      })
    );
    this.sky.frustumCulled = false;
    scene.add(this.sky);
    this.scene.fog = new THREE.Fog(0xd9c6a6, 120, 820);

    /* water */
    const waterTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 256;
      const g = c.getContext('2d'); const im = g.createImageData(256, 256);
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const v = 128 + Math.sin(x * 0.19 + Math.sin(y * 0.07) * 3.2) * 26 + Math.sin(y * 0.31 + x * 0.04) * 14 + (Math.random() - 0.5) * 16;
        im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255;
      }
      g.putImageData(im, 0, 0);
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(9, 9); return t;
    })();
    this.waterMat = new THREE.MeshPhysicalMaterial({
      color: 0x3f6470, roughness: 0.16, metalness: 0.42, clearcoat: 1, clearcoatRoughness: 0.08,
      bumpMap: waterTex, bumpScale: 0.12, envMapIntensity: 0.9, transparent: true, opacity: 0.94,
    });
    this.water = new THREE.Mesh(new THREE.CircleGeometry(2600, 64), this.waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = -1.6;
    this.water.receiveShadow = false;
    scene.add(this.water);

    this.buildMaterials();
    this.buildRanges();
    this.setTime('golden', true);
  }

  /* ── materials & shared foliage geo ────────────────────────── */
  buildMaterials() {
    this.terrainMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.97, metalness: 0.0, vertexColors: true, envMapIntensity: 0.32,
      dithering: true,
    });
    const grass = TEX.grass, rock = TEX.rock, sand = TEX.sand, gravel = TEX.gravel;
    this.terrainMat.onBeforeCompile = (shader) => {
      shader.uniforms.uGrass = { value: grass };
      shader.uniforms.uRock = { value: rock };
      shader.uniforms.uSand = { value: sand };
      shader.uniforms.uGravel = { value: gravel };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          #else
            vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif
          vWNrm = normalize(mat3(modelMatrix) * objectNormal);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWPos; varying vec3 vWNrm;
          uniform sampler2D uGrass,uRock,uSand,uGravel;
          float eh(vec2 p){ p = fract(p*vec2(127.1,311.7)); p += dot(p,p+34.5); return fract(p.x*p.y); }
          float en(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
            return mix(mix(eh(i),eh(i+vec2(1,0)),f.x),mix(eh(i+vec2(0,1)),eh(i+vec2(1,1)),f.x),f.y); }
          float efbm(vec2 p){ float v=0.0,a=0.55; for(int i=0;i<4;i++){ v+=a*en(p); p=p*2.07+vec2(3.7,9.1); a*=0.5; } return v; }`)
        .replace('#include <map_fragment>', `
          vec3 wn = normalize(vWNrm);
          float slope = 1.0 - clamp(wn.y, 0.0, 1.0);
          float macro = efbm(vWPos.xz * 0.012);
          float micro = efbm(vWPos.xz * 0.09);
          vec3 grassC = mix(texture2D(uGrass, vWPos.xz * 0.3).rgb, texture2D(uGrass, vWPos.xz * 0.047 + 0.37).rgb, 0.45);
          vec3 rockC  = mix(texture2D(uRock,  vWPos.xz * 0.16 + 0.11).rgb, texture2D(uRock, vWPos.xz * 0.035 + 0.61).rgb, 0.5);
          vec3 sandC  = mix(texture2D(uSand,  vWPos.xz * 0.22 + 0.23).rgb, texture2D(uSand, vWPos.xz * 0.06 + 0.83).rgb, 0.55);
          vec3 gravC  = texture2D(uGravel, vWPos.xz * 0.3 + 0.47).rgb;
          float rockW = smoothstep(0.30, 0.62, slope + (macro - 0.5) * 0.22);
          float shore = smoothstep(2.1, -0.6, vWPos.y + (macro - 0.5) * 1.8);
          float sandW = shore * smoothstep(0.22, 0.5, macro + 0.1);
          vec3 ground = mix(grassC, rockC, rockW);
          ground = mix(ground, sandC, sandW * 0.9);
          ground = mix(ground, gravC, smoothstep(0.15, 0.4, micro) * 0.05);
          ground *= 0.94 + macro * 0.2;
          ground = mix(ground, ground * vec3(1.04, 1.0, 0.9), 0.4);
          diffuseColor.rgb *= ground;
        `);
      this.terrainShader = shader;
    };
    this.terrainMat.customProgramCacheKey = () => 'ev-terrain-v2';

    this.asphaltMat = new THREE.MeshStandardMaterial({
      map: tiled(TEX.asphalt, 2, 1), color: 0xb9b9b6, roughness: 0.87, metalness: 0.02,
      bumpMap: tiled(TEX.asphalt, 2, 1), bumpScale: 0.012, envMapIntensity: 0.3,
    });
    if (this.asphaltMat.bumpMap) this.asphaltMat.bumpMap.colorSpace = THREE.NoColorSpace;

    this.gravelMat = new THREE.MeshStandardMaterial({ map: tiled(TEX.gravel, 2, 1), roughness: 1, color: 0xa9a294 });
    this.lineMat = new THREE.MeshStandardMaterial({ color: 0xd9d9d2, roughness: 0.72, metalness: 0.0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.railMat = new THREE.MeshStandardMaterial({ color: 0xa8adb0, roughness: 0.42, metalness: 0.88, side: THREE.DoubleSide });
    this.postMat = new THREE.MeshStandardMaterial({ color: 0x8b8f91, roughness: 0.55, metalness: 0.6 });
    this.reflectorMat = new THREE.MeshStandardMaterial({ color: 0xd9d5c2, roughness: 0.4, emissive: 0x3a2a12, emissiveIntensity: 0.3 });
    this.signMatBase = new THREE.MeshStandardMaterial({ color: 0x6a726b, roughness: 0.8, metalness: 0.2 });

    const foliage = (map, alphaTest = 0.42) => {
      const m = new THREE.MeshStandardMaterial({
        map, alphaTest, side: THREE.DoubleSide, roughness: 0.9, metalness: 0.0,
        envMapIntensity: 0.5, color: 0xd7dcc6, transparent: false,
      });
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = WIND.uTime;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            #ifdef USE_INSTANCING
              vec4 ew = modelMatrix * instanceMatrix * vec4(0.0,0.0,0.0,1.0);
              float sway = sin(uTime * 1.15 + ew.x * 0.32 + ew.z * 0.24) * 0.045;
              float sway2 = sin(uTime * 2.1 + ew.z * 0.6) * 0.018;
              transformed.x += (sway + sway2) * uv.y * uv.y;
              transformed.z += sway * 0.6 * uv.y * uv.y;
            #endif`);
      };
      m.customProgramCacheKey = () => 'ev-foliage-v2';
      return m;
    };
    this.pineMat = foliage(TEX.pine);
    this.oakMat = foliage(TEX.oak);
    this.birchMat = foliage(TEX.birch);
    this.shrubMat = foliage(TEX.shrub);
    this.tuftMat = foliage(TEX.tuft, 0.35);

    const crossed = (aspect) => {
      const a = new THREE.PlaneGeometry(aspect, 1, 1, 1); a.translate(0, 0.5, 0);
      const b = a.clone(); b.rotateY(Math.PI / 2);
      const c = a.clone(); c.rotateY(Math.PI / 4);
      const d = a.clone(); d.rotateY(-Math.PI / 4);
      const g = mergeGeometries([a, b, c, d], false);
      a.dispose(); b.dispose(); c.dispose(); d.dispose();
      return g;
    };
    this.plantGeo = {
      pine: crossed(516 / 760), oak: crossed(889 / 680), birch: crossed(337 / 680),
      shrub: crossed(1294 / 680), tuft: crossed(1228 / 680),
    };
    this.rockMat = new THREE.MeshStandardMaterial({ map: tiled(TEX.rock, 1.4, 1.4), roughness: 0.94, color: 0xb0aa9c, flatShading: true });
    this.rockGeo = new THREE.DodecahedronGeometry(1, 1);
    this.shadowWd = 0;
  }

  /* ── distant ranges (two silhouette layers) ─────────────────── */
  buildRanges() {
    const make = (inner, outer, seg, radial, peak, baseY, snow) => {
      const pos = [], col = [], idx = [];
      const c = new THREE.Color(), rock = new THREE.Color(0x5b636a), grass = new THREE.Color(0x4f5b45), snowC = new THREE.Color(0xe9ecec);
      for (let i = 0; i <= radial; i++) {
        const t = i / radial;
        const r = lerp(inner, outer, t);
        const prof = Math.sin(Math.PI * Math.pow(t, 0.72));
        for (let j = 0; j <= seg; j++) {
          const a = (j / seg) * TAU;
          const cx = Math.cos(a), cz = Math.sin(a);
          const n = fbm(cx * 2.1 + i * 0.15, cz * 2.1 - i * 0.1, 4);
          const n2v = fbm(cx * 6.2 - 3.3, cz * 6.2 + 5.1, 3);
          const y = baseY + (n * 0.8 + n2v * 0.45) * peak * prof;
          pos.push(cx * r, y, cz * r);
          const sh = clamp(y / (baseY + peak), 0, 1);
          c.copy(grass).lerp(rock, smoothstep(0.28, 0.6, sh + n2v * 0.2));
          if (snow) c.lerp(snowC, smoothstep(0.66, 0.9, sh + n2v * 0.14));
          col.push(c.r, c.g, c.b);
        }
      }
      for (let i = 0; i < radial; i++) for (let j = 0; j < seg; j++) {
        const a = i * (seg + 1) + j, b = a + 1, c2 = a + seg + 1, d = c2 + 1;
        idx.push(a, c2, b, b, c2, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 1, metalness: 0, fog: true, side: THREE.DoubleSide, flatShading: false,
      }));
      m.frustumCulled = false;
      return m;
    };
    this.midRidge = make(430, 1150, 210, 12, 170, -14, false);
    this.farRidge = make(1000, 2700, 160, 10, 320, -30, true);
    this.scene.add(this.midRidge, this.farRidge);
  }

  /* ── time of day ───────────────────────────────────────────── */
  setTime(name, instant = false) {
    const p = TIMES[name] || TIMES.golden;
    this.time = name;
    this.palette = p;
    if (instant) {
      this.cur = {
        skyTop: new THREE.Color(p.skyTop), skyMid: new THREE.Color(p.skyMid), horizon: new THREE.Color(p.skyHorizon),
        sun: new THREE.Color(p.sun), hemiSky: new THREE.Color(p.hemiSky), hemiGround: new THREE.Color(p.hemiGround),
        fog: new THREE.Color(p.fog), water: new THREE.Color(p.water), cloud: new THREE.Color(p.cloud),
        sunIntensity: p.sunIntensity, hemiIntensity: p.hemiIntensity, fogNear: p.fogNear, fogFar: p.fogFar,
        exposure: p.exposure, cloudAmount: p.cloudOpacity,
        sunDir: new THREE.Vector3(...p.sunDir).normalize(),
      };
      this.applyPalette();
    }
  }

  applyPalette() {
    const c = this.cur;
    this.skyUniforms.uTop.value.copy(c.skyTop);
    this.skyUniforms.uMid.value.copy(c.skyMid);
    this.skyUniforms.uHorizon.value.copy(c.horizon);
    this.skyUniforms.uSunColor.value.copy(c.sun);
    this.skyUniforms.uCloud.value.copy(c.cloud);
    this.skyUniforms.uCloudAmount.value = c.cloudAmount;
    this.skyUniforms.uSunDir.value.copy(c.sunDir);
    this.sun.color.copy(c.sun);
    this.sun.intensity = c.sunIntensity;
    this.hemi.color.copy(c.hemiSky);
    this.hemi.groundColor.copy(c.hemiGround);
    this.hemi.intensity = c.hemiIntensity;
    this.fill.intensity = 0.28 + c.hemiIntensity * 0.22;
    this.fill.color.copy(c.hemiSky);
    this.scene.fog.color.copy(c.fog);
    this.scene.fog.near = c.fogNear;
    this.scene.fog.far = c.fogFar;
    this.waterMat.color.copy(c.water);
    this.renderer.toneMappingExposure = c.exposure;
  }

  /* ── road geometry ─────────────────────────────────────────── */
  ribbonGeom(s0, s1, offA, offB, liftA = 0, liftB = 0, uvScale = 8, step = 4) {
    const n = Math.max(2, Math.ceil((s1 - s0) / step));
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const s = lerp(s0, s1, i / n);
      const d = roadD(s), nn = Math.sqrt(1 + d * d);
      for (const [off, lift, u] of [[offA, liftA, 0], [offB, liftB, 1]]) {
        pos.push(roadX(s) + off / nn, roadY(s) + lift, -s + (off * d) / nn);
        uv.push(u, s / uvScale);
      }
    }
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  makeRoadChunk(index) {
    const s0 = index * TILE, s1 = s0 + TILE;
    const g = new THREE.Group();
    g.userData.s0 = s0;

    const asphalt = new THREE.Mesh(this.ribbonGeom(s0, s1, -ROAD_HALF, ROAD_HALF, 0, 0, 9, 3), this.asphaltMat);
    asphalt.receiveShadow = true;
    g.add(asphalt);

    const shoulderL = new THREE.Mesh(this.ribbonGeom(s0, s1, -SHOULDER, -ROAD_HALF + 0.02, -0.09, 0.001, 7, 4), this.gravelMat);
    const shoulderR = new THREE.Mesh(this.ribbonGeom(s0, s1, ROAD_HALF - 0.02, SHOULDER, 0.001, -0.09, 7, 4), this.gravelMat);
    shoulderL.receiveShadow = shoulderR.receiveShadow = true;
    g.add(shoulderL, shoulderR);

    /* painted lines — merged per chunk */
    const lineGeos = [];
    const addLine = (sA, sB, off, w) => {
      const d = roadD((sA + sB) / 2), nn = Math.sqrt(1 + d * d);
      const geo = this.ribbonGeom(sA, sB, off - w / 2, off + w / 2, 0.014, 0.014, 8, Math.max(1, (sB - sA) / 2));
      lineGeos.push(geo);
    };
    for (const off of [-LANE, LANE]) addLine(s0, s1, off, 0.13);
    for (let s = Math.ceil(s0 / 10) * 10; s < s1; s += 10) addLine(s, Math.min(s + 4.2, s1), 0, 0.1);
    if (lineGeos.length) {
      const merged = mergeGeometries(lineGeos, false);
      lineGeos.forEach((x) => x.dispose());
      const lines = new THREE.Mesh(merged, this.lineMat);
      lines.receiveShadow = true;
      g.add(lines);
    }

    /* delineator posts */
    const postGeos = [], refGeos = [];
    const rnd = rng(index * 7919 + 13);
    for (let s = s0 + 8; s < s1; s += 32) {
      for (const side of [-1, 1]) {
        const p = roadPoint(s, side * (SHOULDER + 0.55), 0);
        const post = new THREE.BoxGeometry(0.1, 0.95, 0.1);
        post.translate(p.x, surfaceHeight(p.x, p.z) + 0.42, p.z);
        postGeos.push(post);
        const ref = new THREE.BoxGeometry(0.11, 0.1, 0.02);
        ref.translate(p.x, surfaceHeight(p.x, p.z) + 0.72, p.z + 0.06 * side);
        refGeos.push(ref);
      }
    }
    if (postGeos.length) {
      const posts = new THREE.Mesh(mergeGeometries(postGeos, false), this.postMat);
      posts.castShadow = true;
      postGeos.forEach((x) => x.dispose());
      g.add(posts);
      const refs = new THREE.Mesh(mergeGeometries(refGeos, false), this.reflectorMat);
      refGeos.forEach((x) => x.dispose());
      g.add(refs);
    }

    /* guardrail on some stretches — helps sell the mountain road */
    if (index % 3 === 0 || index % 7 === 0) {
      const side = index % 2 === 0 ? 1 : -1;
      const railPos = [], railIdx = [], railUv = [];
      let vi = 0;
      const railOffset = side * (SHOULDER + 1.3);
      const n = 40;
      for (let i = 0; i <= n; i++) {
        const s = lerp(s0 + 4, s1 - 4, i / n);
        const d = roadD(s), nn = Math.sqrt(1 + d * d);
        const bx = roadX(s) + railOffset / nn, bz = -s + (railOffset * d) / nn;
        const by = surfaceHeight(bx, bz);
        for (const [y, v] of [[0.46, 0], [0.52, 0.25], [0.78, 0.62], [0.84, 1]]) {
          railPos.push(bx, by + y, bz);
          railUv.push(v, i / n);
        }
      }
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) {
          const a = i * 4 + k, b = a + 1, c = a + 4, d2 = c + 1;
          railIdx.push(a, b, c, b, d2, c);
        }
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(railPos, 3));
      rg.setAttribute('uv', new THREE.Float32BufferAttribute(railUv, 2));
      rg.setIndex(railIdx);
      rg.computeVertexNormals();
      const rail = new THREE.Mesh(rg, this.railMat);
      rail.castShadow = true;
      g.add(rail);
      const postGeos2 = [];
      for (let i = 0; i <= n; i += 2) {
        const s = lerp(s0 + 4, s1 - 4, i / n);
        const d = roadD(s), nn = Math.sqrt(1 + d * d);
        const bx = roadX(s) + railOffset / nn, bz = -s + (railOffset * d) / nn;
        const by = surfaceHeight(bx, bz);
        const pg = new THREE.BoxGeometry(0.12, 0.9, 0.12);
        pg.translate(bx, by + 0.42, bz);
        postGeos2.push(pg);
      }
      const gp = new THREE.Mesh(mergeGeometries(postGeos2, false), this.postMat);
      gp.castShadow = true;
      postGeos2.forEach((x) => x.dispose());
      g.add(gp);
    }

    /* occasional roadside sign */
    if (((index % 6) + 6) % 6 === 2 && rnd() > 0.25) {
      const s = s0 + 16;
      const side = 1;
      const p = roadPoint(s, side * 8.6, 0);
      const by = surfaceHeight(p.x, p.z);
      const sign = new THREE.Group();
      const poleGeo = new THREE.CylinderGeometry(0.045, 0.045, 2.4, 8);
      poleGeo.translate(p.x, by + 1.2, p.z);
      const pole = new THREE.Mesh(poleGeo, this.postMat);
      const tex = this.signTexture(index);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 0.05), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.65, metalness: 0.15 }));
      panel.position.set(p.x, by + 2.15, p.z);
      panel.rotation.y = roadYaw(s) + Math.PI;
      panel.castShadow = true;
      sign.add(pole, panel);
      g.add(sign);
    }
    return g;
  }

  signTexture(seed) {
    if (!this._signCache) this._signCache = new Map();
    const key = seed % 5;
    if (this._signCache.has(key)) return this._signCache.get(key);
    const c = document.createElement('canvas'); c.width = 512; c.height = 308;
    const g = c.getContext('2d');
    const names = ['PINE VALLEY', 'VALLE VERDE', 'ALTA RIDGE', 'LAGO NORD', 'PASSO 7'];
    const dists = ['12 km', '28 km', '41 km', '66 km', '94 km'];
    g.fillStyle = '#2a4436'; g.fillRect(0, 0, 512, 308);
    g.strokeStyle = '#e7ebdf'; g.lineWidth = 9; g.strokeRect(16, 16, 480, 276);
    g.fillStyle = '#f0f2e6'; g.textAlign = 'center';
    g.font = '600 54px system-ui,sans-serif';
    g.fillText(names[key], 256, 132);
    g.font = '34px system-ui,sans-serif';
    g.fillStyle = '#c9d1bd';
    g.fillText(dists[key], 256, 196);
    g.font = '500 22px system-ui,sans-serif';
    g.fillStyle = '#9ca992';
    g.fillText('ALT. 1240 m', 256, 250);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this._signCache.set(key, t);
    return t;
  }

  /* ── terrain chunks ────────────────────────────────────────── */
  makeTerrainChunk(cx, cz) {
    const res = this.quality.terrainRes;
    const size = TILE;
    const ox = cx * size, oz = cz * size;
    const pos = [], col = [], uv = [], idx = [];
    const c = new THREE.Color();
    for (let z = 0; z <= res; z++) {
      for (let x = 0; x <= res; x++) {
        const wx = ox + (x / res) * size;
        const wz = oz + (z / res) * size;
        const y = groundHeight(wx, wz);
        pos.push(wx, y, wz);
        const n = fbm(wx * 0.02 + 3, wz * 0.02 - 1, 3);
        const dry = fbm(wx * 0.0055 - 5, wz * 0.0055 + 2, 2);
        c.setRGB(0.6 + n * 0.18, 0.64 + n * 0.15, 0.5 + n * 0.1);
        // broad dry-meadow patches and darker shaded hollows
        c.lerp(new THREE.Color(0xb7a57a), smoothstep(0.48, 0.78, dry) * 0.5);
        c.lerp(new THREE.Color(0x39412f), smoothstep(0.62, 0.2, dry) * 0.16);
        col.push(c.r, c.g, c.b);
        uv.push(x / res, z / res);
      }
    }
    for (let z = 0; z < res; z++) for (let x = 0; x < res; x++) {
      const a = z * (res + 1) + x, b = a + 1, c2 = a + res + 1, d = c2 + 1;
      idx.push(a, c2, b, b, c2, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const terrain = new THREE.Mesh(geo, this.terrainMat);
    terrain.receiveShadow = true;
    terrain.castShadow = false;

    const group = new THREE.Group();
    group.add(terrain);
    this.scatterVegetation(group, cx, cz, ox, oz);
    group.userData.terrainGeo = geo;
    return group;
  }

  scatterVegetation(group, cx, cz, ox, oz) {
    const rnd = rng((Math.imul(cx, 73856093) ^ Math.imul(cz, 19349663) ^ 0x45d9f3b) | 0);
    const density = this.quality.foliage;
    const buckets = { pine: [], oak: [], birch: [], shrub: [], tuft: [], rock: [] };
    const nPine = Math.round(58 * density), nOak = Math.round(16 * density), nBirch = Math.round(20 * density);
    const nShrub = Math.round(80 * density), nTuft = Math.round(150 * density), nRock = Math.round(10 * density);

    const place = (arr, n, minOff, maxOff, minH, maxH, minSlope, scaleMul = 1) => {
      let tries = 0;
      while (arr.length < n && tries < n * 14) {
        tries++;
        const x = ox + rnd() * TILE, z = oz + rnd() * TILE;
        const s = -z;
        const d = (x - roadX(s)) * Math.sqrt(1 + roadD(s) ** 2);
        const off = Math.abs(d);
        if (off < minOff || off > maxOff) continue;
        const y = groundHeight(x, z);
        if (y < 0.2) continue;
        const slope = Math.abs(groundHeight(x + 2, z) - y) + Math.abs(groundHeight(x, z + 2) - y);
        if (slope > minSlope) continue;
        // keep the verges readable
        if (off < 11 && rnd() > 0.15) continue;
        const h = lerp(minH, maxH, rnd()) * scaleMul;
        arr.push({ x, y, z, h, a: rnd() * TAU, tilt: (rnd() - 0.5) * 0.05, tint: 0.86 + rnd() * 0.28 });
      }
    };
    place(buckets.pine, nPine, 11, 260, 7, 16, 9);
    place(buckets.oak, nOak, 12, 240, 5, 10, 5.5);
    place(buckets.birch, nBirch, 13, 220, 6, 12, 5.5);
    place(buckets.shrub, nShrub, 9.5, 180, 1.2, 2.6, 7);
    place(buckets.tuft, nTuft, 7.4, 70, 0.55, 1.25, 8);
    place(buckets.rock, nRock, 8.5, 230, 0.5, 2.1, 14);

    const inst = (geo, mat, list, isTree, squash = 1) => {
      if (!list.length) return;
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      const dummy = new THREE.Object3D();
      list.forEach((t, i) => {
        dummy.position.set(t.x, t.y - 0.06, t.z);
        dummy.rotation.set(t.tilt, t.a, 0);
        dummy.scale.set(t.h, t.h * squash, t.h);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, new THREE.Color(t.tint * 0.98, t.tint, t.tint * 0.92));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = isTree && this.sun.castShadow;
      mesh.receiveShadow = false;
      mesh.frustumCulled = true;
      group.add(mesh);
    };
    inst(this.plantGeo.pine, this.pineMat, buckets.pine, true);
    inst(this.plantGeo.oak, this.oakMat, buckets.oak, true);
    inst(this.plantGeo.birch, this.birchMat, buckets.birch, true);
    inst(this.plantGeo.shrub, this.shrubMat, buckets.shrub, false, 0.92);
    inst(this.plantGeo.tuft, this.tuftMat, buckets.tuft, false, 1);

    if (buckets.rock.length) {
      const mesh = new THREE.InstancedMesh(this.rockGeo, this.rockMat, buckets.rock.length);
      const dummy = new THREE.Object3D();
      buckets.rock.forEach((r, i) => {
        dummy.position.set(r.x, r.y + r.h * 0.18, r.z);
        dummy.rotation.set(rnd() * 0.4, r.a, rnd() * 0.4);
        dummy.scale.set(r.h * 1.3, r.h * 0.7, r.h);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.castShadow = this.sun.castShadow;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  /* ── streaming ─────────────────────────────────────────────── */
  update(dt, car, camera, elapsed) {
    WIND.uTime.value = elapsed;
    const radius = this.quality.radius;
    const cx = Math.floor(car.x / TILE), cz = Math.floor(car.z / TILE);
    const key = `${cx},${cz},${radius}`;

    if (key !== this.lastKey) {
      this.lastKey = key;
      for (const [k, t] of this.terrain) {
        if (Math.abs(t.userData.cx - cx) > radius + 1 || Math.abs(t.userData.cz - cz) > radius + 1) {
          this.root.remove(t);
          t.userData.terrainGeo?.dispose();
          t.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
          this.terrain.delete(k);
        }
      }
      /* only keep terrain jobs for chunks that are still in range, and
         never queue the same chunk twice — driving fast used to leave a
         permanent backlog behind the car */
      this.pending = this.pending.filter((p) => p.kind !== 'terrain'
        || (Math.abs(p.x - cx) <= radius && Math.abs(p.z - cz) <= radius && !this.terrain.has(p.key)));
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const tx = cx + dx, tz = cz + dz;
          const k = `${tx},${tz}`;
          if (!this.terrain.has(k) && !this.pending.some((p) => p.kind === 'terrain' && p.key === k)) {
            this.pending.push({ kind: 'terrain', x: tx, z: tz, key: k });
          }
        }
      }
    }

    /* roads follow distance travelled more than tile coords */
    const s = -car.z;
    const roadRadius = this.quality.radius + 2;
    const ri = Math.floor(s / TILE);
    for (const [k, r] of this.roads) {
      if (Math.abs(k - ri) > roadRadius + 2) {
        this.root.remove(r);
        r.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
        this.roads.delete(k);
      }
    }
    /* A road chunk that fell out of the window was still sitting in the
       queue (or already built) would be re-requested every frame, so the
       backlog grew forever on a long drive. Keep the queue to chunks that
       are still wanted, and never queue a chunk twice. */
    const lo = ri - Math.floor(roadRadius * 0.75), hi = ri + roadRadius;
    const wanted = new Set();
    for (let i = lo; i <= hi; i++) wanted.add(i);
    this.pending = this.pending.filter((p) => (p.kind !== 'road' ? true : wanted.has(p.index) && !this.roads.has(p.index)));
    for (let i = lo; i <= hi; i++) {
      if (!this.roads.has(i) && !this.pending.some((p) => p.kind === 'road' && p.index === i)) {
        this.pending.push({ kind: 'road', index: i, key: `r${i}` });
      }
    }

    if (this.pending.length > 1) {
      this.pending.sort((a, b) => {
        if (a.kind === 'road' && b.kind !== 'road') return -1;
        if (b.kind === 'road' && a.kind !== 'road') return 1;
        if (a.kind === 'terrain' && b.kind === 'terrain') {
          return (Math.abs(a.x - cx) + Math.abs(a.z - cz)) - (Math.abs(b.x - cx) + Math.abs(b.z - cz));
        }
        return 0;
      });
    }

    /* keep chunk building bounded per frame */
    const budget = this._firstPass ? 4 : 1;
    let made = 0;
    while (this.pending.length && made < budget) {
      const job = this.pending.shift();
      if (job.kind === 'terrain') {
        if (this.terrain.has(job.key)) continue;
        const g = this.makeTerrainChunk(job.x, job.z);
        g.userData.cx = job.x; g.userData.cz = job.z;
        this.terrain.set(job.key, g);
        this.root.add(g);
      } else {
        if (this.roads.has(job.index)) continue;
        const g = this.makeRoadChunk(job.index);
        this.roads.set(job.index, g);
        this.root.add(g);
      }
      made++;
    }
    if (this.pending.length === 0) this._firstPass = false;

    /* sun follows the car so shadows stay crisp */
    const sy = this.cur.sunDir;
    this.sun.position.set(car.x + sy.x * 120, car.y + sy.y * 120 + 12, car.z + sy.z * 120);
    this.sun.target.position.set(car.x, car.y, car.z);
    this.sun.target.updateMatrixWorld();

    this.sky.position.copy(camera.position);
    this.water.position.x = car.x;
    this.water.position.z = car.z;
    this.midRidge.position.set(car.x, 0, car.z);
    this.farRidge.position.set(car.x, 0, car.z);

    const uTime = WIND.uTime.value;
    this.waterMat.bumpMap.offset.set(uTime * 0.006, uTime * 0.004);
  }

  /* smooth day/time cross-fade */
  tickTime(dt) {
    if (!this.cur || !this.palette) return;
    const p = this.palette;
    const c = this.cur;
    const k = 2.2;
    c.skyTop.lerp(new THREE.Color(p.skyTop), 1 - Math.exp(-k * dt));
    c.skyMid.lerp(new THREE.Color(p.skyMid), 1 - Math.exp(-k * dt));
    c.horizon.lerp(new THREE.Color(p.skyHorizon), 1 - Math.exp(-k * dt));
    c.sun.lerp(new THREE.Color(p.sun), 1 - Math.exp(-k * dt));
    c.hemiSky.lerp(new THREE.Color(p.hemiSky), 1 - Math.exp(-k * dt));
    c.hemiGround.lerp(new THREE.Color(p.hemiGround), 1 - Math.exp(-k * dt));
    c.fog.lerp(new THREE.Color(p.fog), 1 - Math.exp(-k * dt));
    c.water.lerp(new THREE.Color(p.water), 1 - Math.exp(-k * dt));
    c.cloud.lerp(new THREE.Color(p.cloud), 1 - Math.exp(-k * dt));
    c.sunDir.lerp(new THREE.Vector3(...p.sunDir).normalize(), 1 - Math.exp(-k * dt)).normalize();
    const f = 1 - Math.exp(-k * dt);
    c.sunIntensity = lerp(c.sunIntensity, p.sunIntensity, f);
    c.hemiIntensity = lerp(c.hemiIntensity, p.hemiIntensity, f);
    c.fogNear = lerp(c.fogNear, p.fogNear, f);
    c.fogFar = lerp(c.fogFar, p.fogFar, f);
    c.exposure = lerp(c.exposure, p.exposure, f);
    c.cloudAmount = lerp(c.cloudAmount, p.cloudOpacity, f);
    this.applyPalette();
  }

  setQuality(q) {
    this.quality = QUALITY[q] || QUALITY.high;
    Object.assign(this.sun.shadow.camera, {
      left: -62, right: 62, top: 62, bottom: -62,
    });
  }
}
