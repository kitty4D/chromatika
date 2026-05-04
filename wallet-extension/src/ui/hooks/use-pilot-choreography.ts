import { useEffect, useRef, useState } from 'react';
import {
  headSymbolId,
  isCrewPilot,
  type PilotPose,
  type RocketHeadId,
} from '@/ui/components/rocket-heads';

/** easy to tune */
export const ROLL_INTERVAL_MS = 10_000;
/** base plan: ~20m / ~60m avg at mult 1; higher = more frequent peeks (9 ≈ 3× the previous default of 3) */
const ROLL_PROB_MULT = 9;
const SIDE_PROB_PER_TICK = (ROLL_PROB_MULT * 10_000) / (20 * 60_000);
const FRONT_PROB_PER_TICK = (ROLL_PROB_MULT * 10_000) / (60 * 60_000);
const FADE_DURATION_MS = 500;
const HOLD_MIN_MS = 4000;
const HOLD_MAX_MS = 8000;
const RISE_DURATION_MS = 2000;
const PEEK_DURATION_MS = 2000;
const SPOOK_CHANCE = 0.3;
const SPOOK_SNAP_MS = 300;
const RISE_SPOOK_AT_MS = RISE_DURATION_MS * 0.8;
const PEEK_SPOOK_AT_MS = PEEK_DURATION_MS * 0.8;
const RISE_SPOOK_REDO_MS = 800;
const PEEK_SPOOK_REDO_MS = 2000;

export type SeatChoreoPhase = 'idle' | 'fadeOut' | 'active' | 'fadeToBack';

export type SeatAnimState = {
  symbolId: string;
  flipX: boolean;
  opacity: number;
  offsetX: number;
  offsetY: number;
  phase: SeatChoreoPhase;
};

type PhaseKind = 'toActive' | 'toBack';

type MicroState =
  | null
  | {
      kind: 'front' | 'side';
      spook: boolean;
      spookPhase: 'none' | 'snap' | 'redo';
      spookPhaseStartMs: number;
    };

type SeatMachine = {
  phase: 'idle' | 'fadeOut' | 'active' | 'fadeToBack';
  fadeKind: PhaseKind | null;
  phaseStartMs: number;
  pose: PilotPose;
  /** symbol id used while fading out */
  fadeSymbolId: string;
  pendingPose: PilotPose | null;
  opacity: number;
  offsetX: number;
  offsetY: number;
  /** slide direction for fade (pixels at end of fade) */
  fadeSlideX: number;
  fadeSlideY: number;
  micro: MicroState;
  holdUntilMs: number | null;
};

function randHoldMs(): number {
  return HOLD_MIN_MS + Math.random() * (HOLD_MAX_MS - HOLD_MIN_MS);
}

function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - (1 - x) ** 3;
}

function effectiveLockPose(m: SeatMachine, headId: RocketHeadId): PilotPose {
  if (!isCrewPilot(headId)) return 'back';
  if (m.phase === 'idle') return m.pose;
  if (m.phase === 'active') return m.pose;
  if (m.phase === 'fadeOut' && m.fadeKind === 'toActive') {
    return m.pendingPose ?? m.pose;
  }
  if (m.phase === 'fadeOut' && m.fadeKind === 'toBack') return m.pose;
  if (m.phase === 'fadeToBack') return m.pose;
  return m.pose;
}

function createIdleMachine(headId: RocketHeadId): SeatMachine {
  return {
    phase: 'idle',
    fadeKind: null,
    phaseStartMs: 0,
    pose: 'back',
    fadeSymbolId: headSymbolId(headId, 'back'),
    pendingPose: null,
    opacity: 1,
    offsetX: 0,
    offsetY: 0,
    fadeSlideX: 0,
    fadeSlideY: 0,
    micro: null,
    holdUntilMs: null,
  };
}

