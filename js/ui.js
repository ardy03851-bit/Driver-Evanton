import { CARS, PAINTS, TIMES, clamp, lerp, isTouch } from './config.js';
import { roadX, roadY, roadD } from './world.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => (n < 10 ? n.toFixed(1) : Math.round(n).toString());
const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;

const REGION_NAMES = ['Pine Valley', 'Valle Verde', 'Alta Ridge', 'Lago Nord', 'Passo Sette'];
export const regionAt = (s) => REGION_NAMES[Math.floor(((s / 2400) % REGION_NAMES.length + REGION_NAMES.length) % REGION_NAMES.length)];

export class UI {
  constructor(callbacks) {
    this.cb = callbacks;
    this.state = {
      panel: null, photo: false, carId: CARS[0].id, paint: CARS[0].paint,
      quality: 'high', time: 'golden', auto: true, assist: false, sound: false, volume: 0.55,
    };
    this.lastGear = 1;
    this.speedHistory = new Array(80).fill(0);
    this.historyAcc = 0;
    this.lastHud = {};
    this.shiftFlashTimer = 0;
    this.lastShiftDir = 1;
    this.toastTimer = 0;
    this.hintTimer = 0;
    this.buildDial();
    this.bind();
    /* tablet wording in the intro footer */
    if (isTouch) {
      const tip = document.getElementById('intro-tip-text');
      if (tip) tip.textContent = 'Hold GAS to drive · side pads to steer · pause to stop';
    }
  }

  /* ── boot ─────────────────────────────────────────────────── */
  bootProgress(p, note) {
    const bar = $('boot-bar');
    if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    if (note && $('boot-note')) $('boot-note').textContent = note;
  }
  bootDone() {
    document.body.classList.add('booted');
    setTimeout(() => { const b = $('boot'); if (b) b.style.display = 'none'; }, 1300);
  }

  /* ── dial setup ───────────────────────────────────────────── */
  buildDial() {
    const cx = 100, cy = 100, r = 86;
    const start = 135, end = 405;
    const polar = (deg) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
    const [sx, sy] = polar(start);
    const [ex, ey] = polar(end);
    const path = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r} ${r} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
    const track = $('dial-track'), arc = $('dial-arc');
    track.setAttribute('d', path);
    arc.setAttribute('d', path);
    this.arcLen = arc.getTotalLength ? arc.getTotalLength() : 405;
    arc.style.strokeDasharray = `${this.arcLen}`;
    arc.style.strokeDashoffset = `${this.arcLen}`;

