// real JS bridge that hosts ika SDK state inside the seeker app's WebView. kotlin host
// installs `chromatikaBridge.send(json)` via @JavascriptInterface; this module exposes
// `window.handle(json)` so kotlin can invoke methods over the WebView.evaluateJavascript
// transport. RPC envelope shape lives in types.ts.

import { IkaClient, UserShareEncryptionKeys, getNetworkConfig, Curve } from '@ika.xyz/sdk';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { IkaRequest, IkaResult, IkaInitRequest, BaseChain, CurveLabel } from './types';

declare global {
  interface Window {
    handle?: (raw: string) => Promise<void>;
  }
  // eslint-disable-next-line no-var
  var chromatikaBridge: { send(json: string): void } | undefined;
}

/* ----------------------------------------------------------------------------
 * module-scope state
 *
 * the bridge keeps the ika client + per-curve UserShareEncryptionKeys around for the
 * lifetime of the WebView. kotlin destroys the WebView when the foreground signing
 * service goes idle, which is what we want; otherwise re-init is a no-op if the same
 * params come back.
 * ---------------------------------------------------------------------------- */

interface SuiBaseState {
  baseChain: 'sui';
  network: string;
  suiClient: SuiGraphQLClient;
  ikaClient: IkaClient;
  // user share encryption keys are curve-specific; we cache one per curve as needed.
  userKeysByCurve: Partial<Record<CurveLabel, UserShareEncryptionKeys>>;
  rootSeedBytes: Uint8Array;
}

interface SolanaBaseState {
  baseChain: 'solana';
  network: string;
  rootSeedBytes: Uint8Array;
  // gRPC client wiring lands in the next iteration alongside @ika.xyz/pre-alpha-solana-client.
}

type State = SuiBaseState | SolanaBaseState | null;

let state: State = null;

/* ----------------------------------------------------------------------------
 * helpers
 * ---------------------------------------------------------------------------- */

