import type { ReactNode } from 'react';

export const ROCKET_HEAD_IDS = [
  'pilot-david',
  'pilot-toly',
  'pilot-adeniyi',
] as const;

export type RocketHeadId = (typeof ROCKET_HEAD_IDS)[number];

/** cockpit + settings dropdown labels */
export const ROCKET_HEAD_LABELS: Record<RocketHeadId, string> = {
  'pilot-david': 'david',
  'pilot-toly': 'toly',
  'pilot-adeniyi': 'adeniyi',
};

/** front portrait for settings preview; cockpit uses `-b` raster in symbols */
export function pilotFrontPreviewHref(headId: string): string | null {
  switch (headId) {
    case 'pilot-adeniyi':
      return '/pilots/adeniyi-f.png';
    case 'pilot-david':
      return '/pilots/david-f.png';
    case 'pilot-toly':
      return '/pilots/toly-f.png';
    default:
      return null;
  }
}

export type PilotPose = 'back' | 'side' | 'front';

const CREW_SLUG: Record<string, string> = {
  'pilot-adeniyi': 'adeniyi',
  'pilot-david': 'david',
  'pilot-toly': 'toly',
};

export function isCrewPilot(headId: string): boolean {
  return headId in CREW_SLUG;
}

export function crewSlug(headId: string): string | null {
  return CREW_SLUG[headId] ?? null;
}

export function headSymbolId(headId: RocketHeadId, pose: PilotPose): string {
  if (pose !== 'back' && isCrewPilot(headId)) {
    return `head-${headId}-${pose === 'side' ? 's' : 'f'}`;
  }
  return `head-${headId}`;
}

/** crew-only pool: pick a passenger that is not the same as the pilot when possible. */
export function pickPassengerHead(now = new Date(), pilot?: RocketHeadId): RocketHeadId {
  void now;
  const others = ROCKET_HEAD_IDS.filter((id) => id !== pilot);
  const pool = others.length > 0 ? others : (ROCKET_HEAD_IDS as readonly RocketHeadId[]);
  return pool[Math.floor(Math.random() * pool.length)] ?? 'pilot-toly';
}

/** inline SVG symbols for <use href="#head-pilot-david" /> */
export function RocketHeadDefs(): ReactNode {
  return (
    <defs>
      {/* crew pilots: back */}
      <symbol id="head-pilot-adeniyi" viewBox="0 0 64 64">
        <image href="/pilots/adeniyi-b.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
      <symbol id="head-pilot-david" viewBox="0 0 64 64">
        <image href="/pilots/david-b.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
      <symbol id="head-pilot-toly" viewBox="0 0 64 64">
        <image href="/pilots/toly-b.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
      {/* crew pilots: side (drawn from driver seat, flip for passenger) */}
      <symbol id="head-pilot-adeniyi-s" viewBox="0 0 64 64">
        <image href="/pilots/adeniyi-s.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
      <symbol id="head-pilot-david-s" viewBox="0 0 64 64">
        <image href="/pilots/david-s.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
      <symbol id="head-pilot-toly-s" viewBox="0 0 64 64">
        <image href="/pilots/toly-s.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
      {/* crew pilots: front */}
      <symbol id="head-pilot-adeniyi-f" viewBox="0 0 64 64">
        <image href="/pilots/adeniyi-f.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
      <symbol id="head-pilot-david-f" viewBox="0 0 64 64">
        <image href="/pilots/david-f.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
      <symbol id="head-pilot-toly-f" viewBox="0 0 64 64">
        <image href="/pilots/toly-f.png" width="64" height="64" preserveAspectRatio="xMidYMid meet" />
      </symbol>
    </defs>
  );
}

export function isRocketHeadId(id: string): id is RocketHeadId {
  return (ROCKET_HEAD_IDS as readonly string[]).includes(id);
}

/** new-user defaults: David is the pilot, Toly rides shotgun. */
export const DEFAULT_PILOT_HEAD: RocketHeadId = 'pilot-david';
export const DEFAULT_PASSENGER_HEAD: RocketHeadId = 'pilot-toly';
