import { clamp, lerp, smoothstep, damp, SURFACES } from './config.js';
import { roadX, roadD, roadYaw, surfaceHeight, roadInfo } from './world.js';

const G = 9.81;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/* ═══════════════════════════════════════════════════════════════
   Vehicle — fixed-step dynamics.
   World axes: +X right, +Y up, +Z forward.
   Yaw positive turns right. Wheels touch y = 0.
   ═══════════════════════════════════════════════════════════════ */
export class Vehicle {
  constructor(def) {
    this.def = def;
    this.spec = def.spec;
    this.auto = true;
    this.assist = false;
    this.reset(40);
  }

  reset(s = 40, lane = 1.8) {
    const sp = this.spec;
    this.s = s;
    const x = roadX(s) + lane;
    this.x = x;
    this.z = -s;
    this.y = surfaceHeight(x, -s);
    this.yaw = roadYaw(s);
    this.vLong = 0;
    this.vLat = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.boost = 0;
    this.gear = 1;
    this.rpm = sp.idle;
    this.shiftTimer = 0;
    this.ax = 0;
    this.ay = 0;
    this.wheelSpin = 0;
    this.pitch = 0;
    this.roll = 0;
    this.pitchVel = 0;
    this.rollVel = 0;
    this.reverse = false;
    this.brakeHold = 0;
    this.reverseTimer = 0;
    this.slip = 0;
    this.surface = 'tarmac';
    this.distance = 0;
    this.topSpeed = 0;
    this.braking = false;
    this.shiftFlash = 0;
    this.gearJustChanged = 0;
    this.limiterTime = 0;
    this.handbrake = 0;
    this.speedKmh = 0;
    this.accel = 0;
    this.reverseLabel = '1';
    this._axSmooth = 0;
    this._aySmooth = 0;
  }

  torqueAt(rpm) {
    const sp = this.spec;
    const x = clamp(rpm / sp.redline, 0, 1.12);
    const rise = smoothstep(0.02, 0.4, x);
    const fall = 1 - (sp.torqueFall ?? 0.30) * smoothstep(0.62, 1.05, x);
    let tq = sp.torque * (0.46 + 0.54 * rise) * fall;
    if (sp.electricBoost) tq += sp.torque * sp.electricBoost * (1 - smoothstep(0.16, 0.62, x)) * 0.55;
    return tq;
  }

  maxSpeedInGear(gear) {
    const sp = this.spec;
    const ratio = sp.gears[clamp(gear - 1, 0, sp.gears.length - 1)] * sp.final;
    return (sp.redline / 60) * (2 * Math.PI * sp.tyreR) / ratio * 3.6;
  }

  shiftTo(gear) {
    const sp = this.spec;
    if (this.gear === gear) return;
    this.gear = clamp(gear, 1, sp.gears.length);
    this.shiftTimer = sp.shiftTime;
    this.shiftFlash = 1;
    this.gearJustChanged = 1;
  }

