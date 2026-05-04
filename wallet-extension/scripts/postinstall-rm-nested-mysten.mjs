/**
 * @ika.xyz/sdk may nest @mysten/sui; we hoist a single copy (pin in package.json overrides).
 * npm may still leave a nested copy under @ika.xyz/sdk/node_modules/@mysten/sui,
 * which shadows the hoisted package and breaks resolution. remove it after install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nested = path.join(__dirname, '../node_modules/@ika.xyz/sdk/node_modules/@mysten');
if (fs.existsSync(nested)) {
  fs.rmSync(nested, { recursive: true, force: true });
  console.log('[chromatika] removed nested @mysten under @ika.xyz/sdk (use hoisted @mysten/sui)');
}
