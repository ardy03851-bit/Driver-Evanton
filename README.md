# Evanton Drive — Realistic Driving Simulator

An endless open-road driving simulator in a single `index.html` (plus AI-generated
texture/sprite assets in `assets/`). No driver model, no collectibles, no laps —
just three very different cars and a procedurally generated landscape of pine
valley, meadows, highland ridges, lakes and mountain ranges.

## Run it

Serve the folder with any static server, e.g.:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

An internet connection is required: Three.js and the car models are streamed
from CDNs at runtime.

## The cars (all real, streamed 3D models, all with animated wheels)

| Car | Source | Character |
| --- | --- | --- |
| Vantara Rally Raid | `drcollect/collect-cars` (GitHub) | Soft long-travel suspension, modest top speed, very grippy on dirt |
| Ferrari 458 Italia | Three.js examples (CC BY 4.0, by vicent091036) | Savage on tarmac, high redline, nervous off-road |
| Aeon Hyper GT | `drcollect/collect-cars` (GitHub) | Fastest and stiffest, huge grip, 10,500 rpm |

Every car has its own engine force curve, top speed, gear set, redline, brake
strength, drag, steering lock/speed fade, wheelbase, ride height and suspension
spring/damper tune. Wheel meshes are detected by name (`Wheel_FL`, `wheel_fr`, …),
re-parented under steering pivots (front) and spin pivots (all four), and the
model's nose direction is auto-detected. Suspension is a damped spring — the
body settles onto the terrain, pitches under braking and rolls in corners; there
is deliberately no arcade bouncing. If every model fails to download, a built-in
offline car body is used so the game is always playable.

## Controls

`W A S D` / arrows drive · `Space` handbrake · `C` camera (chase / hood / wide) ·
`U` driver assist (self-driving) · `R` return to road · `P` photo mode ·
`Tab` map · `G` garage · `M` sound · `F` fullscreen · `Esc` pause.
Touch controls appear on mobile.

## Tech notes

- Chunked infinite terrain + road streaming with a floating origin (no jitter
  on long drives), instanced AI-textured trees/shrubs/rocks, pooled dust and
  skid marks, quality tiers with automatic performance fallback.
- AI-generated assets in `assets/`: grass, asphalt, gravel and rock ground
  textures, plus pine/oak/shrub sprite PNGs (background-keyed and alpha-trimmed).
- Interface is layered glass — backdrop blur/saturate, specular gradients and
  irregular clip-path side pods (trip computer left, speed cluster right), with
  physics-eased transitions throughout.
- Procedural per-car engine audio (oscillator stack driven by the simulated
  RPM/gearbox), wind noise, golden/day/dusk lighting, photo mode and a live
  minimap.
- `window.evanton.status` exposes a small read-only diagnostic snapshot.
