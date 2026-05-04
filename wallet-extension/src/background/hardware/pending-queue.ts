/**
 * in-memory queue for hardware sign requests that need a popup + device interaction.
 * the background parks here; the popup polls/resolves when the user confirms on-device.
 */

import { getPopupPosition } from '../popup-position';
import { validateHardwareSignRequestPayload } from './pending-hardware-sign-contract';
import type { PendingHardwareSign } from './types';

const queue = new Map<string, PendingHardwareSign>();
let nextId = 1;

const HW_POPUP_WIDTH = 420;

export function enqueueHardwareSign(
  req: Omit<PendingHardwareSign, 'id' | 'resolve' | 'reject'>,
): Promise<string> {
  validateHardwareSignRequestPayload(req);
  return new Promise((resolve, reject) => {
    const id = `hsign-${Date.now()}-${nextId++}`;
    queue.set(id, { ...req, id, resolve, reject });

    void (async () => {
      const pos = await getPopupPosition(HW_POPUP_WIDTH);
      chrome.windows.create({
        url: chrome.runtime.getURL(`index.html?hwsign=${encodeURIComponent(id)}`),
        type: 'popup',
        width: HW_POPUP_WIDTH,
        height: 560,
        ...pos,
      });
    })();
  });
}

export function getPendingHardwareSign(id: string): PendingHardwareSign | undefined {
  return queue.get(id);
}

export function resolvePendingHardwareSign(id: string, signature: string): void {
  const r = queue.get(id);
  if (!r) throw new Error(`No pending hardware sign request: ${id}`);
  queue.delete(id);
  r.resolve(signature);
}

export function rejectPendingHardwareSign(id: string, message: string): void {
  const r = queue.get(id);
  if (!r) throw new Error(`No pending hardware sign request: ${id}`);
  queue.delete(id);
  r.reject(new Error(message));
}

export function getPendingHardwareSignMeta(id: string) {
  const r = queue.get(id);
  if (!r) return null;
  const { resolve: _resolve, reject: _reject, ...meta } = r;
  return meta;
}
