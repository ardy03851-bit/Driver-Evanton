import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const maxAniso = 8;

const FILES = [
  ['asphalt', 'assets/asphalt.jpg', { srgb: true, wrap: true }],
  ['grass', 'assets/grass.jpg', { srgb: true, wrap: true }],
  ['gravel', 'assets/gravel.jpg', { srgb: true, wrap: true }],
  ['rock', 'assets/rock.jpg', { srgb: true, wrap: true }],
  ['sand', 'assets/sand.jpg', { srgb: true, wrap: true }],
  ['pine', 'assets/pine.png', { srgb: true, clip: true }],
  ['oak', 'assets/oak.png', { srgb: true, clip: true }],
  ['birch', 'assets/birch.png', { srgb: true, clip: true }],
  ['shrub', 'assets/shrub.png', { srgb: true, clip: true }],
  ['tuft', 'assets/tuft.png', { srgb: true, clip: true }],
];

export const TEX = {
  /* generated substitutes keep the sim playable even if a texture is missing */
  fallback: (kind) => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const base = { grass: '#59683c', asphalt: '#3c3e40', gravel: '#8c8578', rock: '#7a7468', sand: '#c9b995' }[kind] || '#777';
    g.fillStyle = base;
    g.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 500; i++) {
      const v = Math.random() * 40 - 20;
      g.fillStyle = `rgba(${128 + v},${128 + v},${128 + v},.14)`;
      g.fillRect(Math.random() * 64, Math.random() * 64, 1.4, 1.4);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
    return t;
  },
};

export async function loadAssets(onStep) {
  let done = 0;
  const results = {};
  await Promise.all(FILES.map(([key, url, opt]) => new Promise((resolve) => {
    const finish = (tex) => {
      done++;
      onStep?.(done, FILES.length, key);
      resolve();
    };
    loader.load(url,
      (tex) => {
        tex.colorSpace = opt.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.wrapS = tex.wrapT = opt.wrap ? THREE.MirroredRepeatWrapping : THREE.ClampToEdgeWrapping;
        tex.anisotropy = maxAniso;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        results[key] = tex;
        finish(tex);
      },
      undefined,
      () => {
        console.warn('[evanton] missing asset', url);
        results[key] = TEX.fallback(key);
        finish(results[key]);
      });
  })));
  Object.assign(TEX, results);
  return TEX;
}

/* clone a texture with an independent repeat (shares the image) */
export function tiled(tex, x, y, rotation = 0) {
  if (!tex) return null;
  const t = tex.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
  t.repeat.set(x, y);
  t.rotation = rotation;
  t.anisotropy = maxAniso;
  return t;
}
