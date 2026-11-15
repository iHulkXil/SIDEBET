/**
 * Cartoon 3D Penalty Shootout Engine Controller
 * Imported & customised from jainalokk/soccer.io src/game/Game.js (MIT License, Copyright (c) 2025 jainalokk)
 * Customized: Single behind-striker camera, dual Shot/Save goal area selection, and overlap-controlled save probability.
 */
import * as THREE from 'three';
import type { AssetManager } from '../assets/AssetManager';
import type {
  GoalRegion,
  MatchPhase,
  MatchStateSnapshot,
  ShootoutMatchConfig,
  ShotOutcome,
  ShotRecord,
  TeamConfig,
  TurnRole,
} from '../types';
import {
  Controls,
  DEFAULT_SAVE_REGION,
  DEFAULT_SHOT_REGION,
  type ShootPayload,
} from '../utils/Controls';
import {
  calculateGoalRegionOverlap,
  checkGoalLineCross,
} from '../utils/Physics';
import { Ball } from './Ball';
import { Goalkeeper } from './Goalkeeper';
import { Level } from './Level';
import { Player } from './Player';

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

export class Game {
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private resizeObserver: ResizeObserver | null = null;

  private level!: Level;
  private ball!: Ball;
  private player!: Player;
  private goalkeeper!: Goalkeeper;
  public controls: Controls;

  private config: ShootoutMatchConfig;
  private homeTeam: TeamConfig;
  private awayTeam: TeamConfig;

  private phase: MatchPhase = 'ready';
  private activeTeamIndex: 0 | 1 = 0; // 0 = Home kicking, 1 = Away kicking
  private activeControlRole: TurnRole = 'shoot';
  private round = 1;
  private kicksTaken: [number, number] = [0, 0];
  private scores: [number, number] = [0, 0];
  private history: ShotRecord[] = [];

  // Arcade 1..100 mode state (preserved from soccer.io)
  private currentLevel = 1;
  private readonly maxLevel = 100;
  private readonly levelGoalsRequired = 3;
  private readonly arcadeMaxShots = 5;
  private levelGoals = 0;
  private arcadeShotsTaken = 0;

  // Dual goal-region selection & overlap probability state
  private currentShotArea: GoalRegion = { ...DEFAULT_SHOT_REGION };
  private currentSaveArea: GoalRegion = { ...DEFAULT_SAVE_REGION };
  private revealShotArea = true;
  private revealSaveArea = false;
  private lastOverlapRatio: number | null = null;
  private lastSaveProbability: number | null = null;
  private pendingPassPlayShot: { shotArea: GoalRegion; power: number } | null = null;
  private shotWillBeSaved = false;
  private shotSaveTriggered = false;

  // Per-shot flags
  private shotResolved = false;
  private ballEnteredGoal = false;
  private goalNetImpacted = false;
  private ballFlightElapsed = 0;
  private lastShotSpeedKmh = 0;
  private countdownSeconds: number | null = null;
  private countdownTimerId: number | null = null;
  private lastOutcome: ShotOutcome | null = null;
  private statusMessage = 'Select your Shot Zone & hold Space or Shoot!';
  private subMessage = 'Best of 5 penalties + Sudden Death';
  private handoffNextPlayerLabel: string | null = null;
  private winnerTeamIndex: 0 | 1 | 'draw' | null = null;
  private winReason: string | null = null;

  // Single locked behind-striker camera angle
  private readonly fixedCamPos = new THREE.Vector3(0, 3.05, 18.2);
  private readonly fixedCamLookAt = new THREE.Vector3(0, 1.15, 0);
  private camTargetPos = new THREE.Vector3(0, 3.05, 18.2);
  private camLookAtCurrent = new THREE.Vector3(0, 1.15, 0);
  private camLookAtTarget = new THREE.Vector3(0, 1.15, 0);
  private cameraShake = 0;

  // Pre-allocated raycast helpers for clicking/dragging directly on 3D goal
  private raycaster = new THREE.Raycaster();
  private rayNdc = new THREE.Vector2();
  private goalPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private rayHitPoint = new THREE.Vector3();

  // Particles
  private particles: Particle[] = [];
  private particleGeo = new THREE.BoxGeometry(0.14, 0.14, 0.14);

  // Lifecycle & timers
  private rafId: number | null = null;
  private lastFrameTime = performance.now();
  private elapsedTime = 0;
  private activeTimers = new Set<number>();
  private disposed = false;

  private onStateChange?: (snapshot: MatchStateSnapshot) => void;
  private onMatchFinish?: (snapshot: MatchStateSnapshot) => void;

  constructor(options: {
    container: HTMLElement;
    assets: AssetManager;
    config: ShootoutMatchConfig;
    onStateChange?: (snapshot: MatchStateSnapshot) => void;
    onMatchFinish?: (snapshot: MatchStateSnapshot) => void;
  }) {
    this.container = options.container;
    this.assets = options.assets;
    this.config = options.config;
    this.onStateChange = options.onStateChange;
    this.onMatchFinish = options.onMatchFinish;

    this.homeTeam = this.assets.getTeam(this.config.homeTeamCode);
    this.awayTeam = this.assets.getTeam(this.config.awayTeamCode);
    this.assets.soundEnabled = this.config.soundEnabled;

    this.controls = new Controls();
    this.controls.setCallbacks({
      onShoot: (payload) => this.handlePlayerShoot(payload),
      onSaveConfirm: (saveArea) => this.handleSaveZoneConfirmed(saveArea),
      onChange: () => this.syncRegionsFromControls(),
    });

    this.createScene();
    this.initEntities();
    this.setupTurn(false);
    this.animate();
  }

