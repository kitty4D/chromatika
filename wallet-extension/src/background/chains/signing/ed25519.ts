import {
  Curve,
  Hash,
  SignatureAlgorithm,
  IkaTransaction,
  UserShareEncryptionKeys,
  type ZeroTrustDWallet,
} from '@ika.xyz/sdk';
import { Transaction } from '@mysten/sui/transactions';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { allocateIkaCoinsForOperation } from '@/background/ika/coin-allocation';
import { getIkaAdapter } from '@/background/ika/ika-adapter';
import { graphqlUrlForNetwork } from '@/config/sui';
import { beginOperation, type OperationProgressAction } from '@/background/progress/operation-progress';
import { DWalletGoneError } from '@/background/ika/errors';
import { ikaRootSeedFromFeeKeypair } from '@/background/keyring/hd';
import { saveDwalletMeta } from '@/background/storage-meta';
import {
  capIdForDwallet,
  ensureEncryptedShareId,
  resolveSignSessionId,
  runSignWithRetry,
  takePresignWithAutoRefill,
  withTransientSuiReadRetry,
} from './internal';
import { signMessageSolSolanaGrpc } from './solana-grpc';

/** Solana / Sui message signing via ika MPC (ed25519 + EDDSA + SHA512). */
export async function signMessageSol(
  message: Uint8Array,
  opts?: { ed25519DwalletId?: string },
) {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');

  // Solana-base ika: do a fresh per-sign Presign over gRPC, then Sign. ed25519 is deterministic
  // per RFC 8032 (no per-signature random nonce), but the validator still requires a Presign
  // session to bind to. upstream `chains/solana/examples/protocols-e2e/main.rs` runs DKG to
  // Presign to Sign for every curve including EdDSA on Curve25519. we use `DWalletRequest::Presign`
  // (the global variant) here, NOT `PresignForDWallet`. the latter is gated to imported ECDSA
  // and rejects Curve25519/EdDSA with "PresignForDWallet is only for imported ECDSA keys", which
  // is why the presign-pool path stays disabled for ED25519. skipping Presign entirely surfaces
  // as "no key for dwallet ... or scheme X incompatible with curve Y" on the next Sign, looks
  // like a wiped dWallet but is actually a missing protocol step. the Sui-base path below still
  // uses the presign-pool-then-sign pattern because `IkaTransaction.requestSign` requires
  // `verifiedPresignCap`.
  if (s.activeVaultBaseChain === 'solana') {
    const curveKey: CurveKey = 'ED25519';
    const dwalletId =
      opts?.ed25519DwalletId?.trim() || s.dwalletMeta[curveKey]?.dwalletId;
    if (!dwalletId) throw new Error('No ED25519 dWallet - create one first');
    if (!s.solanaIkaGrpc) throw new Error('Solana ika gRPC not initialized');
    console.warn('[chromatika][ed25519] solana-base sign begin', { dwalletId, messageBytesLen: message.length });
    const op = beginOperation('Signing Solana message');

    const SOLANA_SIGN_MAX_ATTEMPTS = 3;
    const SOLANA_SIGN_BACKOFF_MS = 2_000;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= SOLANA_SIGN_MAX_ATTEMPTS; attempt++) {
      try {
        console.warn(`[chromatika][ed25519] attempt ${attempt}/${SOLANA_SIGN_MAX_ATTEMPTS}: requesting presign`);
        await op.updateStage('grpc-presign', `Requesting Ika presign${attempt > 1 ? ` (attempt ${attempt}/${SOLANA_SIGN_MAX_ATTEMPTS})` : ''}`);
        const t0 = Date.now();
        const { presignIdHex } = await s.solanaIkaGrpc.requestPresign('Curve25519', 'EdDSA');
        console.warn(`[chromatika][ed25519] presign ok in ${Date.now() - t0}ms`, { presignIdHex });
        const t1 = Date.now();
        const result = await signMessageSolSolanaGrpc(message, presignIdHex, dwalletId, s);
        console.warn(`[chromatika][ed25519] sign ok in ${Date.now() - t1}ms`);
        await op.succeed('Signed');
        return result;
      } catch (e) {
        lastErr = e;
        console.warn(`[chromatika][ed25519] attempt ${attempt} failed`, { error: e instanceof Error ? e.message : String(e) });
        if (e instanceof DWalletGoneError) break;
        if (attempt < SOLANA_SIGN_MAX_ATTEMPTS) {
          const backoff = SOLANA_SIGN_BACKOFF_MS * attempt;
          await op.updateStage('retry-backoff', `Attempt ${attempt} failed, retrying in ${backoff / 1000}s...`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    const action: OperationProgressAction | undefined =
      lastErr instanceof DWalletGoneError && lastErr.curve === 'ED25519'
        ? { kind: 'recreate-ed25519-dwallet', label: 'Recreate dWallet', cluster: lastErr.cluster }
        : undefined;
    await op.fail(lastErr instanceof Error ? lastErr.message : String(lastErr), action ? { action } : undefined);
    throw lastErr;
  }

  // Sui-base path: presign-take is outside runSerializedIkaTx to avoid re-entrant mutex deadlock.
  console.warn('[chromatika][ed25519] sui-base sign begin', {
    dwalletId: opts?.ed25519DwalletId?.slice(0, 20) || s.dwalletMeta.ED25519?.dwalletId?.slice(0, 20),
    metaBaseChain: s.dwalletMeta.ED25519?.baseChain,
    vaultBaseChain: s.activeVaultBaseChain,
    network: s.network,
    messageBytesLen: message.length,
  });
  const op = beginOperation('Signing message (ika MPC)');
  try {
    const result = await runSignWithRetry(
      () => takePresignWithAutoRefill('ED25519_EDDSA', 'Presign pool empty - auto-refill failed for ED25519_EDDSA'),
      (presignId) => signMessageSolCore(message, presignId, opts?.ed25519DwalletId),
    );
    await op.succeed('Signed');
    return result;
  } catch (e) {
    await op.fail(e instanceof Error ? e.message : String(e));
    throw e;
  }
}

async function signMessageSolCore(
  message: Uint8Array,
  presignId: string,
  ed25519DwalletIdOverride?: string,
): Promise<{ signature: string; signId: string }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const curveKey: CurveKey = 'ED25519';
  const dwalletId =
    ed25519DwalletIdOverride?.trim() || s.dwalletMeta[curveKey]?.dwalletId;
  if (!dwalletId) throw new Error('No ED25519 dWallet - create one first');

  const metaBaseChain = s.dwalletMeta[curveKey]?.baseChain;
  const adapterChain = metaBaseChain ?? 'sui';
  console.warn('[chromatika][signMessageSolCore] begin', {
    presignId,
    dwalletId,
    metaBaseChain,
    adapterChain,
    vaultBaseChain: s.activeVaultBaseChain,
    network: s.network,
    graphqlUrl: graphqlUrlForNetwork(s.network),
    messageBytesLen: message.length,
  });

  // Sui-base only, Solana base shortcuts in `signMessageSol`. adapter still picks Sui by default.
  const adapter = getIkaAdapter(s, adapterChain);

  // log ika config to verify correct network packages
  try {
    const cfg = adapter.ikaClient.ikaConfig;
    console.warn('[chromatika][signMessageSolCore] ika config', {
      ikaPackage: cfg.packages?.ikaPackage?.slice(0, 20),
      ikaDwallet2pcMpc: cfg.packages?.ikaDwallet2pcMpcPackage?.slice(0, 20),
    });
  } catch { /* solana adapter throws on ikaClient access */ }

  const dWallet = await adapter.getDWallet(dwalletId);
  if (dWallet.kind !== 'zero-trust') throw new Error('Expected zero-trust ED25519 dWallet');
  const stateKind = (dWallet.state as { $kind: string }).$kind;
  console.warn('[chromatika][signMessageSolCore] dWallet loaded', {
    kind: dWallet.kind,
    state: stateKind,
    curve: dWallet.curve,
  });
  if (stateKind !== 'Active') throw new Error(`ED25519 dWallet must be Active to sign (current: ${stateKind})`);
  const encShareId = await ensureEncryptedShareId(s, curveKey, adapter, dwalletId);
  console.warn('[chromatika][signMessageSolCore] encShareId resolved', { encShareId: encShareId?.slice(0, 20) });

  // diagnostic: read the presign object ONCE (no polling) to see its current state
  try {
    const rawPresign = await adapter.ikaClient.getPresign(presignId);
    const rawState = (rawPresign as { state?: { $kind?: string } }).state;
    console.warn('[chromatika][signMessageSolCore] presign raw state BEFORE polling', {
      presignId: presignId.slice(0, 20),
      stateKind: rawState?.$kind ?? 'unknown',
      curve: (rawPresign as { curve?: unknown }).curve,
      fullState: JSON.stringify(rawState)?.slice(0, 300),
    });
  } catch (diagErr) {
    console.warn('[chromatika][signMessageSolCore] presign diagnostic read FAILED', {
      presignId: presignId.slice(0, 20),
      error: diagErr instanceof Error ? diagErr.message : String(diagErr),
    });
  }

  console.warn('[chromatika][signMessageSolCore] polling presign for Completed (45s timeout)...');
  const t0Presign = Date.now();
  const presign = await adapter.getPresignInParticularState(presignId, 'Completed', {
    timeout: 45_000,
  });
  console.warn(`[chromatika][signMessageSolCore] presign reached Completed in ${Date.now() - t0Presign}ms`);

  // ---- DIAGNOSTIC: step-by-step logs to isolate which call between presign-reached and Sign-PTB
  // submission throws when we hit "Invalid signature". every await below has its own breadcrumb
  // so the last visible log = the call that broke. also dumps the on-chain dWallet pubkey so we
  // can cross-check against the local sender derivation.
  console.warn('[chromatika][signMessageSolCore] step 1/8: fetch encryptedUserSecretKeyShare', {
    encShareId: encShareId?.slice(0, 20),
  });
  let encShare: Awaited<ReturnType<typeof adapter.getEncryptedUserSecretKeyShare>>;
  try {
    encShare = await adapter.getEncryptedUserSecretKeyShare(encShareId);
  } catch (e) {
    console.warn('[chromatika][signMessageSolCore] step 1/8 THREW', { errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  // ---- DIAGNOSTIC for "Invalid signature" thrown by ika SDK's verifyAndGetDWalletDKGPublicOutput
  // (cryptography.js:218). that check verifies the on-chain `user_output_signature` against the
  // current `ikaShareKeys[ED25519]` signing pubkey. failure means the signing keypair we have now
  // is not the same one that signed the dWallet output at DKG time. likely causes:
  //   - vault `stored.ED25519` was missing / regenerated between DKG and now -> different keys
  //   - DKG was done on @ika.xyz/sdk 0.3.x (curve byte 0) but stored.ED25519 was cleared and
  //     re-derived on 0.4.x (curve byte 2)
  //   - dWallet meta points at a dWallet that was DKG'd by a DIFFERENT vault's keys
  // log the three identifiers needed to pinpoint which it is.
  try {
    const sharedKeys = s.ikaShareKeys[curveKey];
    const sharedKeysAny = sharedKeys as unknown as {
      getSuiAddress?: () => string;
      getSigningPublicKeyBytes?: () => Uint8Array;
      legacyHash?: boolean;
      curve?: unknown;
    };
    const runtimeSigningSuiAddr = sharedKeysAny.getSuiAddress?.();
    const runtimeSigningPubBytes = sharedKeysAny.getSigningPublicKeyBytes?.();
    const runtimeSigningPubHex = runtimeSigningPubBytes
      ? '0x' + Array.from(runtimeSigningPubBytes, (b) => b.toString(16).padStart(2, '0')).join('')
      : null;
    const encShareAny = encShare as unknown as {
      encryption_key_address?: string;
      dwallet_id?: string;
      state?: { $kind?: string; KeyHolderSigned?: { user_output_signature?: number[] } };
    };
    const sharedKeysLegacy = sharedKeysAny.legacyHash;
    const userOutputSigPresent = !!encShareAny.state?.KeyHolderSigned?.user_output_signature;
    console.warn('[chromatika][signMessageSolCore] encShare vs runtime signing-key diag', {
      // identity comparison: must match for "Invalid signature" check to pass
      runtimeSigningSuiAddr,
      encShareEncryptionKeyAddress: encShareAny.encryption_key_address,
      addressesMatch: runtimeSigningSuiAddr === encShareAny.encryption_key_address,
      runtimeSigningPubHex,
      // share metadata
      encShareDwalletId: encShareAny.dwallet_id,
      encShareDwalletIdMatchesRequested: encShareAny.dwallet_id === dwalletId,
      encShareStateKind: encShareAny.state?.$kind,
      userOutputSigPresent,
      // derivation provenance
      runtimeKeysLegacyHash: sharedKeysLegacy,
      runtimeKeysCurve: sharedKeysAny.curve,
    });
  } catch (diagErr) {
    console.warn('[chromatika][signMessageSolCore] encShare diag threw', diagErr);
  }
  // ---------------------------------------------------------------------------

  // also log the dWallet's on-chain public output so we can compare with the derived pubkey used
  // by sui-dapp-tx's verify path. mismatch here = stale local state or dWallet was rotated.
  try {
    const stateAny = dWallet.state as { $kind: string; Active?: { public_output?: number[] } };
    const pubArr = stateAny.Active?.public_output;
    const pubBytes = pubArr ? Uint8Array.from(pubArr) : null;
    const pubHex = pubBytes ? Array.from(pubBytes, (b) => b.toString(16).padStart(2, '0')).join('') : null;
    console.warn('[chromatika][signMessageSolCore] dWallet on-chain pubkey snapshot', {
      dwalletId,
      stateKind: stateAny.$kind,
      pubLen: pubBytes?.length ?? 0,
      pubHexHead: pubHex ? '0x' + pubHex.slice(0, 32) + '...' + pubHex.slice(-8) : null,
    });
  } catch (diagErr) {
    console.warn('[chromatika][signMessageSolCore] dWallet pubkey snapshot threw', diagErr);
  }

  console.warn('[chromatika][signMessageSolCore] step 2/8: new Transaction + allocateIkaCoinsForOperation');
  const tx = new Transaction();
  let alloc: Awaited<ReturnType<typeof allocateIkaCoinsForOperation>>;
  try {
    alloc = await allocateIkaCoinsForOperation(s, adapter, tx);
  } catch (e) {
    console.warn('[chromatika][signMessageSolCore] step 2/8 THREW', { errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  console.warn('[chromatika][signMessageSolCore] step 3/8: capIdForDwallet', {
    owner: alloc.owner?.slice(0, 20),
    dwalletId: dwalletId?.slice(0, 20),
  });
  let capId: Awaited<ReturnType<typeof capIdForDwallet>>;
  try {
    capId = await capIdForDwallet(adapter, alloc.owner, dwalletId);
  } catch (e) {
    console.warn('[chromatika][signMessageSolCore] step 3/8 THREW', { errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  console.warn('[chromatika][signMessageSolCore] step 3/8 ok', { capId: typeof capId === 'string' ? capId.slice(0, 20) : 'non-string' });

  console.warn('[chromatika][signMessageSolCore] step 4/8: new IkaTransaction', {
    hasUserShareEncryptionKeys: !!s.ikaShareKeys[curveKey],
  });
  let keys = s.ikaShareKeys[curveKey];

  // ---- RECOVERY for ED25519 signing-key drift -----------------------------------------------
  // ika SDK's `verifyAndGetDWalletDKGPublicOutput` (cryptography.js:218) verifies the on-chain
  // `user_output_signature` against the current `userShareEncryptionKeys` signing pubkey. when
  // that check fails the SDK throws "Invalid signature" before the PTB is submitted, stranding
  // any funds at the dWallet's address.
  //
  // root cause: `UserShareEncryptionKeys.fromRootSeedKey` hashes with the actual curve byte in
  // @ika.xyz/sdk 0.4.x, but 0.3.x always passed `0`. for SECP256K1 these are equivalent (curve
  // number = 0), but ED25519 (curve number = 2) derives different keys per version. if the
  // dWallet was DKG'd on 0.3.x but `stored.ED25519` got cleared and re-derived on 0.4.x, the
  // runtime signing keypair no longer matches the on-chain signature -> permanent lockout.
  //
  // recovery: if the runtime signing pubkey's Sui address doesn't match the encrypted-share
  // `encryption_key_address`, try the legacy-hash derivation (curve byte forced to 0). if it
  // matches we use those keys for this sign call only. purely additive: working dWallets take
  // the early-return path and behave identically.
  //
  // scope: today's auto-recovery only handles Sui-base HD vaults (`s.suiKeypair` reconstructs
  // the seed deterministically). other vault types - passkey, lazor, hardware - need their
  // seed factory re-run with the live identity material; not wired here. surfaces a clear
  // error rather than silently failing in that case.
  try {
    const keysAny = keys as unknown as { getSuiAddress?: () => string; legacyHash?: boolean };
    const encShareAny = encShare as unknown as { encryption_key_address?: string };
    const expectedAddr = encShareAny.encryption_key_address;
    const runtimeAddr = keysAny.getSuiAddress?.();
    if (expectedAddr && runtimeAddr && runtimeAddr !== expectedAddr) {
      console.warn(
        '[chromatika][signMessageSolCore] runtime signing key does not match encrypted-share encryption_key_address; attempting legacy-hash recovery',
        { runtimeAddr, expectedAddr, runtimeKeysLegacyHash: keysAny.legacyHash },
      );
      if (s.activeVaultBaseChain === 'sui') {
        // FAST PATH: dwalletMeta caches the matched derivation. two levels of cache:
        //   (a) `serializedB64` if present - deserialize via `fromShareEncryptionKeysBytes`,
        //       skips the WASM classgroup keygen entirely. ~5ms.
        //   (b) `(encryptionKeyIndex, legacy)` only - re-derive via `fromRootSeedKey*`. ~15-20s
        //       (WASM classgroup keygen). slower but still way better than the 60-80s full scan.
        // either is much faster than the brute-force scan that originally found the match.
        const cached = s.dwalletMeta[curveKey]?.signingKeyDerivation;
        if (cached) {
          console.warn(
            '[chromatika][signMessageSolCore] using cached signing-key derivation from dwalletMeta',
            {
              encryptionKeyIndex: cached.encryptionKeyIndex,
              legacy: cached.legacy,
              hasSerializedBytes: !!cached.serializedB64,
            },
          );

          // (a) try serialized fast path first
          let cachedKeys: UserShareEncryptionKeys | null = null;
          if (cached.serializedB64) {
            try {
              const bytes = Uint8Array.from(atob(cached.serializedB64), (c) => c.charCodeAt(0));
              cachedKeys = UserShareEncryptionKeys.fromShareEncryptionKeysBytes(bytes);
            } catch (deserErr) {
              console.warn(
                '[chromatika][signMessageSolCore] failed to deserialize cached signing keys; falling back to re-derive',
                deserErr,
              );
              cachedKeys = null;
            }
          }

          // (b) fall back to re-deriving from indexes
          if (!cachedKeys) {
            const cachedSeed = ikaRootSeedFromFeeKeypair(s.suiKeypair, cached.encryptionKeyIndex);
            try {
              cachedKeys = cached.legacy
                ? await UserShareEncryptionKeys.fromRootSeedKeyLegacyHash(cachedSeed, Curve.ED25519)
                : await UserShareEncryptionKeys.fromRootSeedKey(cachedSeed, Curve.ED25519);
            } finally {
              cachedSeed.fill(0);
            }
          }

          const cachedAddr = (cachedKeys as unknown as { getSuiAddress?: () => string }).getSuiAddress?.();
          if (cachedAddr === expectedAddr) {
            keys = cachedKeys;
            // if we only had indexes cached, upgrade the cache to include serialized bytes
            // so subsequent signs in this session can hit the ~5ms fast path.
            if (!cached.serializedB64) {
              try {
                const bytes = cachedKeys.toShareEncryptionKeysBytes();
                const b64 = btoa(String.fromCharCode(...bytes));
                s.dwalletMeta[curveKey]!.signingKeyDerivation = {
                  encryptionKeyIndex: cached.encryptionKeyIndex,
                  legacy: cached.legacy,
                  serializedB64: b64,
                };
                await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
                console.warn('[chromatika][signMessageSolCore] upgraded cached derivation with serialized bytes');
              } catch (upgradeErr) {
                console.warn('[chromatika][signMessageSolCore] cache upgrade failed (non-fatal)', upgradeErr);
              }
            }
            // bail out of the scan branch entirely; we're done
            throw new Error('__SIGNING_KEY_CACHE_HIT__');
          } else {
            // cached derivation no longer matches on chain (rotation? meta corruption?). fall
            // through to a fresh scan and overwrite the cache with whatever new match wins.
            console.warn(
              '[chromatika][signMessageSolCore] cached derivation no longer matches; will rescan',
              { cachedAddr, expectedAddr },
            );
          }
        }

        // Sui-base HD scan: chromatika's `rotateCurveEncryptionKey` (lifecycle/encryption-key.ts)
        // increments the seed's `encryptionKeyIndex` on `ENCRYPTION_KEY_CURVE_MISMATCH` recovery,
        // so the index that was active at DKG time may differ from the index active now. brute
        // force a small range (0..15) of indexes against both the post-fix and legacy hash
        // derivations until one matches the on-chain encryption_key_address. 16 is generous;
        // typical wallets land at 0-2.
        const MAX_INDEX_SCAN = 16;
        let matched: { keys: UserShareEncryptionKeys; index: number; legacy: boolean } | null = null;
        const triedAddrs: Array<{ index: number; legacy: boolean; addr: string }> = [];
        for (let idx = 0; idx < MAX_INDEX_SCAN && !matched; idx++) {
          const idxSeed = ikaRootSeedFromFeeKeypair(s.suiKeypair, idx);
          try {
            for (const useLegacy of [false, true] as const) {
              const candidate = useLegacy
                ? await UserShareEncryptionKeys.fromRootSeedKeyLegacyHash(idxSeed, Curve.ED25519)
                : await UserShareEncryptionKeys.fromRootSeedKey(idxSeed, Curve.ED25519);
              const candidateAddr = (candidate as unknown as { getSuiAddress?: () => string }).getSuiAddress?.();
              if (candidateAddr) {
                triedAddrs.push({ index: idx, legacy: useLegacy, addr: candidateAddr });
                if (candidateAddr === expectedAddr) {
                  matched = { keys: candidate, index: idx, legacy: useLegacy };
                  break;
                }
              }
            }
          } finally {
            idxSeed.fill(0);
          }
        }
        if (matched) {
          console.warn(
            '[chromatika][signMessageSolCore] encryption-key scan MATCHED; using recovered keys for this sign',
            { index: matched.index, legacy: matched.legacy, matchedAddr: expectedAddr },
          );
          keys = matched.keys;
          // persist for next sign so we don't repeat the brute-force scan. include the
          // serialized key bytes so the next sign skips the ~17s WASM classgroup re-derive,
          // not just the 60s scan. best-effort write; a save failure doesn't block this sign.
          try {
            let serializedB64: string | undefined;
            try {
              const bytes = matched.keys.toShareEncryptionKeysBytes();
              serializedB64 = btoa(String.fromCharCode(...bytes));
            } catch (serErr) {
              console.warn('[chromatika][signMessageSolCore] could not serialize matched keys (indexes-only cache)', serErr);
            }
            s.dwalletMeta[curveKey] ??= { baseChain: s.activeVaultBaseChain };
            s.dwalletMeta[curveKey]!.signingKeyDerivation = {
              encryptionKeyIndex: matched.index,
              legacy: matched.legacy,
              serializedB64,
            };
            await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
            console.warn(
              '[chromatika][signMessageSolCore] cached signing-key derivation to dwalletMeta for next sign',
              { encryptionKeyIndex: matched.index, legacy: matched.legacy, hasSerializedBytes: !!serializedB64 },
            );
          } catch (saveErr) {
            console.warn(
              '[chromatika][signMessageSolCore] failed to persist signing-key derivation; next sign will rescan',
              saveErr,
            );
          }
        } else {
          console.warn(
            '[chromatika][signMessageSolCore] encryption-key scan exhausted without a match',
            { expectedAddr, triedCount: triedAddrs.length, lastFew: triedAddrs.slice(-6) },
          );
          throw new Error(
            `ED25519 signing-key drift cannot be auto-recovered (scanned 0..${MAX_INDEX_SCAN - 1} ` +
              `against both post-fix and legacy hash derivations). On-chain encrypted share expects ` +
              `signing address ${expectedAddr}, but no index produced a match. ` +
              `Current runtime key is ${runtimeAddr}. ` +
              `This dWallet was likely DKG'd under a different vault's identity. ` +
              `Funds at this dWallet's MPC address may be recoverable only by restoring the original vault's mnemonic.`,
          );
        }
      } else {
        throw new Error(
          `ED25519 signing-key drift detected. On-chain encrypted share expects signing address ${expectedAddr}, ` +
            `current vault runtime key is ${runtimeAddr}. Auto-recovery is only wired for Sui-base HD vaults today; ` +
            `this vault is ${s.activeVaultBaseChain}.`,
        );
      }
    }
  } catch (recoveryErr) {
    if (recoveryErr instanceof Error && recoveryErr.message === '__SIGNING_KEY_CACHE_HIT__') {
      // sentinel: cached derivation matched, `keys` already swapped above. silently fall through.
    } else if (recoveryErr instanceof Error && recoveryErr.message.includes('signing-key drift')) {
      // re-throw recovery errors so they surface clearly; SDK errors are caught separately below
      throw recoveryErr;
    } else {
      console.warn('[chromatika][signMessageSolCore] recovery check threw unexpectedly', recoveryErr);
    }
  }
  // -------------------------------------------------------------------------------------------

  let ikaTx: IkaTransaction;
  try {
    ikaTx = new IkaTransaction({
      ikaClient: adapter.ikaClient,
      transaction: tx as never,
      userShareEncryptionKeys: keys,
    });
  } catch (e) {
    console.warn('[chromatika][signMessageSolCore] step 4/8 THREW', { errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  console.warn('[chromatika][signMessageSolCore] step 5/8: ikaTx.approveMessage', {
    messageBytesLen: message.length,
    hashScheme: 'SHA512',
  });
  let messageApproval: Awaited<ReturnType<typeof ikaTx.approveMessage>>;
  try {
    messageApproval = await ikaTx.approveMessage({
      dWalletCap: capId,
      curve: Curve.ED25519,
      signatureAlgorithm: SignatureAlgorithm.EdDSA,
      hashScheme: Hash.SHA512,
      message,
    });
  } catch (e) {
    console.warn('[chromatika][signMessageSolCore] step 5/8 THREW', { errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  console.warn('[chromatika][signMessageSolCore] step 6/8: ikaTx.verifyPresignCap');
  let verifiedPresignCap: Awaited<ReturnType<typeof ikaTx.verifyPresignCap>>;
  try {
    verifiedPresignCap = await ikaTx.verifyPresignCap({ presign: presign as never });
  } catch (e) {
    console.warn('[chromatika][signMessageSolCore] step 6/8 THREW', { errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  console.warn('[chromatika][signMessageSolCore] step 7/8: ikaTx.requestSign');
  try {
    await ikaTx.requestSign({
      dWallet: dWallet as ZeroTrustDWallet,
      messageApproval,
      hashScheme: Hash.SHA512,
      verifiedPresignCap,
      presign: presign as never,
      encryptedUserSecretKeyShare: encShare,
      message,
      signatureScheme: SignatureAlgorithm.EdDSA,
      ikaCoin: alloc.ikaCoin,
      suiCoin: alloc.suiCoin,
    });
  } catch (e) {
    console.warn('[chromatika][signMessageSolCore] step 7/8 THREW', { errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  console.warn('[chromatika][signMessageSolCore] step 8/8: alloc.finalize');
  try {
    alloc.finalize();
  } catch (e) {
    console.warn('[chromatika][signMessageSolCore] step 8/8 THREW', { errorMessage: e instanceof Error ? e.message : String(e) });
    throw e;
  }

  console.warn('[chromatika][signMessageSolCore] submitting Sign request PTB to chain...');
  const tExec = Date.now();
  const result = await adapter.executeTx(s, tx);
  console.warn(`[chromatika][signMessageSolCore] executeTx returned in ${Date.now() - tExec}ms`, {
    kind: result.$kind,
    errorIfFailed:
      result.$kind === 'FailedTransaction'
        ? typeof result.FailedTransaction?.status?.error === 'string'
          ? result.FailedTransaction.status.error
          : JSON.stringify(result.FailedTransaction?.status?.error)
        : undefined,
  });
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(typeof err === 'string' ? err : JSON.stringify(err));
  }

  const T = result.Transaction;
  const signId = await resolveSignSessionId(
    adapter,
    Curve.ED25519,
    SignatureAlgorithm.EdDSA,
    T.effects,
    T.events,
  );
  if (!signId) throw new Error('Could not resolve Sign session id from transaction effects');
  console.warn('[chromatika][signMessageSolCore] resolved Sign session id, polling...', {
    signId: signId.slice(0, 20),
  });

  const tSign = Date.now();
  let sign: Awaited<ReturnType<typeof adapter.getSignInParticularState>>;
  try {
    sign = await withTransientSuiReadRetry(
      () =>
        adapter.getSignInParticularState(
          signId,
          Curve.ED25519,
          SignatureAlgorithm.EdDSA,
          'Completed',
          { timeout: 120_000 },
        ),
      { log: { graphqlUrl: graphqlUrlForNetwork(s.network), label: 'getSignInParticularState ed25519 sol' } },
    );
  } catch (pollErr) {
    console.warn(`[chromatika][signMessageSolCore] Sign session poll THREW after ${Date.now() - tSign}ms`, {
      signId: signId.slice(0, 20),
      errorMessage: pollErr instanceof Error ? pollErr.message : String(pollErr),
      errorName: pollErr instanceof Error ? pollErr.name : 'unknown',
    });
    throw pollErr;
  }
  console.warn(`[chromatika][signMessageSolCore] Sign session reached state in ${Date.now() - tSign}ms`, {
    signId: signId.slice(0, 20),
    stateKind: sign.state.$kind,
    fullStatePreview: JSON.stringify(sign.state)?.slice(0, 400),
  });
  if (sign.state.$kind !== 'Completed') {
    throw new Error(`Sign session not completed: ${sign.state.$kind}`);
  }
  const raw = Uint8Array.from(sign.state.Completed.signature);
  const hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
  return { signature: `0x${hex}`, signId };
}