  update(dt, input, time) {
    const sp = this.spec;
    let throttleIn = clamp(input.throttle || 0, 0, 1);
    let brakeIn = clamp(input.brake || 0, 0, 1);
    let steerIn = clamp(input.steer || 0, -1, 1);

    if (this.assist) {
      const a = this.autopilot(dt);
      throttleIn = a.throttle; brakeIn = a.brake; steerIn = a.steer;
    }

    const info = roadInfo(this.x, this.z);
    const surf = SURFACES[info.surface] || SURFACES.tarmac;
    this.surface = info.surface;
    this.surfaceInfo = surf;

    const absV = Math.abs(this.vLong);
    const speed = Math.hypot(this.vLong, this.vLat);
    const speedKmh = speed * 3.6;

    /* ── steering: speed-sensitive lock, rate limited ─────────
       At 220 km/h a 0.36 rad lock is 20 m/s² of yaw demand — the car
       simply spun. The lock now falls away with speed so full lock is
       always *just* at the edge of the front tyres' grip, which is
       what makes a fast car feel planted yet still adjustable. */
    const lock = sp.steerLock / (1 + Math.max(0, speedKmh - 35) * 0.031);
    const targetSteer = steerIn * lock;
    this.steer = damp(this.steer, targetSteer, steerIn === 0 ? 14 : 11, dt);
    this.steer = clamp(this.steer, -lock, lock);

    /* ── throttle / brake smoothing ─────────────────────────── */
    this.throttle = damp(this.throttle, throttleIn, 7.5, dt);
    this.brake = damp(this.brake, brakeIn, 11, dt);
    this.braking = brakeIn > 0.08 || this.vLong < -0.2;
    this.handbrake = input.handbrake ? 1 : 0;

    /* ── gearbox ─────────────────────────────────────────────── */
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.shiftFlash = Math.max(0, this.shiftFlash - dt * 2.6);
    this.gearJustChanged = Math.max(0, this.gearJustChanged - dt * 3.2);
    const ratio = sp.gears[this.gear - 1] * sp.final;
    const wheelRps = Math.abs(this.vLong) / (2 * Math.PI * sp.tyreR);
    let rpm = wheelRps * 60 * ratio;

    if (this.reverse) {
      rpm = clamp(sp.idle + Math.abs(this.vLong) * 120, sp.idle, sp.redline * 0.55);
    } else if (absV < 2.2) {
      rpm = sp.idle + this.throttle * 2100;
    }
    rpm = clamp(rpm, sp.idle, sp.limiter);
    this.rpm = damp(this.rpm, rpm, 16, dt);

    if (this.auto && !this.reverse && this.shiftTimer <= 0) {
      const upAt = sp.redline - 280;
      const downAt = sp.redline * 0.34;
      if (this.rpm > upAt && this.gear < sp.gears.length && this.throttle > 0.15) this.shiftTo(this.gear + 1);
      else if (this.rpm < downAt && this.gear > 1) this.shiftTo(this.gear - 1);
    }
    if (!this.auto) {
      if (input.shiftUp) { this.shiftTo(this.gear + 1); input.shiftUp = false; }
      if (input.shiftDown) { if (this.gear > 1) this.shiftTo(this.gear - 1); input.shiftDown = false; }
    }

    /* ── engine torque & boost ──────────────────────────────── */
    const gearRatio = this.reverse ? sp.gears[0] * sp.final : ratio;
    const turbo = this.def.sound.turbo > 0.05;
    const boostTarget = turbo
      ? this.throttle * (0.42 + 0.58 * smoothstep(0.1, 0.48, this.rpm / sp.redline))
      : 1;
    this.boost = damp(this.boost, boostTarget, turbo ? 2.6 : 12, dt);
    const boostMul = turbo ? (0.38 + 0.72 * this.boost) : (0.82 + 0.2 * this.boost);

    let driveForce = 0;
    if (this.shiftTimer <= 0) {
      const tq = this.torqueAt(this.rpm) * boostMul;
      driveForce = (tq * gearRatio * 0.93) / sp.tyreR;
      driveForce *= this.throttle;
    }
    if (this.reverse) driveForce = 0;

    /* ── loads & traction limit ──────────────────────────────── */
    const m = sp.mass;
    const down = 0.5 * 1.2 * sp.downforce * speed * speed * 0.25;
    const transfer = m * this._axSmooth * 0.44 / sp.wheelbase;
    const FzF = Math.max(400, m * G * sp.distF - transfer + down * 0.42);
    const FzR = Math.max(400, m * G * (1 - sp.distF) + transfer + down * 0.58);
    const muF = sp.gripF * surf.grip;
    const muR = sp.gripR * surf.grip * (this.handbrake ? 0.34 : 1);

    const awdRear = sp.drive === 'AWD' ? 1 - sp.driveBias : 1;
    const tractionRear = muR * FzR;
    const tractionFront = muF * FzF * (sp.drive === 'AWD' ? sp.driveBias + 0.22 : 0);
    const maxDrive = (tractionRear * awdRear + tractionFront) * 0.98;
    if (driveForce > 0) driveForce = Math.min(driveForce, maxDrive);
    if (driveForce < 0) driveForce = Math.max(driveForce, -maxDrive * 0.75);

    /* ── resistance & brakes ─────────────────────────────────── */
    const vSign = Math.sign(this.vLong);
    const drag = 0.5 * 1.2 * sp.cdA * this.vLong * this.vLong * vSign * surf.drag;
    const roll = sp.rolling * m * G * vSign * (Math.abs(this.vLong) > 0.15 ? 1 : 0) * surf.drag;
    const engineBrake = (this.throttle < 0.04 && !this.reverse)
      ? sp.engineBrake * m * 0.55 * vSign * smoothstep(4, 30, absV) * 0.12 : 0;

    /* ── brakes ───────────────────────────────────────────────
       The brake force is capped by the friction circle of the four
       tyres (roughly 1 g for these cars on tarmac). The old code
       used a per-step "stopping distance" cap that resolved to
       ~3 g at 100 km/h, which outran the tyres and dragged the car
       off the road whenever you touched the pedal. */
    let brakeForce = 0;
    const brakeCap = sp.brake * m * G * clamp(surf.grip, 0.35, 1) * 0.62;
    if (this.brake > 0.01 && !this.reverse) {
      brakeForce = vSign * brakeCap * this.brake;
    }
    const rearBrakeShare = 0.34;
    if (this.handbrake && !this.reverse) {
      brakeForce += vSign * brakeCap * 0.55 * rearBrakeShare;
    }

    /* clutch at crawl: engine can't push through brakes */
    if (this.brake > 0.5 && Math.abs(this.vLong) < 0.35) driveForce = 0;

    /* ── terrain slope ────────────────────────────────────────
       Gravity along the hill. Uphill costs speed, downhill adds it.
       Without this the car climbed 45° of mountainside at 280 km/h
       as though it were flat. */
    let slopeForce = 0;
    if (!info.onRoad) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const hw = sp.wheelbase * 0.5;
      const grade = (surfaceHeight(this.x + fx * hw, this.z + fz * hw)
                   - surfaceHeight(this.x - fx * hw, this.z - fz * hw)) / sp.wheelbase;
      slopeForce = -m * G * clamp(grade, -1, 1) * 0.85;
    }

