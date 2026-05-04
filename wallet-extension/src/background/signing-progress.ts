/**
 * lightweight progress reporting for long-running signing flows.
 * background writes steps here; the popup polls via tRPC.
 */

export type SigningStep =
  | 'preparing'
  | 'fetching-gas'
  | 'building-tx'
  | 'taking-presign'
  | 'waiting-presign'
  | 'building-ika-tx'
  | 'executing-ika-tx'
  | 'waiting-signature'
  | 'solana-grpc-secp-sign'
  | 'waiting-hardware'
  | 'recovering-v'
  | 'broadcasting'
  | 'done'
  | 'error';

export type SigningProgress = {
  step: SigningStep;
  detail?: string;
  startedAt: number;
  updatedAt: number;
};

let current: SigningProgress | null = null;

export function setSigningProgress(step: SigningStep, detail?: string): void {
  const now = Date.now();
  current = {
    step,
    detail,
    startedAt: current?.startedAt ?? now,
    updatedAt: now,
  };
}

export function clearSigningProgress(): void {
  current = null;
}

export function getSigningProgress(): SigningProgress | null {
  return current;
}

/** human-readable label for each step. */
export function stepLabel(step: SigningStep): string {
  switch (step) {
    case 'preparing': return 'preparing transaction';
    case 'fetching-gas': return 'fetching gas estimates';
    case 'building-tx': return 'building unsigned transaction';
    case 'taking-presign': return 'reserving presign slot';
    case 'waiting-presign': return 'waiting for presign completion';
    case 'building-ika-tx': return 'building ika signing request';
    case 'executing-ika-tx': return 'submitting to ika network';
    case 'waiting-signature': return 'waiting for mpc signature';
    case 'solana-grpc-secp-sign': return 'signing via Solana gRPC (secp)';
    case 'waiting-hardware': return 'confirm on hardware wallet';
    case 'recovering-v': return 'recovering signature params';
    case 'broadcasting': return 'broadcasting to network';
    case 'done': return 'complete';
    case 'error': return 'failed';
  }
}
