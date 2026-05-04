import { z } from 'zod';

/**
 * dapp / chain address sent from UI. trims and rejects non-strings at parse time so we fail with
 * "address required" instead of zod `invalid_type` when a caller passes undefined or the wrong shape.
 */
export const trpcAddressParam = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : ''),
  z.string().min(1, 'address required'),
);