function computeFrontMicroOffsets(
  micro: NonNullable<MicroState>,
  nowMs: number,
  phaseStartMs: number,
): { ox: number; oy: number; microDone: boolean } {
  const spook = micro.spook;
  let oy = 15;
  let microDone = false;

  if (!spook) {
    const t = Math.min(1, (nowMs - phaseStartMs) / RISE_DURATION_MS);
    oy = 15 * (1 - easeOutCubic(t));
    microDone = t >= 1;
    return { ox: 0, oy, microDone };
  }

  if (micro.spookPhase === 'none') {
    const elapsed = nowMs - phaseStartMs;
    if (elapsed < RISE_SPOOK_AT_MS) {
      const t = elapsed / RISE_SPOOK_AT_MS;
      oy = 15 * (1 - easeOutCubic(t));
    } else {
      oy = 15;
      micro.spookPhase = 'snap';
      micro.spookPhaseStartMs = nowMs;
    }
    return { ox: 0, oy, microDone: false };
  }

  if (micro.spookPhase === 'snap') {
    const w = nowMs - micro.spookPhaseStartMs;
    oy = 15;
    if (w >= SPOOK_SNAP_MS) {
      micro.spookPhase = 'redo';
      micro.spookPhaseStartMs = nowMs;
    }
    return { ox: 0, oy, microDone: false };
  }

  const redoT = Math.min(1, (nowMs - micro.spookPhaseStartMs) / RISE_SPOOK_REDO_MS);
  oy = 15 * (1 - easeOutCubic(redoT));
  microDone = redoT >= 1;
  return { ox: 0, oy, microDone };
}

function computeSideMicroOffsets(
  micro: NonNullable<MicroState>,
  nowMs: number,
  phaseStartMs: number,
  driver: boolean,
): { ox: number; oy: number; microDone: boolean } {
  const sign = driver ? 1 : -1;
  const spook = micro.spook;
  let ox = -8 * sign;
  let microDone = false;

  const range = 16 * sign;

  if (!spook) {
    const t = Math.min(1, (nowMs - phaseStartMs) / PEEK_DURATION_MS);
    ox = -8 * sign + range * easeOutCubic(t);
    microDone = t >= 1;
    return { ox, oy: 0, microDone };
  }

  if (micro.spookPhase === 'none') {
    const elapsed = nowMs - phaseStartMs;
    if (elapsed < PEEK_SPOOK_AT_MS) {
      const t = elapsed / PEEK_SPOOK_AT_MS;
      ox = -8 * sign + range * easeOutCubic(t);
    } else {
      ox = -8 * sign;
      micro.spookPhase = 'snap';
      micro.spookPhaseStartMs = nowMs;
    }
    return { ox, oy: 0, microDone: false };
  }

  if (micro.spookPhase === 'snap') {
    const w = nowMs - micro.spookPhaseStartMs;
    ox = -8 * sign;
    if (w >= SPOOK_SNAP_MS) {
      micro.spookPhase = 'redo';
      micro.spookPhaseStartMs = nowMs;
    }
    return { ox, oy: 0, microDone: false };
  }

  const redoT = Math.min(1, (nowMs - micro.spookPhaseStartMs) / PEEK_SPOOK_REDO_MS);
  ox = -8 * sign + range * easeOutCubic(redoT);
  microDone = redoT >= 1;
  return { ox, oy: 0, microDone };
}