    /* a brake (or engine) force may never reverse the direction of
       travel inside a step — it can only bring the car to a stop */
    let brakeLimited = brakeForce;
    if (brakeForce !== 0 && Math.abs(this.vLong) > 1e-6) {
      const momentum = Math.abs(this.vLong) * m;
      const room = momentum / Math.max(dt, 1e-4);
      if (Math.abs(brakeForce) + Math.abs(engineBrake) > room) brakeLimited = Math.sign(vSign) * room;
    }
    let fLong = driveForce - drag - roll - engineBrake - brakeLimited + slopeForce;

    /* reverse engagement — hold the brake at a standstill */
    if (!this.reverse && brakeIn > 0.6 && speed < 0.35) {
      this.brakeHold += dt;
      if (this.brakeHold > 0.5) {
        this.reverse = true;
        this.gear = 1;
        this.brakeHold = 0;
      }
    } else if (!(brakeIn > 0.5 && speed < 0.4)) {
      this.brakeHold = 0;
    }
    /* leave reverse on the throttle, or once the car has been rolling
       forwards for a moment (so releasing the brake doesn't strand it) */
    if (this.reverse) {
      if (throttleIn > 0.12) { this.reverse = false; this.gear = 1; }
      else if (this.vLong > 0.6) {
        this.reverseTimer = (this.reverseTimer || 0) + dt;
        if (this.reverseTimer > 0.25) { this.reverse = false; this.gear = 1; this.reverseTimer = 0; }
      } else this.reverseTimer = 0;
    }
    if (this.reverse) {
      /* in reverse the brake pedal is the reverse throttle, and the
         throttle drives forwards out of reverse. The brake force
         computed above is skipped while in reverse. */
      const revForce = brakeIn * sp.mass * 2.4 + (throttleIn > 0.05 ? throttleIn * sp.mass * 1.2 : 0);
      fLong = -revForce * (this.vLong < -8.5 ? 0 : 1);
    } else if (this.vLong < -0.05 && brakeIn < 0.1 && throttleIn < 0.1) {
      /* rolling back out of reverse: coast to a stop rather than run away */
      fLong = 0;
    }

    /* ── low speed stabilisation ────────────────────────────── */
    const lowBlend = 1 - smoothstep(1.6, 4.6, speed);
    const speedLong = Math.max(Math.abs(this.vLong), 0.85);

    /* ── bogged down ──────────────────────────────────────────
       In deep grass or gravel a standing start is hard work (half of
       what you ask for), but asking for full throttle on a slow car
       still gets you moving instead of leaving you stuck. */
    if (!info.onRoad && speed < 6 && throttleIn > 0.1) {
      const urgency = smoothstep(6, 1.5, speed) * smoothstep(0.1, 0.9, throttleIn);
      fLong += urgency * sp.mass * 1.1;
    }

