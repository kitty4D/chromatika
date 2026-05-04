/**
 * lazy-loaded `@lazorkit/wallet` `DialogManager` wrapper. lazor's portal lives at
 * `https://portal.lazor.sh` (default), webauthn happens at lazor.sh's domain via iframe
 * or popup, so chromatika doesn't run `navigator.credentials` directly.
 *
 * dynamic import keeps the ~2mb sdk weight off bundles that never touch the lazor path.
 * the dialog manager is cached per-context (side panel / popup) so multiple connect calls
 * reuse the same iframe lifecycle.
 */

import type { DialogManager as DialogManagerType } from '@lazorkit/wallet';

export type LazorPortalConfig = {
  portalUrl?: string;
  rpcUrl?: string;
  paymasterUrl?: string;
};

let cached: DialogManagerType | null = null;
let initInFlight: Promise<DialogManagerType> | null = null;

/**
 * **e2e mock mode**: when the side-panel / onboarding URL carries `?e2eLazorMock=<scenario>`
 * AND the build is dev-mode, all four lazor helpers (`lazorConnect`, `resolveLazorSmartWalletPda`,
 * `lazorDeterminismProbe`, `deployLazorSmartWallet`) skip the real `@lazorkit/wallet` SDK +
 * iframe portal and return canned values that exercise specific code paths.
 *
 * scenarios:
 *   - `deterministic`: connect returns canned creds, PDA resolves, probe reports deterministic
 *      (signatures match) -> lazor-signature happy path activates
 *   - `non-deterministic`: same up to the probe, which reports mismatched signatures -> the
 *      LazorStep error branch surfaces + the user sees the "switch to phrase path" hint
 *   - `no-pda`: connect succeeds, first PDA lookup returns null, deploy succeeds (mocked
 *      paymaster), second PDA lookup returns the canned PDA -> happy path completes through
 *      the auto-deploy branch
 *   - `deploy-fails`: connect succeeds, first PDA lookup returns null, deploy throws -> the
 *      LazorStep error branch surfaces with the deploy-failure copy
 *   - any other value: mock disabled, real SDK runs (default production path)
 *
 * gated on `import.meta.env.DEV` so the mock branch never ships in production. mock data is
 * deterministic per-call so e2e specs can assert specific addresses / signatures.
 */