function reply(result: IkaResult): void {
  globalThis.chromatikaBridge?.send(JSON.stringify(result));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function curveFromLabel(label: CurveLabel): Curve {
  switch (label) {
    case 'SECP256K1':
      return Curve.SECP256K1;
    case 'ED25519':
      return Curve.ED25519;
  }
}

function notImplemented(method: string, reason: string): Error {
  return Object.assign(new Error(`${method}: ${reason}`), { code: 'not_implemented' });
}

/* ----------------------------------------------------------------------------
 * ika_init
 *
 * sui base: instantiate IkaClient + SuiGraphQLClient against the configured network.
 *           ensureInitialized() pulls coordinator/system inner objects so subsequent
 *           DKG/presign/sign calls don't pay that cost.
 * solana base: stub - lands when @ika.xyz/pre-alpha-solana-client is wired in.
 * ---------------------------------------------------------------------------- */

async function handleInit(params: IkaInitRequest): Promise<void> {
  const baseChain = params.baseChain;
  if (baseChain === 'sui') {
    if (!params.suiGraphQlEndpoint) {
      throw new Error('sui base init requires suiGraphQlEndpoint');
    }
    // network must be 'testnet' or 'mainnet' per @ika.xyz/sdk getNetworkConfig contract.
    const networkName = params.network === 'sui-mainnet' ? 'mainnet' : 'testnet';
    const suiClient = new SuiGraphQLClient({
      url: params.suiGraphQlEndpoint,
      network: networkName,
    });
    const ikaConfig = getNetworkConfig(networkName);
    // SuiGraphQLClient implements the same SuiClientTypes.TransportMethods surface IkaClient
    // expects; the cast keeps tsc happy without dragging the full type graph in.
    const ikaClient = new IkaClient({
      suiClient: suiClient as unknown as ConstructorParameters<typeof IkaClient>[0]['suiClient'],
      config: ikaConfig,
      cache: true,
    });
    await ikaClient.initialize();
    state = {
      baseChain: 'sui',
      network: params.network,
      suiClient,
      ikaClient,
      userKeysByCurve: {},
      rootSeedBytes: base64ToBytes(params.rootSeedB64),
    };
    return;
  }
  if (baseChain === 'solana') {
    // pre-alpha mock signer; gRPC client wiring lands in a follow-up turn. for now we
    // accept the init so the kotlin host can probe the bridge round-trip, but every
    // subsequent dkg/presign/sign throws not_implemented.
    state = {
      baseChain: 'solana',
      network: params.network,
      rootSeedBytes: base64ToBytes(params.rootSeedB64),
    };
    return;
  }
  throw new Error(`unknown baseChain: ${baseChain as string}`);
}

/* ----------------------------------------------------------------------------
 * UserShareEncryptionKeys lazy materialization
 *
 * `UserShareEncryptionKeys.fromRootSeedKey(seed, curve)` is the canonical entry point
 * documented in skills/ika-solana-prealpha/references/user-share-encryption-keys.md.
 * we cache per (baseChain, curve) so the second sign on the same dWallet doesn't pay
 * the keccak + ed25519 keygen cost again.
 * ---------------------------------------------------------------------------- */

async function getUserKeys(curveLabel: CurveLabel): Promise<UserShareEncryptionKeys> {
  if (!state) throw new Error('ika bridge not initialized; call ika_init first');
  if (state.baseChain !== 'sui') {
    throw notImplemented('ika_userkeys', 'solana base UserShareEncryptionKeys lands with gRPC client wiring');
  }
  const cached = state.userKeysByCurve[curveLabel];
  if (cached) return cached;
  const curve = curveFromLabel(curveLabel);
  const fresh = await UserShareEncryptionKeys.fromRootSeedKey(state.rootSeedBytes, curve);
  state.userKeysByCurve[curveLabel] = fresh;
  return fresh;
}

/* ----------------------------------------------------------------------------
 * dispatch
 *
 * every handler returns the canonical `IkaResult` envelope (or throws, which the outer
 * try/catch turns into `ok: false`). this keeps the kotlin side's response handling
 * uniform across success and failure paths.
 * ---------------------------------------------------------------------------- */

async function dispatch(req: IkaRequest): Promise<IkaResult> {
  switch (req.method) {
    case 'ika_init':
      await handleInit(req.params);
      return { id: req.id, ok: true, method: 'ika_init', result: { ready: true } };

    case 'ika_dkg': {
      // sanity-check the cache + state path. real DKG flow lands when we port
      // wallet-extension/src/background/ika/dwallet-lifecycle.ts (multi-step:
      // requestDWalletDKG + accept share + zero-trust completion) - that's a multi-turn job.
      await getUserKeys(req.params.curve);
      throw notImplemented('ika_dkg', 'DKG ptb flow + accept-share lands in the next port pass');
    }

    case 'ika_presign':
      throw notImplemented('ika_presign', 'presign pool refill lands in the next port pass');

    case 'ika_sign':
      throw notImplemented('ika_sign', 'sign + parseSignatureFromSignOutput lands in the next port pass');

    default:
      throw new Error(`unknown method ${(req as { method: string }).method}`);
  }
}

window.handle = async function handle(raw: string): Promise<void> {
  let req: IkaRequest;
  try {
    req = JSON.parse(raw) as IkaRequest;
  } catch (err) {
    reply({
      id: 'unknown',
      ok: false,
      error: { code: 'invalid_json', message: String((err as Error).message ?? err) },
    });
    return;
  }
  try {
    const result = await dispatch(req);
    reply(result);
  } catch (err) {
    const e = err as Error & { code?: string };
    reply({
      id: req.id,
      ok: false,
      error: { code: e.code ?? 'bridge_error', message: e.message },
    });
  }
};

// surface the version of the bundle for diagnostics. kotlin host can read this via
// `evaluateJavascript("window.chromatikaSeekerIkaBridgeVersion")` for a sanity check.
(window as unknown as { chromatikaSeekerIkaBridgeVersion: string }).chromatikaSeekerIkaBridgeVersion = '0.1.0';

// avoid unused-var warnings on `BaseChain` import (used in the State type discriminator).
export type { BaseChain };