    /* ── tyre model ──────────────────────────────────────────── */
    const a = sp.wheelbase * (1 - sp.distF);
    const b = sp.wheelbase * sp.distF;
    const dir = this.vLong >= -0.2 ? 1 : -1;
    const alphaF = Math.atan2(this.vLat + this.yawRate * a, speedLong) - this.steer * dir;
    const alphaR = Math.atan2(this.vLat - this.yawRate * b, speedLong);
    this.slip = Math.max(Math.abs(alphaF), Math.abs(alphaR));

    /* ── friction ellipse ─────────────────────────────────────
       A tyre can only make so much force. Longitudinal force used
       for drive/brake is spent from the same budget the lateral
       force needs, so braking hard mid-corner washes the front out
       and locking the rear steps the tail out. This is what keeps
       the car on the road when you brake — previously fLong could
       reach 3 g and slide the car straight off into the hills. */
    const driveMaxF = muF * FzF * 1.0;
    const driveMaxR = muR * FzR * 1.0;
    const fxFront = sp.drive === 'AWD' ? -driveForce * sp.driveBias : 0;
    const fxRear = -driveForce * (sp.drive === 'AWD' ? 1 - sp.driveBias : 1) - brakeForce * 0.62;
    const restF = 1 - clamp(Math.abs(fxFront) / Math.max(driveMaxF, 1), 0, 1) ** 2;
    const restR = 1 - clamp(Math.abs(fxRear) / Math.max(driveMaxR, 1), 0, 1) ** 2;
    const holdF = Math.sqrt(Math.max(0, restF));
    const holdR = Math.sqrt(Math.max(0, restR));

    const Fyf = -muF * FzF * holdF * Math.sin(1.36 * Math.atan(9.5 * alphaF));
    const Fyr = -muR * FzR * holdR * Math.sin(1.42 * Math.atan(9.0 * alphaR));

    const cos = Math.cos(this.steer);
    const Iz = m * (sp.wheelbase * sp.wheelbase * 0.21 + 1.35);
    let yawAcc = (a * Fyf * cos - b * Fyr) / Iz;
    // yaw damping + gentle stability control at the limit
    yawAcc -= this.yawRate * (0.9 + (1 - sp.tcs) * 2.2);
    // handbrake and power oversteer: the rear steps out
    yawAcc += (this.handbrake ? 2.6 : 0) * clamp(this.steer / 0.3, -1, 1) * smoothstep(4, 18, absV);

    /* ── integrate ───────────────────────────────────────────── */
    if (lowBlend > 0.001) {
      const kin = (this.vLong * Math.tan(this.steer)) / sp.wheelbase;
      this.yawRate = lerp(this.yawRate + yawAcc * dt, kin, lowBlend * 0.9);
      this.vLat = lerp(this.vLat, 0, lowBlend * 0.6);
    } else {
      this.vLat += ((Fyf * cos + Fyr) / m - this.yawRate * this.vLong) * dt;
      this.yawRate += yawAcc * dt;
    }
    this.vLong += (fLong / m + this.yawRate * this.vLat) * dt;

    /* ── surface scrubbing ────────────────────────────────────
       Grass, gravel and sand drag the car down hard, so leaving the
       tarmac actually costs you speed instead of being a free
       shortcut. Applied as a velocity decay, never as a force, so it
       can only slow the car — it can never push it backwards. */
    if (absV > 0.05) {
      const scrub = (surf.drag - 1) * 0.14;
      if (scrub > 0) this.vLong *= Math.exp(-scrub * dt);
    }

    /* ── traction budget ──────────────────────────────────────
       The bike model above is only as good as its force budget: if
       the lateral velocity is allowed to grow unchecked the couple
       term (yawRate × vLat) feeds straight back into forward speed and
       the car accelerates to 350 km/h while braking. Clamp the total
       horizontal acceleration to what 1.35 g of tyre can actually
       deliver (a little headroom so slides still feel alive). */
    {
      const maxA = 1.35 * G * clamp(surf.grip, 0.3, 1);
      const spd = Math.hypot(this.vLong, this.vLat);
      if (spd > maxA * 0.55) {
        const capLat = Math.sqrt(Math.max(0, (maxA * maxA) - (fLong / m) ** 2)) * Math.max(0.55, 1 - spd / 160);
        this.vLat = clamp(this.vLat, -Math.max(4, capLat), Math.max(4, capLat));
      }
      this.yawRate = clamp(this.yawRate, -2.4, 2.4);
      /* gravity downhill can never out-accelerate the tyres */
      const maxLong = maxA * 2.1;
      fLong = clamp(fLong, -maxLong * m, maxLong * m);
    }

