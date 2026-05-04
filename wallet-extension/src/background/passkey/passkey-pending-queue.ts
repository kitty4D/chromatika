/**
 * in-memory queue for passkey requests that need a popup + webauthn user gesture.
 * background side parks here; the popup polls/resolves when the user authorizes via the os
 * passkey dialog. mirrors `hardware/pending-queue.ts` exactly so the two pipelines can share
 * the same review patterns.
 */

import { getPopupPosition } from '../popup-position';
import type {
  PendingPasskeyRecover,
  PendingPasskeyRegister,
  PendingPasskeySign,
  PasskeyAssertionPayload,
  PasskeyRecoverPayload,
  PasskeyRegisterPayload,
} from './passkey-types';

const PASSKEY_POPUP_WIDTH = 420;
const PASSKEY_POPUP_HEIGHT = 540;

const registerQueue = new Map<string, PendingPasskeyRegister>();
const signQueue = new Map<string, PendingPasskeySign>();
const recoverQueue = new Map<string, PendingPasskeyRecover>();
let nextRegisterId = 1;
let nextSignId = 1;
let nextRecoverId = 1;

/**
 * park a register request and open the popup. resolves once the popup successfully runs
 * `navigator.credentials.create` + the prf eval; rejects if the popup is closed without a
 * payload or the os passkey dialog errors.
 */
export function enqueuePasskeyRegister(
  req: Omit<PendingPasskeyRegister, 'id' | 'resolve' | 'reject'>,
): Promise<PasskeyRegisterPayload> {
  return new Promise((resolve, reject) => {
    const id = `pkreg-${Date.now()}-${nextRegisterId++}`;
    registerQueue.set(id, { ...req, id, resolve, reject });
    void openPasskeyPopup(`passkeyregister=${encodeURIComponent(id)}`);
  });
}

export function getPendingPasskeyRegister(id: string): PendingPasskeyRegister | undefined {
  return registerQueue.get(id);
}

export function getPendingPasskeyRegisterMeta(id: string) {
  const r = registerQueue.get(id);
  if (!r) return null;
  const { resolve: _r, reject: _j, ...meta } = r;
  return meta;
}

export function resolvePendingPasskeyRegister(id: string, payload: PasskeyRegisterPayload): void {
  const r = registerQueue.get(id);
  if (!r) throw new Error(`No pending passkey register request: ${id}`);
  registerQueue.delete(id);
  r.resolve(payload);
}

export function rejectPendingPasskeyRegister(id: string, message: string): void {
  const r = registerQueue.get(id);
  if (!r) throw new Error(`No pending passkey register request: ${id}`);
  registerQueue.delete(id);
  r.reject(new Error(message));
}

export function enqueuePasskeySign(
  req: Omit<PendingPasskeySign, 'id' | 'resolve' | 'reject'>,
): Promise<PasskeyAssertionPayload> {
  return new Promise((resolve, reject) => {
    const id = `pksign-${Date.now()}-${nextSignId++}`;
    signQueue.set(id, { ...req, id, resolve, reject });
    void openPasskeyPopup(`passkeysign=${encodeURIComponent(id)}`);
  });
}

export function getPendingPasskeySign(id: string): PendingPasskeySign | undefined {
  return signQueue.get(id);
}

export function getPendingPasskeySignMeta(id: string) {
  const r = signQueue.get(id);
  if (!r) return null;
  const { resolve: _r, reject: _j, ...meta } = r;
  return meta;
}

export function resolvePendingPasskeySign(id: string, payload: PasskeyAssertionPayload): void {
  const r = signQueue.get(id);
  if (!r) throw new Error(`No pending passkey sign request: ${id}`);
  signQueue.delete(id);
  r.resolve(payload);
}

export function rejectPendingPasskeySign(id: string, message: string): void {
  const r = signQueue.get(id);
  if (!r) throw new Error(`No pending passkey sign request: ${id}`);
  signQueue.delete(id);
  r.reject(new Error(message));
}

export function enqueuePasskeyRecover(
  req: Omit<PendingPasskeyRecover, 'id' | 'resolve' | 'reject'>,
): Promise<PasskeyRecoverPayload> {
  return new Promise((resolve, reject) => {
    const id = `pkrec-${Date.now()}-${nextRecoverId++}`;
    recoverQueue.set(id, { ...req, id, resolve, reject });
    void openPasskeyPopup(`passkeyrecover=${encodeURIComponent(id)}`);
  });
}

export function getPendingPasskeyRecover(id: string): PendingPasskeyRecover | undefined {
  return recoverQueue.get(id);
}

export function getPendingPasskeyRecoverMeta(id: string) {
  const r = recoverQueue.get(id);
  if (!r) return null;
  const { resolve: _r, reject: _j, ...meta } = r;
  return meta;
}

export function resolvePendingPasskeyRecover(id: string, payload: PasskeyRecoverPayload): void {
  const r = recoverQueue.get(id);
  if (!r) throw new Error(`No pending passkey recover request: ${id}`);
  recoverQueue.delete(id);
  r.resolve(payload);
}

export function rejectPendingPasskeyRecover(id: string, message: string): void {
  const r = recoverQueue.get(id);
  if (!r) throw new Error(`No pending passkey recover request: ${id}`);
  recoverQueue.delete(id);
  r.reject(new Error(message));
}

async function openPasskeyPopup(query: string): Promise<void> {
  const pos = await getPopupPosition(PASSKEY_POPUP_WIDTH);
  chrome.windows.create({
    url: chrome.runtime.getURL(`index.html?${query}`),
    type: 'popup',
    width: PASSKEY_POPUP_WIDTH,
    height: PASSKEY_POPUP_HEIGHT,
    ...pos,
  });
}