    const ticks = $('dial-ticks');
    let html = '';
    for (let i = 0; i <= 40; i++) {
      const deg = start + ((end - start) * i) / 40;
      const major = i % 5 === 0;
      const [x1, y1] = polar(deg);
      const r2 = major ? r - 12 : r - 7;
      const x2 = cx + r2 * Math.cos((deg * Math.PI) / 180);
      const y2 = cy + r2 * Math.sin((deg * Math.PI) / 180);
      html += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="${major ? 'major' : ''}" opacity="${major ? 0.55 : 0.28}"/>`;
      if (major) {
        const rl = r - 23;
        const tx = cx + rl * Math.cos((deg * Math.PI) / 180);
        const ty = cy + rl * Math.sin((deg * Math.PI) / 180) + 2.2;
        html += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}">${i / 5}</text>`;
      }
    }
    ticks.innerHTML = html;
  }

  /* ── bindings ─────────────────────────────────────────────── */
  bind() {
    $('btn-start')?.addEventListener('click', () => this.cb.onStart?.());
    $('btn-intro-garage')?.addEventListener('click', () => this.openPanel('garage'));
    $('btn-map')?.addEventListener('click', () => this.openPanel('map'));
    $('btn-camera')?.addEventListener('click', () => this.cb.onCamera?.());
    $('btn-sound')?.addEventListener('click', () => this.cb.onSoundToggle?.());
    $('btn-garage')?.addEventListener('click', () => this.openPanel('garage'));
    $('btn-pause')?.addEventListener('click', () => this.openPanel('pause'));

    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.closePanel()));
    $('scrim')?.addEventListener('click', () => this.closePanel());
    document.querySelectorAll('[data-resume]').forEach((b) => b.addEventListener('click', () => this.closePanel()));
    document.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => this.openPanel(b.dataset.panel)));
    document.querySelectorAll('[data-action="photo"]').forEach((b) => b.addEventListener('click', () => this.cb.onPhoto?.()));

    document.querySelectorAll('[data-photo]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.photo;
      if (a === 'snap') this.cb.onSnap?.();
      else if (a === 'exit') this.cb.onPhoto?.();
      else this.cb.onOrbitReset?.();
    }));

    $('btn-take-keys')?.addEventListener('click', () => {
      this.cb.onCarCommit?.(this.state.carId, this.state.paint);
      this.closePanel();
    });

    /* ── touch controls ──────────────────────────────────────
       Everything is tracked on the window by pointerId rather than on
       the individual buttons. That means: two fingers can hold gas and
       steer at once, a thumb can slide from one steering pad to the
       other, sliding off a pad keeps the pedal down, and a cancelled
       gesture can never leave the throttle stuck on. */
    this.touch = { gas: 0, brake: 0 };
    this.touchSteer = 0;
    this.touchHandbrake = false;
    const held = new Map();      // pointerId → pad element

    const kindOf = (el) => {
      if (!el || !el.dataset) return null;
      if (el.dataset.pedal) return 'pedal';
      if (el.dataset.steer) return 'steer';
      if (el.dataset.handbrake !== undefined) return 'handbrake';
      return null;
    };
    const padAt = (el) => (el && el.closest ? el.closest('[data-pedal],[data-steer],[data-handbrake]') : null);

    const applyHeld = () => {
      this.touch.gas = 0;
      this.touch.brake = 0;
      this.touchSteer = 0;
      this.touchHandbrake = false;
      document.querySelectorAll('.touch [data-pedal],.touch [data-steer],.touch [data-handbrake]')
        .forEach((b) => b.classList.remove('held'));
      for (const pad of held.values()) {
        pad.classList.add('held');
        const kind = kindOf(pad);
        if (kind === 'pedal') this.touch[pad.dataset.pedal] = 1;
        else if (kind === 'steer') this.touchSteer = pad.dataset.steer === 'left' ? -1 : 1;
        else if (kind === 'handbrake') this.touchHandbrake = true;
      }
    };

    const releaseId = (id) => { if (held.delete(id)) applyHeld(); };
    this.releaseTouch = () => { if (held.size) { held.clear(); applyHeld(); } };

    window.addEventListener('pointerdown', (e) => {
      const pad = padAt(e.target);
      if (!pad) return;
      /* keep the gesture away from the canvas / document handlers */
      if (e.pointerType === 'touch') e.preventDefault();
      held.set(e.pointerId, pad);
      applyHeld();
      try { pad.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
    }, { capture: true, passive: false });

    /* sliding a thumb from one pad to its neighbour re-assigns it */
    window.addEventListener('pointermove', (e) => {
      if (!held.has(e.pointerId) || e.pointerType !== 'touch') return;
      const pad = padAt(document.elementFromPoint(e.clientX, e.clientY));
      if (pad && pad !== held.get(e.pointerId) && kindOf(pad) === kindOf(held.get(e.pointerId))) {
        held.set(e.pointerId, pad);
        applyHeld();
      }
    }, { passive: true });

    window.addEventListener('pointerup', (e) => releaseId(e.pointerId), { capture: true });
    window.addEventListener('pointercancel', (e) => releaseId(e.pointerId), { capture: true });
    window.addEventListener('blur', () => this.releaseTouch());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseTouch(); });

    /* a long press must never open the iOS callout or start a drag */
    document.querySelectorAll('.touch button').forEach((b) => {
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      b.addEventListener('dragstart', (e) => e.preventDefault());
    });
  }

  /* ── intro ────────────────────────────────────────────────── */
  buildIntroCars() {
    const wrap = $('intro-cars');
    if (!wrap) return;
    wrap.innerHTML = CARS.map((c) => `
      <button class="intro-car" data-car="${c.id}" style="--sw:${c.paint}">
        <i></i><span>${c.name}</span><em>${c.spec.power} hp</em>
      </button>`).join('');
    wrap.querySelectorAll('[data-car]').forEach((b) => b.addEventListener('click', () => {
      const car = CARS.find((c) => c.id === b.dataset.car);
      if (!car) return;
      this.state.carId = car.id;
      this.state.paint = car.paint;
      this.syncIntroCars();
      this.cb.onCarPreview?.(car.id, car.paint);
    }));
    this.syncIntroCars();
  }
  syncIntroCars() {
    document.querySelectorAll('.intro-car').forEach((b) => b.classList.toggle('sel', b.dataset.car === this.state.carId));
  }

  setCar(id, paint) {
    this.state.carId = id;
    if (paint) this.state.paint = paint;
    this.syncIntroCars();
    const car = CARS.find((c) => c.id === id);
    if (car) {
      const nameEl = $('hud-car');
      if (nameEl) nameEl.textContent = car.name.toUpperCase();
      const power = $('hud-power');
      if (power) power.textContent = `${car.spec.power} hp`;
      const drive = $('hud-drive');
      if (drive) drive.textContent = car.spec.drive;
    }
    if (this.state.panel === 'garage') this.renderGarage();
  }

  syncButtons({ sound, assist } = {}) {
    if (typeof sound === 'boolean') this.state.sound = sound;
    if (typeof assist === 'boolean') this.state.assist = assist;
    const bs = $('btn-sound');
    if (bs) { bs.classList.toggle('on', !!this.state.sound); bs.innerHTML = icon(this.state.sound ? 'sound' : 'mute'); }
    const ael = $('hud-assist');
    if (ael) { ael.textContent = this.state.assist ? 'ASSIST' : 'TCS'; ael.style.color = this.state.assist ? 'var(--amber)' : ''; }
  }

  /* ── garage ───────────────────────────────────────────────── */
  openPanel(name) {
    if (this.state.photo && name !== 'photo') return;
    const prev = this.state.panel;
    this.state.panel = name;
    document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('on'));
    const sheet = $(`sheet-${name}`);
    if (!sheet) { this.state.panel = null; return; }
    if (name === 'garage') this.renderGarage();
    if (name === 'settings') this.renderSettings();
    if (name === 'map') this.drawMap();
    /* the panel may have been closed again before the next paint (a tap
       on Pause then Photo lands inside the same frame on a slow device);
       don't let a stale frame re-open it */
    requestAnimationFrame(() => { if (this.state.panel === name) sheet.classList.add('on'); });
    $('scrim').classList.add('on');
    $('hud').style.pointerEvents = 'none';
    document.body.classList.add('panel-open');
    if (prev !== name) this.cb.onPanel?.(name);
  }

  closePanel() {
    this.state.panel = null;
    document.querySelectorAll('.sheet').forEach((s) => s.classList.remove('on'));
    $('scrim').classList.remove('on');
    $('hud').style.pointerEvents = '';
    document.body.classList.remove('panel-open');
    this.cb.onPanel?.(null);
  }

  renderGarage() {
    const list = $('car-list');
    if (!list) return;
    list.innerHTML = CARS.map((c) => `
      <button class="car-item ${c.id === this.state.carId ? 'sel' : ''}" data-car="${c.id}" style="--sw:${c.paint}">
        <i></i>
        <div><b>${c.name}</b><span>${c.spec.power} HP · ${c.spec.drive}</span></div>
        <span class="sel-mark">SELECTED</span>
      </button>`).join('');
    list.querySelectorAll('[data-car]').forEach((b) => b.addEventListener('click', () => {
      const car = CARS.find((c) => c.id === b.dataset.car);
      this.state.carId = car.id;
      this.state.paint = car.paint;
      this.syncIntroCars();
      this.cb.onCarPreview?.(car.id, car.paint);
      this.renderGarage();
    }));

    const car = CARS.find((c) => c.id === this.state.carId) || CARS[0];
    const detail = $('car-detail');
    if (!detail) return;
    const s = car.spec;
    const meters = [
      ['Power', s.power / 1000, `${s.power} hp`],
      ['Agility', (s.gripF + s.gripR) / 3.4, s.wheelbase < 2.62 ? 'Featherweight' : 'Composed'],
      ['Stability', (s.downforce + s.trackF * 2) / 8, s.drive],
      ['Comfort', s.spring / 70, s.spring < 40 ? 'GT tune' : 'Track tune'],
    ];
    detail.innerHTML = `
      <div class="car-hero">
        <div>
          <h3>${car.full}</h3>
          <p>${car.year} · ${car.tag}</p>
          <div class="car-swatch">
            ${PAINTS.map((p) => `<button class="sw ${p.hex === this.state.paint ? 'sel' : ''}" data-paint="${p.hex}" style="--c:${p.hex}" title="${p.name}" aria-label="${p.name}"></button>`).join('')}
          </div>
        </div>
        <div class="car-tag"><b>${s.power}</b><span>horsepower</span></div>
      </div>
      <div class="stats">
        <div class="stat"><b>${(s.mass / 1000).toFixed(2)} t</b><span>Dry weight</span></div>
        <div class="stat"><b>${s.redline.toLocaleString()}</b><span>Redline</span></div>
        <div class="stat"><b>${s.torque} Nm</b><span>Torque</span></div>
        <div class="stat"><b>${s.gears.length}-spd</b><span>${s.drive}</span></div>
      </div>
      <div class="meters">
        ${meters.map(([label, v, val]) => `
          <div class="meter-row"><label>${label}</label>
            <div class="meter"><i style="width:${Math.round(clamp(v, 0.08, 1) * 100)}%"></i></div>
            <span>${val}</span></div>`).join('')}
      </div>
      <div class="car-char">${car.character.map((c) => `<span class="char-chip">${c}</span>`).join('')}<span class="char-chip">${s.tyreF * 2 > 0.7 ? '20″ wheels' : '20″'}</span></div>
      <p class="car-note">${car.blurb}</p>
      <p class="car-note"><b>Engine:</b> ${s.power} hp · ${s.torque} Nm from ${s.torqueRpm.toLocaleString()} rpm · ${s.redline.toLocaleString()} rpm redline.<br>
      <b>Chassis:</b> ${s.mass} kg, ${s.length.toFixed(2)} m long, ${s.wheelbase} m wheelbase. <b>0–100:</b> ${s.zero.toFixed(1)} s. <b>Top speed:</b> ${s.vmax} km/h.</p>`;
    detail.querySelectorAll('[data-paint]').forEach((b) => b.addEventListener('click', () => {
      this.state.paint = b.dataset.paint;
      this.cb.onPaint?.(b.dataset.paint);
      detail.querySelectorAll('.sw').forEach((s2) => s2.classList.toggle('sel', s2.dataset.paint === b.dataset.paint));
      const intro = document.querySelector(`.intro-car[data-car="${car.id}"]`);
      if (intro) intro.style.setProperty('--sw', b.dataset.paint);
    }));
  }

  maxSpeed(car) {
    const s = car.spec;
    const ratio = s.gears[s.gears.length - 1] * s.final;
    return (s.redline / 60) * (2 * Math.PI * s.tyreR) / ratio * 3.6;
  }

  renderSettings() {
    const body = $('settings-body');
    if (!body) return;
    const seg = (key, opts, current) => `
      <div class="seg">${opts.map(([v, label]) => `<button data-set="${key}" data-val="${v}" class="${v === current ? 'sel' : ''}">${label}</button>`).join('')}</div>`;
    body.innerHTML = `
      <div class="set-row">
        <div class="set-label"><b>Light</b><span>The hour changes the whole road</span></div>
        <div class="seg">${Object.entries(TIMES).map(([k, p]) => `<button data-set="time" data-val="${k}" class="${this.state.time === k ? 'sel' : ''}">${p.label}</button>`).join('')}</div>
      </div>
      <div class="set-row">
        <div class="set-label"><b>Rendering</b><span>Resolution and foliage density</span></div>
        ${seg('quality', [['high', 'High'], ['balanced', 'Balanced'], ['eco', 'Efficient']], this.state.quality)}
      </div>
      <div class="set-row">
        <div class="set-label"><b>Gearbox</b><span>Automatic or paddle shift</span></div>
        ${seg('auto', [['true', 'Automatic'], ['false', 'Manual']], String(this.state.auto))}
      </div>
      <div class="set-row">
        <div class="set-label"><b>Driver assist</b><span>Lane keeping at a relaxed cruise</span></div>
        <button class="toggle ${this.state.assist ? 'on' : ''}" data-toggle="assist" aria-label="Driver assist"></button>
      </div>
      <div class="set-row">
        <div class="set-label"><b>Engine sound</b><span>Synthesised V8, V12 and V6</span></div>
        <button class="toggle ${this.state.sound ? 'on' : ''}" data-toggle="sound" aria-label="Sound"></button>
      </div>
      <div class="set-row">
        <div class="set-label"><b>Volume</b><span>Master level</span></div>
        <input class="range" type="range" min="0" max="1" step="0.01" value="${this.state.volume}" data-range="volume" style="--p:${this.state.volume * 100}%">
      </div>
      <div class="set-row">
        <div class="set-label"><b>Traffic &amp; terrain</b><span>No traffic. No timers. Just the road.</span></div>
        <button class="seg" style="padding:0;border:0;background:none" data-reset-trip><span class="char-chip">Reset journey</span></button>
      </div>`;

    body.querySelectorAll('[data-set]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.set, val = b.dataset.val;
      body.querySelectorAll(`[data-set="${key}"]`).forEach((x) => x.classList.toggle('sel', x === b));
      if (key === 'time') { this.state.time = val; this.cb.onTime?.(val); }
      if (key === 'quality') { this.state.quality = val; this.cb.onQuality?.(val); }
      if (key === 'auto') {
        this.state.auto = val === 'true';
        this.cb.onAuto?.(this.state.auto);
        this.toast(this.state.auto ? 'Automatic gearbox' : 'Manual gearbox — use Shift / paddles');
      }
    }));
    body.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      const key = b.dataset.toggle;
      this.state[key] = !this.state[key];
      b.classList.toggle('on', this.state[key]);
      if (key === 'assist') this.cb.onAssist?.(this.state.assist);
      if (key === 'sound') { this.cb.onSoundToggle?.(); this.syncButtons({ sound: this.state.sound }); }
    }));
    const range = body.querySelector('[data-range="volume"]');
    range?.addEventListener('input', () => {
      this.state.volume = parseFloat(range.value);
      range.style.setProperty('--p', `${this.state.volume * 100}%`);
      this.cb.onVolume?.(this.state.volume);
    });
    body.querySelector('[data-reset-trip]')?.addEventListener('click', () => { this.cb.onResetTrip?.(); this.toast('Journey reset'); });
    this.syncButtons({ sound: this.state.sound });
  }

  /* ── HUD ──────────────────────────────────────────────────── */
  update(dt, car, elapsed) {
    const S = this.state;
    const speed = Math.round(car.speedKmh || 0);
    const rpm = Math.round(car.rpm || 0);
    const gear = car.reverseLabel || '1';
    const key = `${speed}|${rpm}|${gear}|${car.gear}`;
    const changed = key !== this.lastHud.key;
    this.lastHud.key = key;

    if (changed) {
      const sp = $('hud-speed');
      if (sp) sp.textContent = speed;
      const g = $('hud-gear');
      if (g) {
        g.textContent = gear;
        g.classList.toggle('redline', rpm > car.spec.redline * 0.88);
        if (car.gear !== this.lastGear) {
          g.classList.remove('shift');
          void g.offsetWidth;
          g.classList.add('shift');
          this.lastShiftDir = car.gear > this.lastGear ? 1 : -1;
          this.shiftFlashTimer = 0.45;
          this.lastGear = car.gear;
        }
      }
      const rpmNum = $('hud-rpm');
      if (rpmNum) rpmNum.textContent = rpm.toLocaleString();
    }

    const frac = clamp(rpm / car.spec.redline, 0, 1);
    const fill = $('hud-rpm-fill');
    if (fill) fill.style.width = `${4 + frac * 96}%`;
    const arc = $('dial-arc');
    if (arc) arc.style.strokeDashoffset = `${this.arcLen * (1 - frac)}`;

    this.shiftFlashTimer = Math.max(0, this.shiftFlashTimer - dt);
    document.querySelectorAll('.gear-arrow').forEach((a) => {
      const dir = a.dataset.gearDir === 'up' ? 1 : -1;
      a.classList.toggle('on', this.shiftFlashTimer > 0 && dir === this.lastShiftDir);
    });

    /* slower text updates */
    this.historyAcc += dt;
    if (this.historyAcc > 0.35) {
      this.historyAcc = 0;
      this.set('hud-distance', (car.distance / 1000).toFixed(1));
      this.set('hud-top', Math.round(car.topSpeed));
      this.set('hud-surface', this.surfaceLabel(car.surface));
      this.set('hud-bearing', this.bearing(car.yaw));
      this.set('hud-clock', this.clock(elapsed));
      const region = regionAt(Math.max(0, -car.z));
      this.lastRegion = region;
    }

    /* speed graph */
    if (elapsed - (this._graphT || 0) > 0.28) {
      this._graphT = elapsed;
      this.speedHistory.push(car.speedKmh || 0);
      this.speedHistory.shift();
      this.drawGraph();
    }
  }

  set(id, text) {
    const el = $(id);
    if (el && el.textContent !== String(text)) el.textContent = text;
  }

  surfaceLabel(s) {
    return { tarmac: 'Tarmac', shoulder: 'Shoulder', gravel: 'Gravel', grass: 'Meadow', sand: 'Sand' }[s] || 'Tarmac';
  }

  bearing(yaw) {
    const deg = ((yaw * 180) / Math.PI + 360) % 360;
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return `${names[Math.round(deg / 45) % 8]} ${Math.round(deg).toString().padStart(3, '0')}°`;
  }

  clock(elapsed) {
    const base = this.state.time === 'dusk' ? 19.4 : this.state.time === 'day' ? 12.6 : this.state.time === 'overcast' ? 14.2 : 17.8;
    const t = (base + elapsed / 900) % 24;
    const h = Math.floor(t), m = Math.floor((t - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  drawGraph() {
    const c = $('hud-graph');
    if (!c) return;
    const g = c.getContext('2d');
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    const max = Math.max(80, ...this.speedHistory) * 1.08;
    const pts = this.speedHistory.map((v, i) => [((i / (this.speedHistory.length - 1)) * w), h - 4 - (v / max) * (h - 10)]);
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = 1.2;
    g.lineJoin = 'round';
    g.stroke();
    g.lineTo(w, h); g.lineTo(0, h); g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,194,122,.24)');
    grad.addColorStop(1, 'rgba(255,194,122,0)');
    g.fillStyle = grad;
    g.fill();
    const last = pts[pts.length - 1];
    g.beginPath();
    g.arc(last[0] - 1, last[1], 2, 0, Math.PI * 2);
    g.fillStyle = '#ffc27a';
    g.fill();
  }

  /* ── map ──────────────────────────────────────────────────── */
  drawMap() {
    const c = $('map-canvas');
    if (!c) return;
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const bg = g.createRadialGradient(W * 0.5, H * 0.45, 20, W * 0.5, H * 0.45, W * 0.7);
    bg.addColorStop(0, 'rgba(255,255,255,.035)');
    bg.addColorStop(1, 'rgba(0,0,0,.08)');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,.045)';
    g.lineWidth = 1;
    for (let x = 0; x < W; x += 80) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y < H; y += 80) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }

    const carS = this.mapState?.s || 40;
    const carOff = this.mapState?.off || 0;
    const scale = 0.055;
    const cx = W / 2, cy = H / 2;
    const pts = [];
    for (let s = carS - 6000; s <= carS + 6000; s += 40) {
      const x = roadX(s) - roadX(carS);
      const z = -(s - carS);
      pts.push([cx + x * scale, cy + z * scale]);
    }
    // route glow
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = 'rgba(255,255,255,.09)'; g.lineWidth = 12; g.stroke();
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = 'rgba(255,255,255,.32)'; g.lineWidth = 2.2; g.stroke();
    // travelled section
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.save();
    g.beginPath();
    const midX = cx, midY = cy;
    g.rect(0, midY, W, H);
    g.clip();
    g.strokeStyle = 'rgba(255,194,122,.7)'; g.lineWidth = 2.6; g.stroke();
    g.restore();

    // start marker
    const start = pts[0];
    g.beginPath(); g.arc(start[0], start[1], 4, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,.4)'; g.fill();

    // our car
    const angle = (this.mapState?.yaw || 0);
    g.save();
    g.translate(cx + carOff * scale * 0.2, cy);
    g.rotate(0);
    g.beginPath(); g.arc(0, 0, 16, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,194,122,.14)'; g.fill();
    g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2);
    g.fillStyle = '#ffd7a2'; g.fill();
    g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 1.4;
    g.beginPath(); g.arc(0, 0, 10, 0, Math.PI * 2); g.stroke();
    // heading wedge
    g.rotate(Math.PI - angle);
    g.beginPath(); g.moveTo(0, -20); g.lineTo(5, -10); g.lineTo(-5, -10); g.closePath();
    g.fillStyle = 'rgba(255,214,160,.9)'; g.fill();
    g.restore();

    // place labels
    g.font = '600 11px system-ui,sans-serif';
    g.fillStyle = 'rgba(255,255,255,.35)';
    g.textAlign = 'left';
    const label = regionAt(Math.max(0, carS));
    g.fillText(label.toUpperCase(), 24, H - 24);
    const placeEl = $('map-place');
    if (placeEl) placeEl.textContent = label;
    const kmEl = $('map-km');
    if (kmEl) kmEl.textContent = (this.mapState?.distance || 0).toFixed(1);
    const nextEl = $('map-next');
    if (nextEl) nextEl.textContent = `Next: ${regionAt(Math.max(0, carS + 2400))}`;
  }

  updateMapState(car) {
    this.mapState = { s: -car.z, off: (car.x - roadX(-car.z)) * Math.sqrt(1 + roadD(-car.z) ** 2), yaw: car.yaw, distance: car.distance / 1000 };
    if (this.state.panel === 'map' && !this._mapTimer) {
      this.drawMap();
      this._mapTimer = setInterval(() => { this.drawMap(); }, 600);
    }
    if (this.state.panel !== 'map' && this._mapTimer) { clearInterval(this._mapTimer); this._mapTimer = null; }
  }

  /* ── toast ────────────────────────────────────────────────── */
  toast(msg, ico = 'check') {
    const el = $('toast');
    if (!el) return;
    el.innerHTML = `${icon(ico)}<span>${msg}</span>`;
    el.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
  }

  showFatal(msg) {
    const f = $('fatal');
    if (!f) return;
    $('fatal-msg').textContent = msg;
    f.hidden = false;
  }

  hideHint() {
    $('hint')?.classList.add('fade');
    $('touch-hint')?.classList.add('fade');
  }

  setPhoto(on) {
    this.state.photo = on;
    document.body.classList.toggle('photo', on);
  }

  pauseLabel(car) {
    const el = $('pause-place');
    if (el) el.textContent = `${regionAt(Math.max(0, -car.z))} · Alpine route`;
  }
}