    // hard safety rails
    if (!isFinite(this.vLong) || !isFinite(this.vLat) || !isFinite(this.yawRate)) this.reset(40);
    this.vLong = clamp(this.vLong, -12, 125);
    this.vLat = clamp(this.vLat, -30, 30);

    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    this.x += (sy * this.vLong + cy * this.vLat) * dt;
    this.z += (cy * this.vLong - sy * this.vLat) * dt;

    /* ── ground follow & body attitude (critically damped) ──── */
    const targetY = surfaceHeight(this.x, this.z);
    this.y = damp(this.y, targetY, 38, dt);
    const fwdX = Math.sin(this.yaw), fwdZ = Math.cos(this.yaw);
    const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
    const halfWB = sp.wheelbase / 2, halfT = sp.trackF / 2 + 0.35;
    const hF = surfaceHeight(this.x + fwdX * halfWB, this.z + fwdZ * halfWB);
    const hB = surfaceHeight(this.x - fwdX * halfWB, this.z - fwdZ * halfWB);
    const hL = surfaceHeight(this.x - rightX * halfT, this.z - rightZ * halfT);
    const hR = surfaceHeight(this.x + rightX * halfT, this.z + rightZ * halfT);
    const terrainPitch = Math.atan2(hF - hB, sp.wheelbase);
    const terrainRoll = Math.atan2(hR - hL, halfT * 2);

    this.ax = damp(this.ax, (fLong / m), 8, dt);
    this._axSmooth = damp(this._axSmooth, this.ax, 5, dt);
    const latAcc = this.yawRate * this.vLong;
    this.ay = damp(this.ay, latAcc, 8, dt);
    this._aySmooth = damp(this._aySmooth, latAcc, 5, dt);

    /* sign check: the body is drawn with rotation.x = -pitch, so a
       positive pitch tips the nose up. Braking (negative ax) must
       therefore give a positive pitch → nose dives. */
    const wantPitch = terrainPitch * 0.55 - clamp(this._axSmooth * 0.0062, -0.06, 0.06);
    const wantRoll = terrainRoll * 0.5 + clamp(this._aySmooth * 0.0045, -0.06, 0.06);
    const k = 105, c = 2 * Math.sqrt(k) * 1.15;
    this.pitchVel += (k * (wantPitch - this.pitch) - c * this.pitchVel) * dt;
    this.pitch += this.pitchVel * dt;
    this.rollVel += (k * (wantRoll - this.roll) - c * this.rollVel) * dt;
    this.roll += this.rollVel * dt;

    /* wheels */
    this.wheelSpin += (this.vLong / sp.tyreR) * dt;
    this.speedKmh = Math.abs(this.vLong) * 3.6;
    this.distance += Math.abs(this.vLong) * dt;
    if (this.speedKmh > this.topSpeed) this.topSpeed = this.speedKmh;
    this.accel = fLong / m;

    this.reverseLabel = this.reverse ? 'R' : String(this.gear);
    return this;
  }

  autopilot(dt) {
    const sp = this.spec;
    const s = -this.z;
    const off = (this.x - roadX(s)) * Math.sqrt(1 + roadD(s) ** 2);
    const laneErr = 1.8 - off;
    const wantYaw = roadYaw(s) + Math.atan2(-laneErr * 0.55, 16);
    const yawErr = wrapAngle(wantYaw - this.yaw);
    const steer = clamp(yawErr * 2.4 - this.yawRate * 0.35, -1, 1);
    const cruise = 100 / 3.6;
    const err = cruise - this.vLong;
    let throttle = clamp(err * 0.5, 0, 1);
    let brake = clamp(-err * 0.35, 0, 1);
    if (Math.abs(laneErr) > 4) { throttle *= 0.6; brake = Math.max(brake, 0.15); }
    return { throttle, brake, steer: clamp(steer, -0.7, 0.7) };
  }
}
