/**
 * Unified Keyboard, Dual-Player & Mobile Touch Controls
 * Preserved from jainalokk/soccer.io src/utils/Controls.js (MIT License)
 * Extended with frame-rate-independent power bar, simultaneous 2P bindings (WASD+Space vs Arrows+Enter),
 * and mobile touch/pointer controls.
 */
import type { GoalRegion } from '../types';
import type { Vec2 } from './Physics';

export interface ShootPayload {
  direction: Vec2;
  shotArea: GoalRegion;
  power: number;
}

export const DEFAULT_SHOT_REGION: GoalRegion = { x: 0, y: 0.12, rx: 0.26, ry: 0.36 };
export const DEFAULT_SAVE_REGION: GoalRegion = { x: 0, y: 0.12, rx: 0.32, ry: 0.42 };

function clampZoneCenter(val: number, halfSpan: number, minEdge: number, maxEdge: number): number {
  return Math.max(minEdge + halfSpan * 0.35, Math.min(maxEdge - halfSpan * 0.35, val));
}

export class Controls {
  private keys: Record<string, boolean> = {};

  public direction: Vec2 = { x: 0, y: 0.12 };
  public shotArea: GoalRegion = { ...DEFAULT_SHOT_REGION };
  public saveArea: GoalRegion = { ...DEFAULT_SAVE_REGION };

  public power = 0;
  public powerDirection = 1;
  public isPowerActive = false;
  public enabled = true;
  public role: 'shoot' | 'save' = 'shoot';
  public usePrimaryWasd = false; // True in simultaneous 2P mode: WASD+Space = Striker, Arrows = Keeper

  private lastPowerTickTime = 0;
  private powerRafId: number | null = null;
  private steerRafId: number | null = null;
  private lastSteerTime = 0;

  private onShoot: ((payload: ShootPayload) => void) | null = null;
  private onSaveConfirm: ((saveArea: GoalRegion) => void) | null = null;
  private onChange: (() => void) | null = null;

  constructor() {
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._updatePowerBar = this._updatePowerBar.bind(this);
    this._updateKeyboardSteer = this._updateKeyboardSteer.bind(this);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  setCallbacks(callbacks: {
    onShoot?: (payload: ShootPayload) => void;
    onSaveConfirm?: (saveArea: GoalRegion) => void;
    onChange?: () => void;
  }): void {
    this.onShoot = callbacks.onShoot ?? null;
    this.onSaveConfirm = callbacks.onSaveConfirm ?? null;
    this.onChange = callbacks.onChange ?? null;
  }

  setShotAreaCenter(nx: number, ny: number): void {
    const x = clampZoneCenter(nx, this.shotArea.rx, -1.02, 1.02);
    const y = clampZoneCenter(ny, this.shotArea.ry, -0.92, 0.96);
    this.shotArea = { ...this.shotArea, x, y };
    this.direction = { x, y };
    this.onChange?.();
  }

  setSaveAreaCenter(nx: number, ny: number): void {
    const x = clampZoneCenter(nx, this.saveArea.rx, -0.96, 0.96);
    const y = clampZoneCenter(ny, this.saveArea.ry, -0.88, 0.92);
    this.saveArea = { ...this.saveArea, x, y };
    this.onChange?.();
  }

  setAimDirection(dir: Vec2): void {
    this.setShotAreaCenter(dir.x, dir.y);
  }

  startPowerBar(): void {
    if (!this.enabled || this.role !== 'shoot' || this.isPowerActive) return;
    this.isPowerActive = true;
    this.power = 0.08;
    this.powerDirection = 1;
    this.lastPowerTickTime = performance.now();
    this.onChange?.();
    this._updatePowerBar();
  }

  releaseShot(): void {
    if (!this.isPowerActive) return;
    this.isPowerActive = false;
    if (this.powerRafId !== null) {
      cancelAnimationFrame(this.powerRafId);
      this.powerRafId = null;
    }
    const shotPower = Math.max(0.25, this.power);
    const areaSnapshot = { ...this.shotArea };
    const shotDir = { x: areaSnapshot.x, y: areaSnapshot.y };
    this.power = 0;
    this.onChange?.();
    this.onShoot?.({ direction: shotDir, shotArea: areaSnapshot, power: shotPower });
  }

  confirmSaveZone(): void {
    if (!this.enabled || this.role !== 'save') return;
    this.onSaveConfirm?.({ ...this.saveArea });
  }

  resetState(shotRx = DEFAULT_SHOT_REGION.rx, shotRy = DEFAULT_SHOT_REGION.ry, saveRx = DEFAULT_SAVE_REGION.rx, saveRy = DEFAULT_SAVE_REGION.ry): void {
    this.isPowerActive = false;
    this.power = 0;
    this.powerDirection = 1;
    this.shotArea = { x: 0, y: 0.12, rx: shotRx, ry: shotRy };
    this.saveArea = { x: 0, y: 0.12, rx: saveRx, ry: saveRy };
    this.direction = { x: 0, y: 0.12 };
    this.keys = {};
    if (this.powerRafId !== null) {
      cancelAnimationFrame(this.powerRafId);
      this.powerRafId = null;
    }
    if (this.steerRafId !== null) {
      cancelAnimationFrame(this.steerRafId);
      this.steerRafId = null;
    }
    this.onChange?.();
  }

  private _updatePowerBar(): void {
    if (!this.isPowerActive) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastPowerTickTime) / 1000);
    this.lastPowerTickTime = now;

