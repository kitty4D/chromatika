/**
 * ensures tutorial screenshots exist under public/images/rich-user-guide.
 * ships a tiny 1x1 placeholder only when the file is missing so local copies or real PNGs win.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIR = path.join(ROOT, "public", "images", "rich-user-guide");

/** names referenced from src/data/tutorial-data.ts */
const EXPECTED_PNG = [
  "01-onboarding.png",
  "02-vault-home.png",
  "03-send.png",
  "04-activity.png",
  "05-assets.png",
  "06-dwallets.png",
  "07-ika-staking.png",
  "08-payments.png",
  "09-policy-vault.png",
  "10-agents.png",
  "11-chroma-lab.png",
  "12-policy-prompt.png",
];

/** 1x1 transparent PNG */
const MINI_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

fs.mkdirSync(DIR, { recursive: true });

let wrote = 0;
for (const name of EXPECTED_PNG) {
  const fp = path.join(DIR, name);
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(fp, MINI_PNG);
    wrote++;
  }
}

if (wrote > 0) {
  console.log(`ensure-rich-guide-images: wrote ${wrote} placeholder png(s); replace with real captures when ready`);
}