type LazorMockScenario = 'deterministic' | 'non-deterministic' | 'no-pda' | 'deploy-fails';
function readLazorMockScenario(): LazorMockScenario | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined') return null;
  try {
    const params = new URL(window.location.href).searchParams;
    const v = params.get('e2eLazorMock');
    if (
      v === 'deterministic'
      || v === 'non-deterministic'
      || v === 'no-pda'
      || v === 'deploy-fails'
    ) return v;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * track whether the no-pda mock has already had its deploy step run. resolve flips this true via
 * `deployLazorSmartWallet`, so the second resolve call returns the canned PDA (mirroring real
 * "first probe null -> deploy -> second probe finds it" behavior).
 */
let _mockNoPdaDeployed = false;

/** canned values used when the e2e mock is active. addresses are valid base58 / base64 shapes
 *  so downstream consumers (PublicKey, base64 decoders) don't choke. */
const LAZOR_MOCK_CANNED = {
  passkeyPublicKeyB64: 'A8C0RyqJlWrXUJU5/2I1c1VMm0vwlbbITGtQqnFC4qqA',
  credentialIdB64: 'mock-credential-id-e2e',
  smartWalletPdaB58: '6dQNNzWqqLyV2WuSYz1gqmoFTTuXrz8a72w5KDZmVRTH',
  walletStatePdaB58: '4mP1nLLMwLHoYqsiRjBBRC4kyjMxwt1QzXMb2hf3S6jR',
  walletDevicePdaB58: '5wZ2NjYqrgRvk8U2vxrfkLkcXqhPzbZkCh3JKYPZK4Df',
  programIdB58: 'LzrK1tKYbE7zCMkbMvKbXGUkrCkDMfSL6n1qCSLzr1m',
  signatureB64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMA==',
  signatureB64Other: 'YWRkZWQgZW50cm9weSBmb3IgdGhlIG5vbi1kZXRlcm1pbmlzdGljIG1vY2sgY2FzZS4=',
};

export const LAZOR_DEFAULTS = {
  PORTAL_URL: 'https://portal.lazor.sh',
  // lazor moved their paymaster off the onrender free tier (suspended 2026-05-03) onto their own
  // domain via Solana Foundation's Kora protocol. `@lazorkit/wallet@2.0.1`'s `Paymaster` class
  // already speaks the new Kora JSON-RPC method names (`getPayerSigner`, `signAndSendTransaction`,
  // `signTransaction`); only the URL constant needed updating. mainnet equivalent when chromatika
  // ships solana-mainnet ika base: https://kora.lazorkit.com
  PAYMASTER_URL: 'https://kora.devnet.lazorkit.com',
  RPC_ENDPOINT: 'https://api.devnet.solana.com',
} as const;

/** lazily load `@lazorkit/wallet` and instantiate `DialogManager` exactly once per ui mount. */
export async function ensureLazorDialogManager(opts: LazorPortalConfig = {}): Promise<DialogManagerType> {
  if (cached) return cached;
  if (initInFlight) return initInFlight;
  if (typeof window === 'undefined') {
    throw new Error('lazor sdk cannot run in the service worker (no `window`); init must happen in side-panel / popup context.');
  }

  initInFlight = (async () => {
    const { DialogManager } = await import('@lazorkit/wallet');
    const manager = new DialogManager({
      portalUrl: opts.portalUrl ?? LAZOR_DEFAULTS.PORTAL_URL,
      rpcUrl: opts.rpcUrl ?? LAZOR_DEFAULTS.RPC_ENDPOINT,
      paymasterUrl: opts.paymasterUrl ?? LAZOR_DEFAULTS.PAYMASTER_URL,
    });
    cached = manager;
    initInFlight = null;
    return manager;
  })();
  return initInFlight;
}

/** clear cached manager (e.g., on lock so the iframe state resets). */
export function disposeLazorDialogManager(): void {
  if (cached) {
    try { cached.destroy(); } catch { /* best effort */ }
  }
  cached = null;
  initInFlight = null;
}

/**
 * convenience: open the lazor connect portal and return the credentials. wraps `openConnect`
 * so callers don't need to track dialog lifecycle separately.
 *
 * **important caveat about `publicKey`**: portal returns the WebAuthn passkey P-256 public key
 * (base64), NOT the canonical Solana smart-wallet PDA. callers that need the actual on-chain
 * solana address for this credential must call `resolveLazorSmartWalletPda` next - that goes
 * through Lazor's anchor program to look up the deployed smart-wallet PDA.
 */
export async function lazorConnect(opts: LazorPortalConfig = {}): Promise<{
  publicKey: string;
  credentialId: string;
  isCreated: boolean;
}> {
  const mock = readLazorMockScenario();
  if (mock !== null) {
    return {
      publicKey: LAZOR_MOCK_CANNED.passkeyPublicKeyB64,
      credentialId: LAZOR_MOCK_CANNED.credentialIdB64,
      isCreated: true,
    };
  }
  const manager = await ensureLazorDialogManager(opts);
  const result = await manager.openConnect();
  return {
    publicKey: result.publicKey,
    credentialId: result.credentialId,
    isCreated: result.isCreated,
  };
}

/**
 * domain string the lazor passkey signs at onboarding to derive a deterministic ika seed.
 * stable across versions: changing this rotates everyone's lazor-signature-derived dwallets,
 * so don't ship a new value without a vault schema bump.
 */
export const IKA_USK_DERIVATION_MESSAGE_LAZOR_V1 = 'ika.chromatika.user-share-encryption-key.lazor.v1';

/**
 * sign `IKA_USK_DERIVATION_MESSAGE_LAZOR_V1` twice through the lazor portal and check whether
 * the signatures match. WebAuthn ECDSA over secp256r1 is non-deterministic by default (random
 * `k` nonce) - some authenticators (apple platform, many hardware tokens) implement RFC 6979
 * deterministic signing, others (some android, older yubikeys) don't.
 *
 * **why two signatures**: chromatika needs a deterministic 32-byte secret to seed
 * `UserShareEncryptionKeys` so the same lazor passkey on a different install re-derives the
 * same ika seed = same dwallet. if the authenticator's signatures aren't deterministic the
 * user's ika seed can't be tied to the passkey - we fall back to the recovery-words path.
 *
 * returns `{ deterministic: true, signatureB64 }` when both signatures match (and we use the
 * canonical signature as the seed source); `{ deterministic: false, ... }` when they don't,
 * letting the caller surface a clear error + offer the phrase-based path.
 *
 * cost: two iframe round-trips through portal.lazor.sh (~3-5s + 2 user taps). only runs at
 * onboarding for the lazor-signature path; subsequent unlocks rely on chromatika's existing
 * password envelope.
 */
export async function lazorDeterminismProbe(
  credentialIdB64: string,
  opts: LazorPortalConfig = {},
): Promise<
  | { deterministic: true; signatureB64: string }
  | { deterministic: false; firstB64: string; secondB64: string }
> {
  const mock = readLazorMockScenario();
  if (mock === 'deterministic') {
    return { deterministic: true, signatureB64: LAZOR_MOCK_CANNED.signatureB64 };
  }
  if (mock === 'non-deterministic') {
    return {
      deterministic: false,
      firstB64: LAZOR_MOCK_CANNED.signatureB64,
      secondB64: LAZOR_MOCK_CANNED.signatureB64Other,
    };
  }
  const manager = await ensureLazorDialogManager(opts);
  const message = IKA_USK_DERIVATION_MESSAGE_LAZOR_V1;
  // sign twice. portal handles the per-sign ux internally (face id / touch id / passkey unlock).
  const first = await manager.openSignMessage(message, credentialIdB64);
  const second = await manager.openSignMessage(message, credentialIdB64);
  if (first.signature === second.signature) {
    return { deterministic: true, signatureB64: first.signature };
  }
  return { deterministic: false, firstB64: first.signature, secondB64: second.signature };
}

/**
 * resolve the canonical Solana smart-wallet PDA for a Lazor credential. queries Lazor's anchor
 * program via `LazorkitClient.getSmartWalletByCredentialHash` and returns the deployed PDA as
 * a base58 string suitable for `new PublicKey(...)` everywhere downstream.
 *
 * returns `null` when no smart wallet has been deployed for this credential yet (e.g. user
 * registered the passkey at the portal but hasn't completed the on-chain wallet creation).
 * callers should surface a clear error in that case + send the user back to the portal to
 * finish setup.
 *
 * lazy-loads `@lazorkit/wallet` (~2MB) only when actually invoked - keeps the side-panel bundle
 * small for users who never touch the lazor path.
 */
export async function resolveLazorSmartWalletPda(
  credentialIdB64: string,
  opts: { rpcUrl?: string } = {},
): Promise<{
  smartWalletPdaB58: string;
  passkeyPublicKeyBytes: number[];
  walletState: string;
  walletDevice: string;
  /** lazor anchor program id (base58) pulled live from the SDK - same id all returned PDAs use. */
  programIdB58: string;
} | null> {
  const mock = readLazorMockScenario();
  if (mock === 'no-pda') {
    // first call returns null (simulates a fresh credential whose smart wallet hasn't deployed
    // yet); after `deployLazorSmartWallet` mock runs, the flag flips and subsequent resolves
    // return the canned PDA - exercises the auto-deploy + re-resolve path end-to-end.
    if (!_mockNoPdaDeployed) return null;
    return {
      smartWalletPdaB58: LAZOR_MOCK_CANNED.smartWalletPdaB58,
      passkeyPublicKeyBytes: Array.from(new Uint8Array(33).fill(0x02)),
      walletState: LAZOR_MOCK_CANNED.walletStatePdaB58,
      walletDevice: LAZOR_MOCK_CANNED.walletDevicePdaB58,
      programIdB58: LAZOR_MOCK_CANNED.programIdB58,
    };
  }
  if (mock === 'deploy-fails') return null;
  if (mock === 'deterministic' || mock === 'non-deterministic') {
    return {
      smartWalletPdaB58: LAZOR_MOCK_CANNED.smartWalletPdaB58,
      passkeyPublicKeyBytes: Array.from(new Uint8Array(33).fill(0x02)),
      walletState: LAZOR_MOCK_CANNED.walletStatePdaB58,
      walletDevice: LAZOR_MOCK_CANNED.walletDevicePdaB58,
      programIdB58: LAZOR_MOCK_CANNED.programIdB58,
    };
  }
  if (typeof window === 'undefined') {
    throw new Error('lazor smart-wallet PDA resolver cannot run in the service worker (no `window`); must be called from side-panel / popup.');
  }
  const [{ LazorkitClient, credentialHashFromBase64 }, { Connection }] = await Promise.all([
    import('@lazorkit/wallet'),
    import('@solana/web3.js'),
  ]);
  const conn = new Connection(opts.rpcUrl ?? LAZOR_DEFAULTS.RPC_ENDPOINT, 'confirmed');
  const client = new LazorkitClient(conn);
  const credentialHash = credentialHashFromBase64(credentialIdB64);
  const result = await client.getSmartWalletByCredentialHash(credentialHash);
  if (!result) return null;
  return {
    smartWalletPdaB58: result.smartWallet.toBase58(),
    passkeyPublicKeyBytes: result.passkeyPublicKey,
    walletState: result.walletState.toBase58(),
    walletDevice: result.walletDevice.toBase58(),
    programIdB58: client.programId.toBase58(),
  };
}

/**
 * deploy the lazor smart wallet on-chain via the lazor paymaster. called when
 * `resolveLazorSmartWalletPda` returns null - typically when the user just registered a passkey
 * at portal.lazor.sh but hasn't executed any on-chain tx yet (the portal registers credentials
 * but does NOT deploy the on-chain `WalletState` account). mirrors what `@lazorkit/wallet`'s
 * `useWallet().connect()` does internally: build `createSmartWalletTxn`, submit through the
 * paymaster (free for the user), then poll `getSmartWalletByCredentialHash` until the new
 * `WalletState` account is visible.
 *
 * cost: one paymaster-funded tx + ~2-15s of confirmation. user signs nothing here - the smart
 * wallet is created by the paymaster on behalf of the credential, identical to the lazor
 * reference SDK behavior.
 *
 * lazy-loads `@lazorkit/wallet` (~2MB) + `@solana/web3.js` so flows that don't deploy don't pay
 * the bundle cost.
 */
export async function deployLazorSmartWallet(
  credentialIdB64: string,
  /** base64-encoded 33-byte compressed P-256 passkey pubkey - the `publicKey` returned by `lazorConnect()`. */
  passkeyPublicKeyB64: string,
  opts: LazorPortalConfig = {},
): Promise<{
  smartWalletPdaB58: string;
  walletState: string;
  walletDevice: string;
  passkeyPublicKeyBytes: number[];
  programIdB58: string;
  txSignature: string;
}> {
  const mock = readLazorMockScenario();
  if (mock === 'deploy-fails') {
    throw new Error(
      'mock paymaster: deploy intentionally failed for `e2eLazorMock=deploy-fails` scenario.',
    );
  }
  if (mock !== null) {
    // mark the no-pda flag so the next resolveLazorSmartWalletPda call returns the canned PDA.
    // benign for `deterministic` / `non-deterministic` since those resolves never check the flag.
    _mockNoPdaDeployed = true;
    return {
      smartWalletPdaB58: LAZOR_MOCK_CANNED.smartWalletPdaB58,
      walletState: LAZOR_MOCK_CANNED.walletStatePdaB58,
      walletDevice: LAZOR_MOCK_CANNED.walletDevicePdaB58,
      passkeyPublicKeyBytes: Array.from(new Uint8Array(33).fill(0x02)),
      programIdB58: LAZOR_MOCK_CANNED.programIdB58,
      txSignature: 'mock-deploy-tx-signature',
    };
  }
  if (typeof window === 'undefined') {
    throw new Error('lazor smart-wallet deploy cannot run in the service worker (no `window`); must be called from side-panel / popup.');
  }

  const [lazorSdk, { Connection }] = await Promise.all([
    import('@lazorkit/wallet'),
    import('@solana/web3.js'),
  ]);
  const { LazorkitClient, Paymaster, credentialHashFromBase64, asPasskeyPublicKey } = lazorSdk;
  const conn = new Connection(opts.rpcUrl ?? LAZOR_DEFAULTS.RPC_ENDPOINT, 'confirmed');
  const client = new LazorkitClient(conn);
  const paymaster = new Paymaster({ paymasterUrl: opts.paymasterUrl ?? LAZOR_DEFAULTS.PAYMASTER_URL });

  // base64 -> number[] -> branded PasskeyPublicKey. createSmartWalletTxn requires the brand
  // (a runtime-validated 33-byte compressed P-256 pubkey). mirrors the SDK's internal
  // `useWallet().connect()` flow which converts the openConnect base64 publicKey the same way.
  const passkeyPublicKeyBytes = Array.from(
    Uint8Array.from(atob(passkeyPublicKeyB64), (c) => c.charCodeAt(0)),
  );

  const payer = await paymaster.getPayer();
  const built = await client.createSmartWalletTxn({
    passkeyPublicKey: asPasskeyPublicKey(passkeyPublicKeyBytes),
    payer,
    credentialIdBase64: credentialIdB64,
  });

  // paymaster signs + sends. `built.transaction` is a legacy `Transaction`; signAndSend handles
  // signing the paymaster fee + submission internally and returns the tx signature.
  // signAndSend types vary by SDK version (legacy Transaction vs VersionedTransaction); cast to
  // `never` to satisfy whichever overload the bundled version exposes - same workaround we use
  // for ika's IkaTransaction Mysten-Transaction mismatch.
  const txSignature = await paymaster.signAndSend(built.transaction as never);

  // poll for the WalletState account to appear via getSmartWalletByCredentialHash. we don't use
  // Connection.confirmTransaction here because what we actually need is the on-chain account
  // queryable, not just tx confirmation - and polling stays consistent with chromatika's
  // `confirmSolanaTxByPolling` pattern (browser bundle of `@solana/web3.js` confirm uses
  // websockets which can be flakey here even from side-panel context).
  const credentialHash = credentialHashFromBase64(credentialIdB64);
  const startedAt = Date.now();
  const timeoutMs = 60_000;
  const intervalMs = 1500;
  while (Date.now() - startedAt < timeoutMs) {
    const found = await client.getSmartWalletByCredentialHash(credentialHash);
    if (found) {
      return {
        smartWalletPdaB58: found.smartWallet.toBase58(),
        walletState: found.walletState.toBase58(),
        walletDevice: found.walletDevice.toBase58(),
        passkeyPublicKeyBytes: found.passkeyPublicKey,
        programIdB58: client.programId.toBase58(),
        txSignature,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Lazor smart wallet deploy submitted (tx ${txSignature}) but the WalletState account did not `
    + `appear on-chain within ${timeoutMs / 1000}s. The transaction may still confirm; reload `
    + `chromatika and try again.`,
  );
}

/**
 * fast lookup for the lazor program id without resolving a smart wallet. used by the setup flow
 * for cases where we want to persist the program id even on flows that bail before the
 * `getSmartWalletByCredentialHash` round-trip (currently all paths hit the resolver, so this is
 * a forward-compat helper).
 *
 * lazy-loads the SDK + creates a throwaway connection. cheap.
 */
export async function lazorProgramIdB58(opts: { rpcUrl?: string } = {}): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('lazor program-id resolver cannot run in the service worker (no `window`).');
  }
  const [{ LazorkitClient }, { Connection }] = await Promise.all([
    import('@lazorkit/wallet'),
    import('@solana/web3.js'),
  ]);
  const conn = new Connection(opts.rpcUrl ?? LAZOR_DEFAULTS.RPC_ENDPOINT, 'confirmed');
  const client = new LazorkitClient(conn);
  return client.programId.toBase58();
}
