# Evanton Drive

An endless, empty mountain pass at golden hour, six Ferraris, and no score, no
timers, no traffic. A quiet driving simulator built with Three.js: streamed alpine
terrain, real vehicle physics, a glass interface, and a photo mode for stopping
and looking back.

Everything ships locally — Three.js, the loaders, the Draco decoder and the car
model are vendored in this repository, so the only network request is to your own
static server.

## Run it

ES modules and the glTF/Draco assets need to be served over HTTP (opening the file
directly will not work):

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

No CDN, no build step, no dependencies to install.

## The stable

| Car | Year | Output | 0–100 | Top speed | Drive | Kerb |
| --- | --- | --- | --- | --- | --- | --- |
| **458 Spider** | 2011 | 562 hp @ 9,000 rpm | 3.5 s | 320 km/h | RWD | 1,380 kg |
| F8 Tributo | 2019 | 710 hp @ 8,000 rpm | 2.9 s | 340 km/h | RWD | 1,435 kg |
| SF90 Stradale | 2019 | 986 hp @ 8,000 rpm | 2.5 s | 340 km/h | AWD | 1,570 kg |
| LaFerrari | 2013 | 949 hp @ 9,250 rpm | 2.6 s | 350 km/h | RWD | 1,585 kg |
| Roma | 2019 | 612 hp @ 7,500 rpm | 3.4 s | 320 km/h | RWD | 1,574 kg |
| 296 GTB | 2021 | 819 hp @ 8,500 rpm | 2.9 s | 330 km/h | RWD | 1,470 kg |

The 458 Spider is a **real, professionally modelled glTF asset** (see credits),
loaded with `GLTFLoader` + `DRACOLoader` and re-lit for this scene: clearcoated
paint (all eight paint chips recolour it), physical glass, chrome, carbon, lit
taillights and headlights. Its own wheel nodes are re-parented under steering
pivots, with brake calipers pulled out of the spin group, so it steers, rolls and
brakes correctly.

The other five are procedurally built bodies — lofted surfaces shaped from each
car's real length, width, wheelbase, cabin and deck proportions, with named wheel
groups, lights, exhausts and aero details. Every one of them has its own engine
curve, gear set, final drive, redline, mass, drag, downforce, grip, brake,
steering lock and spring/damper tune; the HUD reads the real simulated rpm and
gear, and the engine audio is synthesised from the same numbers.

Wheels rotate from actual road speed, front wheels steer with the simulated
steering angle, the body pitches under braking and rolls in corners — a damped
spring settling onto the terrain, never an arcade bounce.

## Controls

| | |
| --- | --- |
| `W` `A` `S` `D` / arrows | drive |
| `Space` | handbrake |
| `C` | camera (chase / hood / wide) |
| `U` | driver assist (self-driving) |
| `R` | recover to the road |
| `P` | photo mode |
| `Tab` | map |
| `G` | garage |
| `M` | sound |
| `F` | fullscreen |
| `Esc` | pause |

Touch controls appear automatically on coarse-pointer devices.

Photo mode freezes the world and gives you an orbit camera: drag to orbit, scroll
or pinch to zoom, `P` / `Esc` (or the on-screen buttons) to exit, and **Capture**
to save a PNG.

## Interface

Layered glass rather than glassmorphism: real backdrop blur and saturation over
the scene, thin specular edges, and irregular clip-path "side pods" — the journey
computer on the left, the speed cluster on the right. No title in the corner. The
garage is a full sheet with the stable list, paint chips and per-car telemetry;
the pause and settings sheets share the same material.

Everything animates on physics-eased springs: pod entrances, sheets, the needle,
gear arrows, the boot bar, hover states and the intro.

## How it works

- **Streaming world** — terrain, road ribbon, guardrails, signs, ridges and
  vegetation are generated in chunks around the car and pooled; a floating origin
  keeps float precision stable on very long drives. The road is a curve-driven
  ribbon so steering, surface detection and minimap all agree.
- **Terrain shader** — four AI-generated ground textures (grass, asphalt, gravel,
  rock) blended by slope and noise, with distance detail fade and per-chunk UV
  offsets to hide tiling.
- **Vegetation** — instanced billboards for pine, oak, birch, shrub and tufts,
  with wind sway in the vertex shader and distance-based density by quality tier.
- **Physics** — 120 Hz fixed step, bicycle-model lateral dynamics with slip
  angles, load-sensitive tyre grip, aero drag and downforce, per-surface grip and
  rolling resistance, an automatic gearbox with rev-matched shifts and a rev
  limiter.
- **Audio** — per-engine oscillator stack (cylinder count and firing character
  differ by car), gear whine, wind and gravel noise, all driven by simulated rpm
  and speed.
- **Quality** — three tiers plus an adaptive pixel-ratio fallback if the frame
  rate drops below 42 fps for a sustained period. Tested at 1× DPR.
- **Diagnostics** — `window.evanton.status` returns a read-only snapshot
  (`mode`, `car`, `speed`, `gear`, `surface`, `distance`, `drawCalls`,
  `triangles`, `chunks`, `fps`).

## Layout

```
index.html            shell, SVG icon sprite, HUD, intro, sheets, photo UI
css/app.css           glass design system, pods, sheets, responsive rules
js/config.js          paint palette, times of day, the six cars and their specs
js/assets.js          texture / sprite loading and procedural fallbacks
js/world.js           sky, lighting, terrain, road, vegetation, streaming
js/physics.js         vehicle model, gearbox, tyres, surfaces, telemetry
js/audio.js           engine / wind / surface synthesis
js/ui.js              HUD, sheets, garage, map, photo controls, toasts
js/modelCar.js        glTF hero car: load, orient, scale, materials, wheels
js/cars.js            procedural car builder for the other five
js/main.js            boot, scene, camera modes, input, loop, photo capture
vendor/               three.js 0.170.0, GLTFLoader, DRACOLoader, Draco codec
assets/               AI-generated ground textures and plant sprites
assets/models/        458 Spider glTF
```

## Credits

- **Ferrari 458 Spider model** — `ferrari.glb` from the
  [three.js examples](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf),
  by **vicent091036**, licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Modified here:
  re-oriented and scaled to the 458 Spider's real dimensions, materials replaced
  with physically based paint/glass/rubber/metal, wheel groups re-parented, and
  headlight beams added.
- **Three.js** r170 — MIT licence. `GLTFLoader`, `DRACOLoader` and the Draco
  decoder are included from the same release; Draco is Apache 2.0.
- **Ground textures and plant sprites** — generated for this project with an AI
  image model, then cropped, keyed and downscaled.
- Ferrari, 458, F8, SF90, LaFerrari, Roma and 296 are trademarks of Ferrari S.p.A.
  This is a non-commercial fan project, not affiliated with Ferrari.

## Licence

Project code: MIT. The 458 model remains CC BY 4.0 (attribution above); the
vendored Three.js and Draco code keep their own licences.
