import { clamp, lerp, damp } from './config.js';

/* ═══════════════════════════════════════════════════════════════
   Procedural drivetrain audio — no samples, everything synthesised.
   ═══════════════════════════════════════════════════════════════ */
export class SimAudio {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 0.55;
    this.ready = false;
    this.lastGear = 1;
    this.popCooldown = 0;
    this.smooth = { rpm: 900, load: 0, speed: 0, boost: 0 };
    this.windGain = 0;
  }

  async enable() {
    if (!this.ctx) {
      try { this.build(); } catch (e) { console.warn('[evanton] audio unavailable', e); return false; }
    }
    if (!this.ctx) return false;
    try {
      await this.ctx.resume();
      this.enabled = true;
      this.master.gain.setTargetAtTime(this.volume * 0.9, this.ctx.currentTime, 0.25);
      return true;
    } catch { return false; }
  }

  disable() {
    this.enabled = false;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.18);
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    if (this.ctx && this.enabled) this.master.gain.setTargetAtTime(this.volume * 0.9, this.ctx.currentTime, 0.12);
  }

  noiseBuffer(seconds = 2, brown = false) {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.2; } else d[i] = w;
    }
    return buf;
  }

  build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 20; comp.ratio.value = 5;
    comp.attack.value = 0.008; comp.release.value = 0.25;
    master.connect(comp).connect(ctx.destination);
    this.master = master;

    /* ── engine core ─────────────────────────────────────────── */
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.0;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / curve.length) * 2 - 1;
      curve[i] = Math.tanh(x * 2.2) * 0.82;
    }
    shaper.curve = curve;
    shaper.oversample = '2x';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1600;
    lp.Q.value = 1.1;
    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 190;
    peak.Q.value = 1.6;
    peak.gain.value = 7;
    engineGain.connect(peak).connect(shaper).connect(lp).connect(master);
    this.engineGain = engineGain;
    this.engineLP = lp;

    this.oscs = [];
    const types = ['sawtooth', 'sawtooth', 'square', 'sine'];
    const mults = [1, 2.01, 3.02, 0.5];
    const gains = [0.20, 0.13, 0.06, 0.20];
    mults.forEach((mult, i) => {
      const o = ctx.createOscillator();
      o.type = types[i];
      const g = ctx.createGain();
      g.gain.value = gains[i];
      o.connect(g).connect(engineGain);
      o.start();
      this.oscs.push({ o, mult, g });
    });

    /* exhaust air / rasp */
    const raspSrc = ctx.createBufferSource();
    raspSrc.buffer = this.noiseBuffer(2, true);
    raspSrc.loop = true;
    const raspBP = ctx.createBiquadFilter();
    raspBP.type = 'bandpass'; raspBP.frequency.value = 620; raspBP.Q.value = 0.7;
    const raspGain = ctx.createGain(); raspGain.gain.value = 0;
    raspSrc.connect(raspBP).connect(raspGain).connect(engineGain);
    raspSrc.start();
    this.raspGain = raspGain;
    this.raspBP = raspBP;

    /* turbo whistle */
    const turboOsc = ctx.createOscillator();
    turboOsc.type = 'sine'; turboOsc.frequency.value = 2400;
    const turboGain = ctx.createGain(); turboGain.gain.value = 0;
    turboOsc.connect(turboGain).connect(master);
    turboOsc.start();
    this.turboOsc = turboOsc;
    this.turboGain = turboGain;

    /* road & wind noise */
    const roadSrc = ctx.createBufferSource();
    roadSrc.buffer = this.noiseBuffer(3);
    roadSrc.loop = true;
    const roadFilter = ctx.createBiquadFilter();
    roadFilter.type = 'lowpass'; roadFilter.frequency.value = 420;
    const roadGain = ctx.createGain(); roadGain.gain.value = 0;
    roadSrc.connect(roadFilter).connect(roadGain).connect(master);
    roadSrc.start();
    this.roadGain = roadGain;
    this.roadFilter = roadFilter;

    const windSrc = ctx.createBufferSource();
    windSrc.buffer = this.noiseBuffer(3);
    windSrc.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'bandpass'; windFilter.frequency.value = 900; windFilter.Q.value = 0.4;
    const windGain = ctx.createGain(); windGain.gain.value = 0;
    windSrc.connect(windFilter).connect(windGain).connect(master);
    windSrc.start();
    this.windGainNode = windGain;
    this.windFilter = windFilter;

    this.ready = true;
  }

  voiceFor(car) {
    if (!this.ctx || !this.ready) return;
    const note = car.def.sound.note;
    this.oscs.forEach((o, i) => {
      o.o.type = i === 3 ? (car.spec.electricBoost ? 'sine' : 'triangle') : (i === 2 ? 'square' : 'sawtooth');
      o.g.gain.setTargetAtTime([0.2, 0.12, 0.05, 0.19][i] * (car.spec.electricBoost ? 1.15 : 1), this.ctx.currentTime, 0.3);
    });
    this.engineLP.frequency.setTargetAtTime(1250 * note, this.ctx.currentTime, 0.4);
    this.raspBP.frequency.setTargetAtTime(430 * note + 160, this.ctx.currentTime, 0.4);
    this.turboGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  shift() {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.cancelScheduledValues(t);
    const v = this.engineGain.gain.value;
    this.engineGain.gain.setValueAtTime(v * 0.32, t);
    this.engineGain.gain.setTargetAtTime(v, t + 0.045, 0.08);
    // mechanical clack
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.05);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.4;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.1);
  }

  pop(intensity = 1) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.08);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 320 + Math.random() * 500; bp.Q.value = 1.1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.22 * intensity, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t); src.stop(t + 0.09);
  }

  update(car, dt, muted = false) {
    if (!this.ctx || !this.ready) return;
    if (!this.enabled) return;
    const sp = car.spec;
    const t = this.ctx.currentTime;
    const s = this.smooth;
    const speed = Math.abs(car.vLong);
    const rpm = car.rpm;
    const load = Math.max(car.throttle, car.reverse ? car.brake : 0);

    s.rpm = damp(s.rpm, rpm, 14, dt);
    s.load = damp(s.load, load, 9, dt);
    s.speed = damp(s.speed, speed, 4, dt);
    s.boost = damp(s.boost, car.boost, 5, dt);

    const fire = (s.rpm / 60) * (sp.electricBoost ? 2.2 : 2.0) * car.def.sound.note;
    this.oscs.forEach((o) => {
      o.o.frequency.setTargetAtTime(clamp(fire * o.mult, 24, 4200), t, 0.02);
    });

    const airGain = (0.06 + s.load * 0.26) * (0.55 + 0.45 * clamp(s.rpm / sp.redline, 0, 1));
    this.engineGain.gain.setTargetAtTime(muted ? 0 : airGain, t, 0.045);
    this.rapGainSet = true;
    this.raspGain.gain.setTargetAtTime(muted ? 0 : (0.035 + s.load * 0.14) * (0.4 + 0.6 * clamp(s.rpm / sp.redline, 0, 1)), t, 0.05);
    this.engineLP.frequency.setTargetAtTime(950 + s.load * 1650 + s.rpm * 0.12, t, 0.06);

    const turbo = car.def.sound.turbo;
    this.turboGain.gain.setTargetAtTime(muted ? 0 : turbo * s.boost * s.load * 0.016, t, 0.08);
    this.turboOsc.frequency.setTargetAtTime(1500 + turbo * s.boost * 2600, t, 0.1);

    const surf = car.surfaceInfo || { rumble: 0 };
    this.roadGain.gain.setTargetAtTime(muted ? 0 : clamp(s.speed / 60, 0, 1) * (0.015 + surf.rumble * 0.09), t, 0.08);
    this.roadFilter.frequency.setTargetAtTime(280 + s.speed * 9 + surf.rumble * 380, t, 0.08);
    this.windGainNode.gain.setTargetAtTime(muted ? 0 : clamp(Math.pow(s.speed / 62, 2.1), 0, 1) * 0.075, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(500 + s.speed * 12, t, 0.12);

    // gear shift audio
    if (car.gear !== this.lastGear) {
      this.shift();
      this.lastGear = car.gear;
    }
    // overrun pops
    this.popCooldown -= dt;
    if (this.popCooldown <= 0 && s.load < 0.06 && s.rpm > sp.redline * 0.55 && car.def.sound.rasp > 0.4) {
      this.pop(0.4 + Math.random() * 0.5);
      this.popCooldown = 0.14 + Math.random() * 0.4;
    }
  }
}