function tickSeat(
  m: SeatMachine,
  headId: RocketHeadId,
  nowMs: number,
  driver: boolean,
): void {
  if (!isCrewPilot(headId)) return;

  if (m.phase === 'fadeOut') {
    const elapsed = nowMs - m.phaseStartMs;
    const u = Math.min(1, elapsed / FADE_DURATION_MS);
    m.opacity = 1 - u;
    m.offsetX = m.fadeSlideX * u;
    m.offsetY = m.fadeSlideY * u;
    if (u < 1) return;

    if (m.fadeKind === 'toActive' && m.pendingPose) {
      m.phase = 'active';
      m.fadeKind = null;
      m.pose = m.pendingPose;
      m.pendingPose = null;
      m.opacity = 1;
      m.offsetX = 0;
      m.offsetY = 0;
      m.phaseStartMs = nowMs;
      const spook = Math.random() < SPOOK_CHANCE;
      if (m.pose === 'front') {
        m.micro = {
          kind: 'front',
          spook,
          spookPhase: 'none',
          spookPhaseStartMs: nowMs,
        };
        m.offsetY = 15;
      } else {
        m.micro = {
          kind: 'side',
          spook,
          spookPhase: 'none',
          spookPhaseStartMs: nowMs,
        };
        m.offsetX = driver ? -8 : 8;
      }
      m.holdUntilMs = null;
      return;
    }

    if (m.fadeKind === 'toBack') {
      m.phase = 'idle';
      m.pose = 'back';
      m.fadeKind = null;
      m.pendingPose = null;
      m.opacity = 1;
      m.offsetX = 0;
      m.offsetY = 0;
      m.micro = null;
      m.holdUntilMs = null;
      m.fadeSymbolId = headSymbolId(headId, 'back');
    }
    return;
  }

  if (m.phase === 'active') {
    const microStart = m.phaseStartMs;
    if (m.micro?.kind === 'front') {
      const { ox, oy, microDone } = computeFrontMicroOffsets(m.micro, nowMs, microStart);
      m.offsetX = ox;
      m.offsetY = oy;
      if (microDone) {
        m.micro = null;
        m.holdUntilMs = nowMs + randHoldMs();
      }
      return;
    }
    if (m.micro?.kind === 'side') {
      const { ox, oy, microDone } = computeSideMicroOffsets(m.micro, nowMs, microStart, driver);
      m.offsetX = ox;
      m.offsetY = oy;
      if (microDone) {
        m.micro = null;
        m.holdUntilMs = nowMs + randHoldMs();
      }
      return;
    }

    if (m.holdUntilMs !== null && nowMs >= m.holdUntilMs) {
      m.phase = 'fadeOut';
      m.fadeKind = 'toBack';
      m.phaseStartMs = nowMs;
      m.fadeSymbolId = headSymbolId(headId, m.pose);
      const slide =
        m.pose === 'side'
          ? { x: driver ? -6 : 6, y: 0 }
          : { x: 0, y: 6 };
      m.fadeSlideX = slide.x;
      m.fadeSlideY = slide.y;
      m.opacity = 1;
      m.offsetX = 0;
      m.offsetY = 0;
      m.holdUntilMs = null;
    }
  }
}

function tryRoll(
  m: SeatMachine,
  headId: RocketHeadId,
  other: SeatMachine,
  otherHeadId: RocketHeadId,
  nowMs: number,
  driver: boolean,
): void {
  if (!isCrewPilot(headId)) return;
  if (m.phase !== 'idle' || m.pose !== 'back') return;

  const r = Math.random();
  let target: PilotPose | null = null;
  if (r < SIDE_PROB_PER_TICK) target = 'side';
  else if (r < SIDE_PROB_PER_TICK + FRONT_PROB_PER_TICK) target = 'front';
  else return;

  const lockOther = effectiveLockPose(other, otherHeadId);
  if (target === 'side' && lockOther === 'side') return;
  if (target === 'front' && lockOther === 'front') return;

  m.phase = 'fadeOut';
  m.fadeKind = 'toActive';
  m.phaseStartMs = nowMs;
  m.fadeSymbolId = headSymbolId(headId, 'back');
  m.pendingPose = target;
  m.opacity = 1;
  m.offsetX = 0;
  m.offsetY = 0;
  if (target === 'side') {
    m.fadeSlideX = driver ? 6 : -6;
    m.fadeSlideY = 0;
  } else {
    m.fadeSlideX = 0;
    m.fadeSlideY = 6;
  }
}

