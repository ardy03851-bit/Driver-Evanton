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

    /* ── steering: speed-sensitive lock, rate limited ───────── */
    const lock = sp.steerLock * (1 - 0.64 * smoothstep(6, 68, speedKmh));
    const targetSteer = steerIn * lock;
    this.steer = damp(this.steer, targetSteer, steerIn === 0 ? 14 : 9.5, dt);
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
    if (this.reverse) driveForce = -clamp(this.brake * this.spec.mass * 3.2, 0, 9000);

    /* ── loads & traction limit ──────────────────────────────── */
    const m = sp.mass;
    const down = 0.5 * 1.2 * sp.downforce * speed * speed * 0.25;
    const transfer = m * this._axSmooth * 0.44 / sp.wheelbase;
    const FzF = Math.max(400, m * G * sp.distF - transfer + down * 0.42);
    const FzR = Math.max(400, m * G * (1 - sp.distF) + transfer + down * 0.58);
    const muF = sp.gripF * surf.grip;
    const muR = sp.gripR * surf.grip * (this.handbrake ? 0.48 : 1);

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

    let brakeForce = 0;
    const brakeCap = sp.brake * m * G * clamp(surf.grip, 0.35, 1) * 0.62;
    if (this.brake > 0.01) {
      const want = brakeCap * this.brake;
      const stopping = (Math.abs(this.vLong) * m) / Math.max(dt, 1 / 240);
      brakeForce = vSign * Math.min(want, stopping * 0.85);
    }
    if (this.handbrake) {
      const hb = (Math.abs(this.vLong) * m) / Math.max(dt, 1 / 240);
      brakeForce += vSign * Math.min(sp.brake * m * G * 0.42, hb * 0.55);
    }

    /* clutch at crawl: engine can't push through brakes */
    if (this.brake > 0.5 && Math.abs(this.vLong) < 0.35) driveForce = 0;

    let fLong = driveForce - drag - roll - engineBrake - brakeForce;

    /* reverse engagement */
    if (!this.reverse && brakeIn > 0.6 && speed < 0.35) {
      this.brakeHold += dt;
      if (this.brakeHold > 0.55) {
        this.reverse = true;
        this.gear = 1;
        this.brakeHold = 0;
      }
    } else if (!(brakeIn > 0.5 && speed < 0.4)) {
      this.brakeHold = 0;
    }
    if (this.reverse && (throttleIn > 0.15 || this.vLong > 0.15)) {
      this.reverse = false;
      this.gear = 1;
    }
    if (this.reverse) {
      // brake pedal is reverse throttle when already rolling back
      if (this.vLong < -3.2) fLong = Math.max(fLong, 0);
    }

    /* ── low speed stabilisation ────────────────────────────── */
    const lowBlend = 1 - smoothstep(1.6, 4.6, speed);
    const speedLong = Math.max(Math.abs(this.vLong), 0.85);

    /* ── tyre model ──────────────────────────────────────────── */
    const a = sp.wheelbase * (1 - sp.distF);
    const b = sp.wheelbase * sp.distF;
    const dir = this.vLong >= -0.2 ? 1 : -1;
    const alphaF = Math.atan2(this.vLat + this.yawRate * a, speedLong) - this.steer * dir;
    const alphaR = Math.atan2(this.vLat - this.yawRate * b, speedLong);
    this.slip = Math.max(Math.abs(alphaF), Math.abs(alphaR));

    const Fyf = -muF * FzF * Math.sin(1.36 * Math.atan(9.5 * alphaF));
    const Fyr = -muR * FzR * Math.sin(1.42 * Math.atan(9.0 * alphaR));

    const cos = Math.cos(this.steer);
    const Iz = m * (sp.wheelbase * sp.wheelbase * 0.21 + 1.35);
    let yawAcc = (a * Fyf * cos - b * Fyr) / Iz;
    // yaw damping + gentle stability control at the limit
    yawAcc -= this.yawRate * (0.9 + (1 - sp.tcs) * 2.2);

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

    // hard safety rails
    if (!isFinite(this.vLong) || !isFinite(this.vLat) || !isFinite(this.yawRate)) this.reset(40);
    this.vLong = clamp(this.vLong, -12, 125);
    this.vLat = clamp(this.vLat, -35, 35);

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

    const wantPitch = terrainPitch * 0.55 + clamp(this._axSmooth * 0.0055, -0.055, 0.055);
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