    this.power += 1.35 * dt * this.powerDirection;
    if (this.power >= 1) {
      this.power = 1;
      this.powerDirection = -1;
    } else if (this.power <= 0.08) {
      this.power = 0.08;
      this.powerDirection = 1;
    }
    this.onChange?.();
    this.powerRafId = requestAnimationFrame(this._updatePowerBar);
  }

  private _ensureSteerLoop(): void {
    if (this.steerRafId !== null) return;
    this.lastSteerTime = performance.now();
    this.steerRafId = requestAnimationFrame(this._updateKeyboardSteer);
  }

  private _updateKeyboardSteer(): void {
    if (!this.enabled) {
      this.steerRafId = null;
      return;
    }

    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastSteerTime) / 1000);
    this.lastSteerTime = now;
    const speed = 1.85; // Normalized units per second across goal face

    let moved = false;

    if (this.usePrimaryWasd) {
      // Simultaneous 2P: WASD steers Striker shotArea, Arrow keys steer Keeper saveArea
      const sx = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
      const sy = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
      if (sx !== 0 || sy !== 0) {
        this.setShotAreaCenter(this.shotArea.x + sx * speed * dt, this.shotArea.y + sy * speed * dt);
        moved = true;
      }

      const kx = (this.keys['ArrowRight'] ? 1 : 0) - (this.keys['ArrowLeft'] ? 1 : 0);
      const ky = (this.keys['ArrowUp'] ? 1 : 0) - (this.keys['ArrowDown'] ? 1 : 0);
      if (kx !== 0 || ky !== 0) {
        this.setSaveAreaCenter(this.saveArea.x + kx * speed * dt, this.saveArea.y + ky * speed * dt);
        moved = true;
      }
    } else {
      const dx =
        (this.keys['KeyD'] || this.keys['ArrowRight'] ? 1 : 0) -
        (this.keys['KeyA'] || this.keys['ArrowLeft'] ? 1 : 0);
      const dy =
        (this.keys['KeyW'] || this.keys['ArrowUp'] ? 1 : 0) -
        (this.keys['KeyS'] || this.keys['ArrowDown'] ? 1 : 0);

      if (dx !== 0 || dy !== 0) {
        if (this.role === 'shoot') {
          this.setShotAreaCenter(this.shotArea.x + dx * speed * dt, this.shotArea.y + dy * speed * dt);
        } else {
          this.setSaveAreaCenter(this.saveArea.x + dx * speed * dt, this.saveArea.y + dy * speed * dt);
        }
        moved = true;
      }
    }

    if (moved) {
      this.steerRafId = requestAnimationFrame(this._updateKeyboardSteer);
    } else {
      this.steerRafId = null;
    }
  }

  private _onKeyDown(event: KeyboardEvent): void {
    if (!this.enabled) return;
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    const code = event.code;
    const isGameKey =
      code.startsWith('Arrow') ||
      code === 'Space' ||
      code === 'Enter' ||
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyS' ||
      code === 'KeyD';
    if (isGameKey) {
      event.preventDefault();
    }

    this.keys[code] = true;

    if (this.role === 'shoot' && code === 'Space' && !event.repeat) {
      this.startPowerBar();
    } else if (this.role === 'save' && (code === 'Space' || code === 'Enter') && !event.repeat) {
      this.confirmSaveZone();
    }

    if (
      code.startsWith('Arrow') ||
      code === 'KeyW' ||
      code === 'KeyA' ||
      code === 'KeyS' ||
      code === 'KeyD'
    ) {
      this._ensureSteerLoop();
    }
  }

  private _onKeyUp(event: KeyboardEvent): void {
    const code = event.code;
    this.keys[code] = false;

    if (this.role === 'shoot' && code === 'Space') {
      this.releaseShot();
    }
  }

  dispose(): void {
    this.resetState();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