  private container: HTMLElement;
  private assets: AssetManager;
  private isSoftwareGl = false;

  private detectSoftwareGl(): boolean {
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    } catch {
      return false;
    }
  }

  private handleContextLost = (e: Event) => {
    e.preventDefault();
  };

  private handleContextRestored = () => {
    this.onResize();
  };

  private createScene(): void {
    this.scene = new THREE.Scene();
    this.isSoftwareGl = this.detectSoftwareGl();

    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);

    this.camera = new THREE.PerspectiveCamera(62, width / height, 0.1, 400);
    this.camera.position.copy(this.fixedCamPos);
    this.camera.lookAt(this.fixedCamLookAt);

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.handleContextRestored);
    this.container.appendChild(this.renderer.domElement);

    this.resizeObserver = new ResizeObserver(() => this.onResize());
    this.resizeObserver.observe(this.container);
  }

  private onResize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  }

  private initEntities(): void {
    const stadium = this.assets.getStadium(this.config.stadiumId);
    const ballTheme = this.assets.getBallTheme(this.config.ballId);
    this.level = new Level(this.scene, this.assets, stadium, this.homeTeam, this.awayTeam);
    this.ball = new Ball(this.scene, this.assets, ballTheme);

    const homeStriker = this.assets.getCharacter(this.config.homeStrikerId);
    const awayKeeper = this.assets.getCharacter(this.config.awayKeeperId);

    this.player = new Player(this.scene, this.assets, this.controls, homeStriker, this.homeTeam);
    this.goalkeeper = new Goalkeeper(
      this.scene,
      this.assets,
      awayKeeper,
      this.awayTeam,
      this.getAdjustedDifficulty(),
    );

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }
  }

  private getAdjustedDifficulty(): number {
    if (this.config.mode === 'arcade-shoot' || this.config.mode === 'arcade-save') {
      return Math.min(100, this.config.difficulty + (this.currentLevel - 1) * 5);
    }
    return this.config.difficulty;
  }

  private scheduleTimer(fn: () => void, ms: number): number {
    const id = window.setTimeout(() => {
      this.activeTimers.delete(id);
      if (!this.disposed) fn();
    }, ms);
    this.activeTimers.add(id);
    return id;
  }

  private clearCountdownTimer(): void {
    if (this.countdownTimerId !== null) {
      window.clearTimeout(this.countdownTimerId);
      this.activeTimers.delete(this.countdownTimerId);
      this.countdownTimerId = null;
    }
  }

  private clearAllTimers(): void {
    this.clearCountdownTimer();
    this.activeTimers.forEach((id) => window.clearTimeout(id));
    this.activeTimers.clear();
  }

  private syncRegionsFromControls(): void {
    if (this.phase === 'ready' || this.phase === 'countdown') {
      if (this.controls.usePrimaryWasd) {
        this.currentShotArea = { ...this.controls.shotArea };
        this.currentSaveArea = { ...this.controls.saveArea };
      } else if (this.activeControlRole === 'shoot') {
        this.currentShotArea = { ...this.controls.shotArea };
      } else {
        this.currentSaveArea = { ...this.controls.saveArea };
      }
      this.level?.updateGoalZones(
        this.currentShotArea,
        this.currentSaveArea,
        this.revealShotArea,
        this.revealSaveArea,
      );
    }
    this.emitSnapshot();
  }

  public setSoundEnabled(enabled: boolean): void {
    this.config.soundEnabled = enabled;
    this.assets.soundEnabled = enabled;
  }

  public setActiveZoneFromNormalized(x: number, y: number, targetRole?: TurnRole): void {
    const role = targetRole ?? this.activeControlRole;
    if (role === 'shoot') {
      if (this.phase !== 'ready' || (this.activeControlRole !== 'shoot' && !this.controls.usePrimaryWasd)) {
        return;
      }
      this.controls.setShotAreaCenter(x, y);
    } else {
      if (
        (this.phase !== 'ready' && this.phase !== 'countdown') ||
        (this.activeControlRole !== 'save' && !this.controls.usePrimaryWasd)
      ) {
        return;
      }
      this.controls.setSaveAreaCenter(x, y);
    }
  }

  public setGoalZoneFromClientPoint(clientX: number, clientY: number, roleOverride?: TurnRole): void {
    if (!this.renderer || !this.level) return;
    if (this.phase !== 'ready' && this.phase !== 'countdown') return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    this.rayNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.rayNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.rayNdc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.goalPlane, this.rayHitPoint);
    if (!hit) return;

    const nx = THREE.MathUtils.clamp(hit.x / (this.level.goalWidth / 2), -1, 1);
    const ny = THREE.MathUtils.clamp((hit.y / this.level.goalHeight) * 2 - 1, -0.95, 0.95);
    this.setActiveZoneFromNormalized(nx, ny, roleOverride);
  }

  public startTouchPower(): void {
    if (this.phase !== 'ready' || this.activeControlRole !== 'shoot') return;
    this.controls.startPowerBar();
  }

  public releaseTouchShot(): void {
    if (this.phase !== 'ready' || this.activeControlRole !== 'shoot') return;
    this.controls.releaseShot();
  }

  public confirmTouchSaveZone(): void {
    if (this.activeControlRole !== 'save') return;
    if (this.phase !== 'ready' && this.phase !== 'countdown') return;
    this.handleSaveZoneConfirmed({ ...this.currentSaveArea });
  }

  public confirmHandoff(): void {
    if (this.phase !== 'handoff') return;
    this.handoffNextPlayerLabel = null;

    if (this.pendingPassPlayShot) {
      // Stage 2 of Local 2P Pass & Play: defending player selects Save Zone without seeing shot!
      this.phase = 'ready';
      this.activeControlRole = 'save';
      this.controls.role = 'save';
      this.controls.enabled = true;
      this.revealShotArea = false;
      this.revealSaveArea = true;
      this.player.setAimHelpersVisible(false);
      this.goalkeeper.setPlayerControlled(true);

      const defTeam = this.activeTeamIndex === 0 ? this.awayTeam : this.homeTeam;
      const defLabel = this.activeTeamIndex === 0 ? 'Player 2' : 'Player 1';
      this.statusMessage = `${defLabel} (${defTeam.shortName}) · Select Save Zone`;
      this.subMessage = 'Drag on goal or use Arrows, then Lock Save Zone to face the shot!';
      this.level.updateGoalZones(this.currentShotArea, this.currentSaveArea, false, true);
      this.assets.playSound('whistle');
      this.emitSnapshot();
      return;
    }

    if (this.activeControlRole === 'save') {
      this.startAiAutoShotCountdown();
    } else {
      this.phase = 'ready';
      this.controls.enabled = true;
      this.controls.resetState();
      this.currentShotArea = { ...this.controls.shotArea };
      this.currentSaveArea = { ...this.controls.saveArea };
      this.revealShotArea = true;
      this.revealSaveArea = false;
      this.level.updateGoalZones(this.currentShotArea, this.currentSaveArea, true, false);
      this.statusMessage =
        this.activeTeamIndex === 0
          ? `${this.homeTeam.shortName} (P1) · Select Shot Zone`
          : `${this.awayTeam.shortName} (P2) · Select Shot Zone`;
      this.subMessage = 'Position Shot Zone & hold Space / Shoot to strike!';
      this.assets.playSound('whistle');
      this.emitSnapshot();
    }
  }

  public advanceNextArcadeLevel(): void {
    if (this.phase !== 'level-complete') return;
    if (this.currentLevel < this.maxLevel) {
      this.currentLevel += 1;
    }
    this.levelGoals = 0;
    this.arcadeShotsTaken = 0;
    this.goalkeeper.setDifficulty(this.getAdjustedDifficulty());
    this.setupTurn(false);
  }

  public restartMatch(): void {
    this.clearAllTimers();
    this.round = 1;
    this.activeTeamIndex = 0;
    this.kicksTaken = [0, 0];
    this.scores = [0, 0];
    this.history = [];
    this.currentLevel = 1;
    this.levelGoals = 0;
    this.arcadeShotsTaken = 0;
    this.pendingPassPlayShot = null;
    this.lastOutcome = null;
    this.lastOverlapRatio = null;
    this.lastSaveProbability = null;
    this.winnerTeamIndex = null;
    this.winReason = null;
    this.goalkeeper.setDifficulty(this.getAdjustedDifficulty());
    this.setupTurn(false);
  }

  private async syncActiveKitsForTurn(): Promise<void> {
    const kickingTeam = this.activeTeamIndex === 0 ? this.homeTeam : this.awayTeam;
    const defendingTeam = this.activeTeamIndex === 0 ? this.awayTeam : this.homeTeam;
    const strikerProfile = this.assets.getCharacter(
      this.activeTeamIndex === 0 ? this.config.homeStrikerId : this.config.awayStrikerId,
    );
    const keeperProfile = this.assets.getCharacter(
      this.activeTeamIndex === 0 ? this.config.awayKeeperId : this.config.homeKeeperId,
    );

    await Promise.all([
      this.player.loadRig(strikerProfile, kickingTeam),
      this.goalkeeper.loadRig(keeperProfile, defendingTeam),
    ]);
  }

  private getKeeperZoneRadii(): { rx: number; ry: number } {
    const diff = this.getAdjustedDifficulty();
    return {
      rx: THREE.MathUtils.lerp(0.28, 0.36, diff / 100),
      ry: THREE.MathUtils.lerp(0.38, 0.48, diff / 100),
    };
  }

  private setupTurn(promptHandoff: boolean): void {
    this.clearCountdownTimer();
    this.ball.reset();
    this.player.reset();
    this.goalkeeper.reset();
    this.shotResolved = false;
    this.shotWillBeSaved = false;
    this.shotSaveTriggered = false;
    this.ballEnteredGoal = false;
    this.goalNetImpacted = false;
    this.ballFlightElapsed = 0;
    this.countdownSeconds = null;
    this.pendingPassPlayShot = null;
    this.lastOverlapRatio = null;
    this.lastSaveProbability = null;

    const { rx: saveRx, ry: saveRy } = this.getKeeperZoneRadii();
    this.controls.resetState(DEFAULT_SHOT_REGION.rx, DEFAULT_SHOT_REGION.ry, saveRx, saveRy);
    this.currentShotArea = { ...this.controls.shotArea };
    this.currentSaveArea = { ...this.controls.saveArea };

    const mode = this.config.mode;
    if (mode === 'arcade-shoot') {
      this.activeTeamIndex = 0;
      this.activeControlRole = 'shoot';
      this.controls.usePrimaryWasd = false;
      this.goalkeeper.setPlayerControlled(false);
      this.player.setAimHelpersVisible(true);
      this.revealShotArea = true;
      this.revealSaveArea = false;
    } else if (mode === 'arcade-save') {
      this.activeTeamIndex = 1;
      this.activeControlRole = 'save';
      this.controls.usePrimaryWasd = false;
      this.goalkeeper.setPlayerControlled(true);
      this.player.setAimHelpersVisible(false);
      this.revealShotArea = false;
      this.revealSaveArea = true;
    } else if (mode === 'shootout-ai') {
      this.activeControlRole = this.activeTeamIndex === 0 ? 'shoot' : 'save';
      this.controls.usePrimaryWasd = false;
      this.goalkeeper.setPlayerControlled(this.activeControlRole === 'save');
      this.player.setAimHelpersVisible(this.activeControlRole === 'shoot');
      this.revealShotArea = this.activeControlRole === 'shoot';
      this.revealSaveArea = this.activeControlRole === 'save';
    } else {
      // Local 2-Player mode (single behind-striker camera!)
      if (this.config.local2pStyle === 'simultaneous') {
        this.activeControlRole = 'shoot';
        this.controls.usePrimaryWasd = true;
        this.goalkeeper.setPlayerControlled(true);
        this.player.setAimHelpersVisible(true);
        this.revealShotArea = true;
        this.revealSaveArea = true;
      } else {
        this.activeControlRole = 'shoot';
        this.controls.usePrimaryWasd = false;
        this.goalkeeper.setPlayerControlled(true);
        this.player.setAimHelpersVisible(true);
        this.revealShotArea = true;
        this.revealSaveArea = false;
      }
    }

    this.controls.role = this.activeControlRole;
    this.updateCameraForRole();
    void this.syncActiveKitsForTurn();

    if (
      promptHandoff &&
      this.config.mode === 'local-2p' &&
      this.config.local2pStyle === 'pass-and-play'
    ) {
      const nextTeam = this.activeTeamIndex === 0 ? this.homeTeam : this.awayTeam;
      const pLabel = this.activeTeamIndex === 0 ? 'Player 1' : 'Player 2';
      this.phase = 'handoff';
      this.controls.enabled = false;
      this.revealShotArea = false;
      this.revealSaveArea = false;
      this.level.updateGoalZones(this.currentShotArea, this.currentSaveArea, false, false);
      this.handoffNextPlayerLabel = `${pLabel} · ${nextTeam.name} (Striker)`;
      this.statusMessage = `Pass Controls to ${pLabel}`;
      this.subMessage = `${nextTeam.name} penalty kick — Round ${this.round}`;
      this.emitSnapshot();
      return;
    }

    this.handoffNextPlayerLabel = null;
    this.level.updateGoalZones(
      this.currentShotArea,
      this.currentSaveArea,
      this.revealShotArea,
      this.revealSaveArea,
    );

    if (this.activeControlRole === 'save') {
      this.startAiAutoShotCountdown();
    } else {
      this.phase = 'ready';
      this.controls.enabled = true;
      const kickerTeam = this.activeTeamIndex === 0 ? this.homeTeam : this.awayTeam;
      if (this.config.mode === 'local-2p' && this.config.local2pStyle === 'simultaneous') {
        this.statusMessage = `${kickerTeam.shortName} vs ${
          this.activeTeamIndex === 0 ? this.awayTeam.shortName : this.homeTeam.shortName
        } · Simultaneous Zone Duel`;
        this.subMessage = 'Striker (Gold): WASD + Space · Keeper (Cyan): Arrow Keys';
      } else {
        this.statusMessage = `${kickerTeam.name} · Select Shot Zone`;
        this.subMessage = 'Drag on Goal or Pad · Hold Space / Shoot for power';
      }
      this.assets.playSound('whistle');
      this.emitSnapshot();
    }
  }

  private updateCameraForRole(): void {
    // Always maintain ONE camera angle behind the striker
    this.camTargetPos.copy(this.fixedCamPos);
    this.camLookAtTarget.copy(this.fixedCamLookAt);
  }

  private startAiAutoShotCountdown(): void {
    this.clearCountdownTimer();
    this.phase = 'countdown';
    this.controls.enabled = true;
    this.revealShotArea = false;
    this.revealSaveArea = true;
    this.level.updateGoalZones(this.currentShotArea, this.currentSaveArea, false, true);
    this.countdownSeconds = 4;
    this.statusMessage = 'Select Your Save Zone!';
    this.subMessage = 'Drag on Goal or Pad (or Press Space to Lock Save Now)';
    this.assets.playSound('tick');
    this.emitSnapshot();

    const step = (remaining: number) => {
      if (this.phase !== 'countdown') return;
      if (remaining <= 0) {
        this.countdownSeconds = null;
        this.triggerAiPenaltyKick({ ...this.currentSaveArea });
        return;
      }
      this.countdownSeconds = remaining;
      this.statusMessage = `Select Save Zone · Shot in ${remaining}...`;
      this.assets.playSound('tick');
      this.emitSnapshot();
      this.countdownTimerId = this.scheduleTimer(() => step(remaining - 1), 1000);
    };

    this.countdownTimerId = this.scheduleTimer(() => step(3), 1000);
  }

  private chooseAiShotArea(diff: number): { shotArea: GoalRegion; power: number } {
    // Higher difficulty aims sharper toward corners
    const cornerBias = THREE.MathUtils.lerp(0.45, 0.85, diff / 100);
    const x = (Math.random() * 2 - 1) * cornerBias;
    const y = THREE.MathUtils.clamp((Math.random() * 2 - 1) * 0.72, -0.75, 0.78);
    const power = THREE.MathUtils.clamp(0.58 + (diff / 100) * 0.34, 0.55, 0.96);
    return {
      shotArea: {
        x,
        y,
        rx: DEFAULT_SHOT_REGION.rx,
        ry: DEFAULT_SHOT_REGION.ry,
      },
      power,
    };
  }

  private chooseAiSaveArea(shotArea: GoalRegion, diff: number): GoalRegion {
    const { rx, ry } = this.getKeeperZoneRadii();
    // Higher difficulty = higher likelihood of reading near striker's selected shot zone
    const readAccuracy = THREE.MathUtils.lerp(0.28, 0.86, diff / 100);

    if (Math.random() < readAccuracy) {
      const jitterScale = (1 - readAccuracy) * 0.75;
      return {
        x: THREE.MathUtils.clamp(shotArea.x + (Math.random() * 2 - 1) * jitterScale, -0.82, 0.82),
        y: THREE.MathUtils.clamp(shotArea.y + (Math.random() * 2 - 1) * jitterScale * 0.8, -0.7, 0.75),
        rx,
        ry,
      };
    }

    // Keeper guesses a different corner/section
    const oppositeX = shotArea.x >= 0 ? -(0.3 + Math.random() * 0.5) : 0.3 + Math.random() * 0.5;
    const guessY = (Math.random() * 2 - 1) * 0.68;
    return {
      x: THREE.MathUtils.clamp(oppositeX, -0.82, 0.82),
      y: THREE.MathUtils.clamp(guessY, -0.7, 0.75),
      rx,
      ry,
    };
  }

  private triggerAiPenaltyKick(lockedSaveArea: GoalRegion): void {
    this.clearCountdownTimer();
    this.countdownSeconds = null;
    this.controls.enabled = false;
    const diff = this.getAdjustedDifficulty();
    const { shotArea, power } = this.chooseAiShotArea(diff);

    this.executePenaltyKick(shotArea, lockedSaveArea, power);
  }

  private handleSaveZoneConfirmed(saveArea: GoalRegion): void {
    if (this.activeControlRole !== 'save') return;
    this.currentSaveArea = { ...saveArea };

    if (this.phase === 'countdown') {
      // Human locked their Save Zone early against AI striker
      this.triggerAiPenaltyKick(this.currentSaveArea);
    } else if (this.phase === 'ready' && this.pendingPassPlayShot) {
      // Local 2P Pass & Play Stage 2 complete: P2 locked Save Zone -> execute shot!
      const shot = this.pendingPassPlayShot;
      this.pendingPassPlayShot = null;
      this.controls.enabled = false;
      this.executePenaltyKick(shot.shotArea, this.currentSaveArea, shot.power);
    }
  }

  private handlePlayerShoot(payload: ShootPayload): void {
    if (this.phase !== 'ready') return;

    this.currentShotArea = { ...payload.shotArea };

    // Local 2P Pass & Play: lock Striker's shot secretly, then hand off to Defender for Save Zone pick
    if (this.config.mode === 'local-2p' && this.config.local2pStyle === 'pass-and-play') {
      this.pendingPassPlayShot = {
        shotArea: { ...payload.shotArea },
        power: payload.power,
      };
      this.phase = 'handoff';
      this.controls.enabled = false;
      this.revealShotArea = false;
      this.revealSaveArea = false;
      this.level.updateGoalZones(this.currentShotArea, this.currentSaveArea, false, false);

      const defTeam = this.activeTeamIndex === 0 ? this.awayTeam : this.homeTeam;
      const defLabel = this.activeTeamIndex === 0 ? 'Player 2' : 'Player 1';
      this.handoffNextPlayerLabel = `${defLabel} · ${defTeam.name} (Keeper)`;
      this.statusMessage = `Shot Locked! Pass Controls to ${defLabel}`;
      this.subMessage = `${defLabel}: Pick your Save Zone on the goal without peeking!`;
      this.emitSnapshot();
      return;
    }

    this.controls.enabled = false;

    const diff = this.getAdjustedDifficulty();
    const chosenSaveArea =
      this.config.mode === 'local-2p' && this.config.local2pStyle === 'simultaneous'
        ? { ...this.controls.saveArea }
        : this.chooseAiSaveArea(this.currentShotArea, diff);

    this.executePenaltyKick(this.currentShotArea, chosenSaveArea, payload.power);
  }

  private executePenaltyKick(shotArea: GoalRegion, saveArea: GoalRegion, power: number): void {
    this.currentShotArea = { ...shotArea };
    this.currentSaveArea = { ...saveArea };
    this.revealShotArea = true;
    this.revealSaveArea = true;
    this.level.updateGoalZones(this.currentShotArea, this.currentSaveArea, true, true);

    const { overlapRatio, saveProbability } = calculateGoalRegionOverlap(
      this.currentShotArea,
      this.currentSaveArea,
    );
    this.lastOverlapRatio = overlapRatio;
    this.lastSaveProbability = saveProbability;

    this.phase = 'running-up';
    this.statusMessage = 'Striker Running Up!';
    this.subMessage = `Zone Overlap: ${Math.round(overlapRatio * 100)}% · Save Chance: ${Math.round(saveProbability * 100)}%`;
    this.emitSnapshot();

    this.player.startRunUp(() => {
      this.launchBall(this.currentShotArea, this.currentSaveArea, power, saveProbability);
    });
  }

  private launchBall(
    shotArea: GoalRegion,
    saveArea: GoalRegion,
    power: number,
    saveProbability: number,
  ): void {
    this.phase = 'ball-flight';
    this.ballFlightElapsed = 0;
    this.shotResolved = false;
    this.shotSaveTriggered = false;
    this.ballEnteredGoal = false;

    // Sample landing point inside the selected Shot Zone
    const normX = shotArea.x + (Math.random() * 2 - 1) * shotArea.rx * 0.42;
    const normY = shotArea.y + (Math.random() * 2 - 1) * shotArea.ry * 0.42;

    const worldX = normX * (this.level.goalWidth / 2);
    const worldY = Math.max(0.24, ((normY + 1) / 2) * this.level.goalHeight);

    const halfW = this.level.goalWidth / 2;
    const isOnTarget =
      Math.abs(worldX) < halfW - 0.18 &&
      worldY >= 0.12 &&
      worldY < this.level.goalHeight - 0.14;

    // Save probability strictly controlled by shotArea/saveArea overlap on on-target shots
    this.shotWillBeSaved = isOnTarget && Math.random() < saveProbability;

    this.ball.kickToTarget({ x: worldX, y: worldY }, power);
    this.lastShotSpeedKmh = this.ball.getSpeedKmh();
    this.assets.playSound('kick');

    // Keeper dives cleanly to the center of their selected Save Zone
    this.scheduleTimer(() => {
      if (this.phase === 'ball-flight' && !this.shotResolved) {
        this.goalkeeper.diveToGoalRegion(saveArea, this.level.goalWidth, this.level.goalHeight);
      }
    }, 55);

    this.emitSnapshot();
  }

  private spawnBurst(pos: THREE.Vector3, colors: string[], count = 26): void {
    const gradient = this.assets.getToonGradientMap();
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshToonMaterial({
        color: colors[i % colors.length],
        gradientMap: gradient,
      });
      const mesh = new THREE.Mesh(this.particleGeo, mat);
      mesh.position.copy(pos);
      const speed = 2.5 + Math.random() * 5.5;
      const angle = Math.random() * Math.PI * 2;
      const vel = new THREE.Vector3(
        Math.cos(angle) * speed,
        2.5 + Math.random() * 5.0,
        Math.sin(angle) * speed,
      );
      this.scene.add(mesh);
      this.particles.push({ mesh, vel, life: 0, maxLife: 0.9 + Math.random() * 0.6 });
    }
  }

  private resolveShot(outcome: ShotOutcome): void {
    if (this.shotResolved) return;
    this.shotResolved = true;
    this.lastOutcome = outcome;
    this.phase = 'shot-result';
    this.controls.enabled = false;
    this.revealShotArea = true;
    this.revealSaveArea = true;
    this.level.updateGoalZones(this.currentShotArea, this.currentSaveArea, true, true);

    const isGoal = outcome === 'goal';
    this.player.playOutcomeReaction(isGoal);
    this.goalkeeper.playOutcomeReaction(outcome === 'saved');

    if (outcome === 'goal') {
      this.assets.playSound('goal');
      this.level.triggerCrowdCheer(1.0);
      const kickingTeam = this.activeTeamIndex === 0 ? this.homeTeam : this.awayTeam;
      this.spawnBurst(
        new THREE.Vector3(this.ball.getPosition().x, 1.4, -0.5),
        [kickingTeam.primaryColor, '#FACC15', '#FFFFFF'],
        34,
      );
    } else if (outcome === 'saved') {
      this.assets.playSound('save');
      this.level.triggerCrowdCheer(0.6);
      this.cameraShake = 0.14;
      this.spawnBurst(
        new THREE.Vector3(this.goalkeeper.getPosition().x, 1.1, 0),
        ['#38BDF8', '#4ADE80', '#FFFFFF'],
        20,
      );
    } else {
      this.assets.playSound('miss');
    }

    const overlapPct =
      this.lastOverlapRatio !== null ? Math.round(this.lastOverlapRatio * 100) : 0;
    const saveProbPct =
      this.lastSaveProbability !== null ? Math.round(this.lastSaveProbability * 100) : 0;

    // Record kick & update scores
    const kickingTeam = this.activeTeamIndex === 0 ? this.homeTeam : this.awayTeam;
    if (this.config.mode === 'arcade-shoot' || this.config.mode === 'arcade-save') {
      this.arcadeShotsTaken += 1;
      const playerSucceeded =
        (this.config.mode === 'arcade-shoot' && outcome === 'goal') ||
        (this.config.mode === 'arcade-save' && outcome !== 'goal');
      if (playerSucceeded) {
        this.scores[0] += 1;
        this.levelGoals += 1;
      } else {
        this.scores[1] += 1;
      }

      this.history.push({
        round: this.arcadeShotsTaken,
        teamIndex: this.activeTeamIndex,
        teamCode: kickingTeam.shortName,
        outcome,
        isSuddenDeath: false,
        shotSpeedKmh: this.lastShotSpeedKmh,
        overlapPct,
        saveProbPct,
      });

      this.statusMessage =
        outcome === 'goal'
          ? this.config.mode === 'arcade-save'
            ? 'BEATEN! AI SCORES'
            : 'GOAL!'
          : outcome === 'saved'
          ? this.config.mode === 'arcade-save'
            ? 'WHAT A SAVE!'
            : 'SAVED BY KEEPER!'
          : 'OFF TARGET!';
      this.subMessage = `${this.lastShotSpeedKmh} km/h · Overlap ${overlapPct}% (${saveProbPct}% save chance) · Lv ${this.currentLevel}`;
      this.emitSnapshot();

      this.scheduleTimer(() => this.advanceArcadeState(), 2100);
      return;
    }

    // Shootout Match (5 penalties per team + Sudden Death)
    this.kicksTaken[this.activeTeamIndex] += 1;
    if (outcome === 'goal') {
      this.scores[this.activeTeamIndex] += 1;
    }

    this.history.push({
      round: this.round,
      teamIndex: this.activeTeamIndex,
      teamCode: kickingTeam.shortName,
      outcome,
      isSuddenDeath: this.round > 5,
      shotSpeedKmh: this.lastShotSpeedKmh,
      overlapPct,
      saveProbPct,
    });

    this.statusMessage =
      outcome === 'goal'
        ? `${kickingTeam.shortName} SCORES!`
        : outcome === 'saved'
        ? 'SAVED!'
        : 'MISSED!';
    this.subMessage = `${this.homeTeam.shortName} ${this.scores[0]} - ${this.scores[1]} ${this.awayTeam.shortName} · Overlap ${overlapPct}% (${saveProbPct}% save prob)`;
    this.emitSnapshot();

    this.scheduleTimer(() => this.advanceShootoutState(), 2100);
  }

  private advanceArcadeState(): void {
    if (this.arcadeShotsTaken >= this.arcadeMaxShots) {
      if (this.levelGoals >= this.levelGoalsRequired) {
        this.phase = 'level-complete';
        this.assets.playSound('win');
        this.statusMessage = `Level ${this.currentLevel} Cleared!`;
        this.subMessage = `${this.levelGoals}/${this.arcadeMaxShots} successful plays`;
        this.emitSnapshot();
      } else {
        this.phase = 'match-over';
        this.winnerTeamIndex = 1;
        this.winReason = `Arcade Run Ended at Level ${this.currentLevel} (${this.levelGoals}/${this.levelGoalsRequired} needed)`;
        this.statusMessage = 'Arcade Run Complete';
        this.subMessage = this.winReason;
        this.emitSnapshot();
        this.onMatchFinish?.(this.getSnapshot());
      }
      return;
    }

    this.setupTurn(false);
  }

  private advanceShootoutState(): void {
    const [k0, k1] = this.kicksTaken;
    const [s0, s1] = this.scores;

    // 1. Best-of-5 early clinch check
    if (this.round <= 5) {
      const rem0 = 5 - k0;
      const rem1 = 5 - k1;
      if (s0 > s1 + rem1) {
        this.finishMatch(0, `${this.homeTeam.name} wins ${s0}-${s1} with an insurmountable lead!`);
        return;
      }
      if (s1 > s0 + rem0) {
        this.finishMatch(1, `${this.awayTeam.name} wins ${s1}-${s0} with an insurmountable lead!`);
        return;
      }
      // End of round 5 with winner
      if (k0 === 5 && k1 === 5 && s0 !== s1) {
        const winner: 0 | 1 = s0 > s1 ? 0 : 1;
        const winTeam = winner === 0 ? this.homeTeam : this.awayTeam;
        this.finishMatch(winner, `${winTeam.name} wins ${s0}-${s1} after 5 penalties!`);
        return;
      }
    } else {
      // 2. Sudden death check (only resolve after both teams took equal kicks in SD round)
      if (k0 === k1 && s0 !== s1) {
        const winner: 0 | 1 = s0 > s1 ? 0 : 1;
        const winTeam = winner === 0 ? this.homeTeam : this.awayTeam;
        this.finishMatch(
          winner,
          `${winTeam.name} wins ${s0}-${s1} in Sudden Death (Round ${this.round})!`,
        );
        return;
      }
    }

    // Advance turn
    if (this.activeTeamIndex === 0) {
      this.activeTeamIndex = 1;
    } else {
      this.activeTeamIndex = 0;
      this.round += 1;
    }

    this.setupTurn(true);
  }

  private finishMatch(winnerIndex: 0 | 1, reason: string): void {
    this.phase = 'match-over';
    this.winnerTeamIndex = winnerIndex;
    this.winReason = reason;
    this.controls.enabled = false;
    this.statusMessage =
      winnerIndex === 0 ? `${this.homeTeam.name} Wins!` : `${this.awayTeam.name} Wins!`;
    this.subMessage = reason;
    this.assets.playSound('win');
    this.level.triggerCrowdCheer(1.3);
    this.emitSnapshot();
    this.onMatchFinish?.(this.getSnapshot());
  }

  private animate = (): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.animate);

    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    this.elapsedTime += dt;

    this.updateScene(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private updateScene(dt: number): void {
    this.level.update(dt, this.elapsedTime);
    this.player.update(dt);
    this.goalkeeper.update(dt);

    if (this.phase === 'ball-flight') {
      this.ballFlightElapsed += dt;

      const hitNet = this.ball.update(dt, this.level.getGoalBounds(), this.ballEnteredGoal);
      if (hitNet && !this.goalNetImpacted) {
        this.goalNetImpacted = true;
        this.level.triggerNetRipple(this.ball.getPosition().x, this.ball.getPosition().y, 0.72);
      }

      if (!this.shotResolved) {
        const ballPos = this.ball.getPosition();

        // 1. Overlap-determined save right as ball approaches goal line
        if (this.shotWillBeSaved && !this.shotSaveTriggered && ballPos.z <= 0.45) {
          this.shotSaveTriggered = true;
          this.ball.velocity.z = Math.abs(this.ball.velocity.z) * 0.42 + 4.0;
          this.ball.velocity.x += (ballPos.x >= this.goalkeeper.getPosition().x ? 1 : -1) * 4.2;
          this.ball.velocity.y = Math.max(2.0, Math.abs(this.ball.velocity.y) * 0.45);
          this.resolveShot('saved');
          return;
        }

        // 2. Swept goal-line crossing & post/crossbar collision check
        const crossCheck = checkGoalLineCross(
          this.ball.previousPosition,
          { x: ballPos.x, y: ballPos.y, z: ballPos.z },
          this.level.getGoalBounds(),
          this.ball.radius,
        );

        if (crossCheck.hitPost || crossCheck.hitCrossbar) {
          this.assets.playSound('post');
          this.cameraShake = 0.18;
          this.ball.velocity.z = Math.abs(this.ball.velocity.z) * 0.55;
          if (crossCheck.hitPost) {
            this.ball.velocity.x = -this.ball.velocity.x * 0.65;
          }
          if (crossCheck.hitCrossbar) {
            this.ball.velocity.y = -Math.abs(this.ball.velocity.y) * 0.5;
          }
          this.ball.mesh.position.z = Math.max(this.ball.mesh.position.z, 0.25);
        } else if (crossCheck.crossed) {
          this.ballEnteredGoal = true;
          this.level.triggerNetRipple(crossCheck.crossX, crossCheck.crossY, 0.75);
          this.resolveShot('goal');
          return;
        }

        // 3. Missed shot bounds
        if (
          ballPos.z < -2.4 ||
          Math.abs(ballPos.x) > 12 ||
          !this.ball.isMoving ||
          this.ballFlightElapsed > 2.4
        ) {
          this.resolveShot('missed');
        }
      }
    } else {
      this.ball.update(dt, this.level.getGoalBounds(), this.ballEnteredGoal);
    }

    // Update confetti/spark particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      p.vel.y -= 11 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += dt * 7;
      p.mesh.rotation.y += dt * 6;
      const scale = Math.max(0, 1 - p.life / p.maxLife);
      p.mesh.scale.setScalar(scale);
      if (p.life >= p.maxLife) {
        this.scene.remove(p.mesh);
        (p.mesh.material as THREE.Material).dispose();
        this.particles.splice(i, 1);
      }
    }

    // Smooth camera lerp on the single behind-striker perspective + subtle shake on impact
    const lerpAlpha = Math.min(1, dt * 6.5);
    this.camera.position.lerp(this.camTargetPos, lerpAlpha);
    this.camLookAtCurrent.lerp(this.camLookAtTarget, lerpAlpha);
    if (this.cameraShake > 0.002) {
      this.cameraShake *= Math.pow(0.02, dt);
      this.camera.position.x += (Math.random() - 0.5) * this.cameraShake;
      this.camera.position.y += (Math.random() - 0.5) * this.cameraShake;
    }
    this.camera.lookAt(this.camLookAtCurrent);
  }

  public getSnapshot(): MatchStateSnapshot {
    return {
      phase: this.phase,
      mode: this.config.mode,
      local2pStyle: this.config.local2pStyle,
      activeTeamIndex: this.activeTeamIndex,
      activeControlRole: this.activeControlRole,
      round: this.round,
      isSuddenDeath: this.round > 5,
      kicksTaken: [...this.kicksTaken],
      scores: [...this.scores],
      history: [...this.history],
      currentLevel: this.currentLevel,
      maxLevel: this.maxLevel,
      levelGoals: this.levelGoals,
      levelGoalsRequired: this.levelGoalsRequired,
      arcadeShotsTaken: this.arcadeShotsTaken,
      arcadeMaxShots: this.arcadeMaxShots,
      power: this.controls.power,
      isPowerActive: this.controls.isPowerActive,
      aimDirection: { x: this.currentShotArea.x, y: this.currentShotArea.y },
      shotArea: { ...this.currentShotArea },
      saveArea: { ...this.currentSaveArea },
      revealShotArea: this.revealShotArea,
      revealSaveArea: this.revealSaveArea,
      lastOverlapRatio: this.lastOverlapRatio,
      lastSaveProbability: this.lastSaveProbability,
      countdownSeconds: this.countdownSeconds,
      lastOutcome: this.lastOutcome,
      statusMessage: this.statusMessage,
      subMessage: this.subMessage,
      handoffNextPlayerLabel: this.handoffNextPlayerLabel,
      winnerTeamIndex: this.winnerTeamIndex,
      winReason: this.winReason,
    };
  }

  private emitSnapshot(): void {
    this.onStateChange?.(this.getSnapshot());
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.clearAllTimers();
    this.controls.dispose();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    for (const p of this.particles) {
      this.scene.remove(p.mesh);
      (p.mesh.material as THREE.Material).dispose();
    }
    this.particles = [];
    this.particleGeo.dispose();

    this.player.dispose();
    this.goalkeeper.dispose();
    this.ball.dispose();
    this.level.dispose();

    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