function machineToOutput(m: SeatMachine, headId: RocketHeadId, driver: boolean): SeatAnimState {
  if (!isCrewPilot(headId)) {
    return {
      symbolId: headSymbolId(headId, 'back'),
      flipX: false,
      opacity: 1,
      offsetX: 0,
      offsetY: 0,
      phase: 'idle',
    };
  }

  let symbolId: string;
  if (m.phase === 'fadeOut' && m.fadeKind === 'toActive') {
    symbolId = m.fadeSymbolId;
  } else if (m.phase === 'fadeOut' && m.fadeKind === 'toBack') {
    symbolId = m.fadeSymbolId;
  } else {
    symbolId = headSymbolId(headId, m.pose);
  }

  const showPassengerSideFlip =
    !driver &&
    m.pose === 'side' &&
    (m.phase === 'active' ||
      (m.phase === 'fadeOut' && m.fadeKind === 'toBack'));

  const flipX = showPassengerSideFlip;

  let phaseOut: SeatChoreoPhase = 'idle';
  if (m.phase === 'fadeOut' && m.fadeKind === 'toBack') phaseOut = 'fadeToBack';
  else if (m.phase === 'fadeOut') phaseOut = 'fadeOut';
  else if (m.phase === 'active') phaseOut = 'active';

  return {
    symbolId,
    flipX,
    opacity: m.opacity,
    offsetX: m.offsetX,
    offsetY: m.offsetY,
    phase: phaseOut,
  };
}

export function usePilotChoreography(
  pilot: RocketHeadId,
  passenger: RocketHeadId,
  animationsOn: boolean,
): { driver: SeatAnimState; passenger: SeatAnimState } {
  const driverRef = useRef(createIdleMachine(pilot));
  const passengerRef = useRef(createIdleMachine(passenger));
  const [, setTick] = useState(0);

  useEffect(() => {
    driverRef.current = createIdleMachine(pilot);
    passengerRef.current = createIdleMachine(passenger);
    setTick((t) => t + 1);
  }, [pilot, passenger]);

  useEffect(() => {
    if (!animationsOn) {
      driverRef.current = createIdleMachine(pilot);
      passengerRef.current = createIdleMachine(passenger);
      setTick((t) => t + 1);
      return;
    }

    const pilotCrew = isCrewPilot(pilot);
    const passengerCrew = isCrewPilot(passenger);
    if (!pilotCrew && !passengerCrew) {
      driverRef.current = createIdleMachine(pilot);
      passengerRef.current = createIdleMachine(passenger);
      setTick((t) => t + 1);
      return;
    }

    let raf = 0;
    let rollTimer: ReturnType<typeof setInterval> | undefined;

    const loop = (nowMs: number) => {
      const d = driverRef.current;
      const p = passengerRef.current;

      tickSeat(d, pilot, nowMs, true);
      tickSeat(p, passenger, nowMs, false);

      setTick((t) => t + 1);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);

    rollTimer = setInterval(() => {
      const nowMs = performance.now();
      const d = driverRef.current;
      const p = passengerRef.current;
      if (pilotCrew) tryRoll(d, pilot, p, passenger, nowMs, true);
      if (passengerCrew) tryRoll(p, passenger, d, pilot, nowMs, false);
    }, ROLL_INTERVAL_MS);

    return () => {
      cancelAnimationFrame(raf);
      if (rollTimer) clearInterval(rollTimer);
    };
  }, [pilot, passenger, animationsOn]);

  const driverState = machineToOutput(driverRef.current, pilot, true);
  const passengerState = machineToOutput(passengerRef.current, passenger, false);

  if (!animationsOn) {
    return {
      driver: {
        symbolId: headSymbolId(pilot, 'back'),
        flipX: false,
        opacity: 1,
        offsetX: 0,
        offsetY: 0,
        phase: 'idle',
      },
      passenger: {
        symbolId: headSymbolId(passenger, 'back'),
        flipX: false,
        opacity: 1,
        offsetX: 0,
        offsetY: 0,
        phase: 'idle',
      },
    };
  }

  return { driver: driverState, passenger: passengerState };
}
