#!/usr/bin/env node
/**
 * setup.mjs
 *
 * registers chromatika-mcp-host as a chrome native messaging host on the current OS.
 *
 * usage:
 *   node setup.mjs --extension-id=<id> [--browser=chrome|edge|brave|chromium]
 *
 * what it does:
 *   - macos / linux: writes the host manifest JSON into the browser's NativeMessagingHosts dir.
 *   - windows: writes a .bat shim that invokes node + the .mjs host, then registers a HKCU
 *     registry value pointing at the manifest. windows requires the registered host path to be
 *     an executable; node + .mjs needs the shim.
 *   - chmod +x the host script on unix.
 *
 * the resulting manifest restricts allowed_origins to the chromatika extension id you pass.
 * find that id in chrome://extensions for your unpacked install.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HOST_NAME = 'com.chromatika.mcp.host';
const HOST_SCRIPT = resolve(__dirname, 'chromatika-mcp-host.mjs');
const WIN_SHIM_PATH = resolve(__dirname, 'chromatika-mcp-host.bat');
const LOCAL_MANIFEST_PATH = resolve(__dirname, `${HOST_NAME}.json`);

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    out[m[1]] = m[2] ?? true;
  }
  return out;
}

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error('usage: node setup.mjs --extension-id=<chrome-extension-id> [--browser=chrome|edge|brave|chromium]');
  console.error();
  console.error('the extension id is the 32-char string chrome shows in chrome://extensions');
  console.error('for the unpacked chromatika install.');
  process.exit(2);
}

const args = parseArgs();
const extensionId = typeof args['extension-id'] === 'string' ? args['extension-id'] : null;
if (!extensionId || !/^[a-p]{32}$/i.test(extensionId)) {
  usage('--extension-id is required (32 chars, a-p)');
}

const browser = (args.browser ?? 'chrome').toString();

const supportedBrowsers = ['chrome', 'edge', 'brave', 'chromium'];
if (!supportedBrowsers.includes(browser)) {
  usage(`--browser must be one of: ${supportedBrowsers.join(', ')}`);
}

const os = platform();
const hostBinaryPath = os === 'win32' ? WIN_SHIM_PATH : HOST_SCRIPT;

const manifest = {
  name: HOST_NAME,
  description: 'Chromatika wallet bridge for MCP-style external clients',
  path: hostBinaryPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

writeFileSync(LOCAL_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

let installTarget = null;

if (os === 'darwin') {
  const browserDir = browserToMacDir(browser);
  const dir = resolve(homedir(), 'Library/Application Support', browserDir, 'NativeMessagingHosts');
  mkdirSync(dir, { recursive: true });
  installTarget = join(dir, `${HOST_NAME}.json`);
  writeFileSync(installTarget, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
} else if (os === 'linux') {
  const browserDir = browserToLinuxDir(browser);
  const dir = resolve(homedir(), '.config', browserDir, 'NativeMessagingHosts');
  mkdirSync(dir, { recursive: true });
  installTarget = join(dir, `${HOST_NAME}.json`);
  writeFileSync(installTarget, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
} else if (os === 'win32') {
  // chrome on windows can't run a .mjs directly; spawn node + the script via a .bat shim.
  const batBody = '@echo off\r\nnode "' + HOST_SCRIPT + '" %*\r\n';
  writeFileSync(WIN_SHIM_PATH, batBody, 'utf8');

  // chrome reads the host manifest path from this HKCU registry value.
  const regBase = browserToWinRegBase(browser);
  const regKey = `${regBase}\\${HOST_NAME}`;
  try {
    execFileSync(
      'reg',
      ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', LOCAL_MANIFEST_PATH, '/f'],
      { stdio: 'inherit' },
    );
  } catch (e) {
    console.error(`reg add failed: ${e?.message ?? e}`);
    process.exit(1);
  }
  installTarget = `${regKey} -> ${LOCAL_MANIFEST_PATH}`;
} else {
  console.error(`unsupported platform: ${os}`);
  process.exit(1);
}

if (os !== 'win32') {
  try {
    chmodSync(HOST_SCRIPT, 0o755);
  } catch {
    /* not fatal - user can chmod later if needed */
  }
}

console.log('chromatika native messaging host registered.');
console.log(`  host name:    ${HOST_NAME}`);
console.log(`  host binary:  ${hostBinaryPath}`);
console.log(`  manifest:     ${LOCAL_MANIFEST_PATH}`);
console.log(`  installed at: ${installTarget}`);
console.log(`  extension id: ${extensionId}`);
console.log(`  browser:      ${browser}`);
console.log();
console.log('next: open chromatika settings → agents and toggle the surface on (next slice).');

function browserToMacDir(b) {
  switch (b) {
    case 'edge':
      return 'Microsoft Edge';
    case 'brave':
      return 'BraveSoftware/Brave-Browser';
    case 'chromium':
      return 'Chromium';
    case 'chrome':
    default:
      return 'Google/Chrome';
  }
}

function browserToLinuxDir(b) {
  switch (b) {
    case 'edge':
      return 'microsoft-edge';
    case 'brave':
      return 'BraveSoftware/Brave-Browser';
    case 'chromium':
      return 'chromium';
    case 'chrome':
    default:
      return 'google-chrome';
  }
}

function browserToWinRegBase(b) {
  switch (b) {
    case 'edge':
      return 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts';
    case 'brave':
      return 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts';
    case 'chromium':
      return 'HKCU\\Software\\Chromium\\NativeMessagingHosts';
    case 'chrome':
    default:
      return 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts';
  }
}
