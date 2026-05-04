/**
 * derive scan candidate addresses per onboarding method.
 *
 * for HD mnemonics, this iterates account indices 0..gap_limit and produces sui + solana + evm
 * addresses per index using chromatika's existing `deriveSuiKeypair` / `deriveSolanaKeypair`
 * helpers + ethers v6 `HDNodeWallet` for evm. matches phantom / metamask account derivation.
 *
 * for passkey / seeker / waap / lazor, the identity address is fixed - we produce exactly one
 * candidate row with the supplied address. accountIndex is undefined.
 *
 * **note**: this module derives ADDRESSES only. it does NOT derive ika `UserShareEncryptionKeys`
 * (those need the prf secret / signature / etc., which we don't pass in for an activity scan).
 * dwallet count = owned-cap count, computed in the orchestrator separately.
 */

import { HDNodeWallet, Mnemonic } from 'ethers';
import { PublicKey, Keypair as SolanaKeypair } from '@solana/web3.js';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveSolanaKeypair, deriveSuiKeypair } from '@/background/keyring/hd';
import { slip10Ed25519DerivePath } from '@/background/keyring/slip10-ed25519-path';
import type { ScanCandidate, ScanGapLimits, ScanInput } from '@/background/scan/scan-types';

const DEFAULT_ACCOUNT_GAP = 5;
const DEFAULT_HARD_LIMIT = 20;

/**
 * solana addresses must be base58 of a 32-byte ed25519 pubkey. lazor's portal currently returns
 * a P-256 webauthn pubkey (base64) which chromatika persists as `lazorSmartWalletPubkeyB58` as
 * a v1 placeholder - the canonical solana smart-wallet PDA needs `LazorkitClient.getSmartWalletByCredentialHash`
 * to resolve. until that lands, this guard prevents the bad value from reaching `new PublicKey()`
 * (which throws "Non-base58 character") downstream in the solana probe.
 */
function isValidSolanaBase58Address(addr: string | undefined): addr is string {
  if (!addr) return false;
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

export type DerivationOptions = {
  /** how far past the last "active" account to keep scanning. default 5 (bip44 standard). */
  accountIndexGap?: number;
  /** hard ceiling on accountIndex to scan even if every slot has activity. default 20. */
  maxIndexHardLimit?: number;
};

/**
 * for HD inputs, produce a flat list of `gap`-limit candidates BEFORE probing. the orchestrator
 * tightens this list based on observed activity (stop once `gap` consecutive empty slots are
 * seen). passing the full list up front avoids re-deriving keypairs during the inner probe loop.
 */
export function buildHdCandidates(mnemonic: string, opts: DerivationOptions = {}): ScanCandidate[] {
  const gap = opts.accountIndexGap ?? DEFAULT_ACCOUNT_GAP;
  const hardLimit = Math.min(opts.maxIndexHardLimit ?? DEFAULT_HARD_LIMIT, 50);
  // scan up to hardLimit indices; the orchestrator decides where to stop.
  const candidates: ScanCandidate[] = [];
  // ethers v6: build a master node from the mnemonic seed; only the master (depth=0) accepts
  // absolute "m/..." derivation paths. constructing once + calling derivePath per index is much
  // cheaper than re-parsing the phrase each iteration.
  const seed = Mnemonic.fromPhrase(mnemonic).computeSeed();
  const evmRoot = HDNodeWallet.fromSeed(seed);
  // polkadot ed25519 reuses chromatika's slip-10 helper at the substrate-standard path. seed hex
  // is stable per mnemonic; derive once outside the loop.
  const seedHexForSubstrate = bytesToHex(mnemonicToSeedSync(mnemonic));
  for (let i = 0; i < hardLimit + gap; i++) {
    const suiKp = deriveSuiKeypair(mnemonic, i);
    const solKp = deriveSolanaKeypair(mnemonic, i);
    // m/44'/60'/N'/0/0 - account-level hardened, then standard external chain + first index.
    const evmKid = evmRoot.derivePath(`44'/60'/${i}'/0/0`);
    // ethers exposes the compressed (33-byte) secp pubkey as `signingKey.compressedPublicKey`
    // (`0x...` hex). strip the prefix - we surface the raw hex so DeSo / future secp probes can
    // encode their own address shape without re-deriving the keypair.
    const compressedHex = evmKid.signingKey.compressedPublicKey.replace(/^0x/, '');
    // polkadot/substrate ed25519 at m/44'/354'/N'/0'/0' (standard substrate path). slip-10
    // produces a 64-byte derived buffer; we use the first 32 bytes as the ed25519 seed and
    // derive the public key via solana's ed25519 keypair (same noble curve impl underneath).
    const polkadotPath = `m/44'/354'/${i}'/0'/0'`;
    const polkadotDerived = slip10Ed25519DerivePath(polkadotPath, seedHexForSubstrate);
    const polkadotKp = SolanaKeypair.fromSeed(polkadotDerived.key.slice(0, 32));
    const polkadotPubkeyHex = bytesToHex(polkadotKp.publicKey.toBytes());
    candidates.push({
      key: `hd:account=${i}`,
      accountIndex: i,
      suiAddress: suiKp.toSuiAddress(),
      solanaAddress: solKp.publicKey.toBase58(),
      evmAddress: evmKid.address,
      secp256k1CompressedHex: compressedHex,
      polkadotEd25519PubkeyHex: polkadotPubkeyHex,
    });
  }
  return candidates;
}

/** single-row candidate for identity-bound methods (passkey / seeker / waap / lazor). */
export function buildIdentityCandidate(input: Exclude<ScanInput, { method: 'hd' }>): ScanCandidate {
  switch (input.method) {
    case 'passkey':
      return { key: 'passkey:single', suiAddress: input.suiAddress };
    case 'seeker':
      // seeker pairing already produces a base58-encoded solana pubkey; defensive validation
      // here is mostly future-proofing in case a pairing path drifts.
      return {
        key: 'seeker:single',
        solanaAddress: isValidSolanaBase58Address(input.solanaAddress) ? input.solanaAddress : undefined,
      };
    case 'waap':
      return { key: 'waap:single', suiAddress: input.suiAddress };
    case 'lazor':
      // lazor v1 persists the passkey P-256 pubkey (base64) here as a placeholder for the canonical
      // smart-wallet PDA. when it isn't valid base58 we drop the address so the solana probe is
      // SKIPPED entirely rather than throwing "Non-base58 character" - the orchestrator surfaces a
      // dedicated note in the result so the user knows why the solana scan was empty.
      return {
        key: 'lazor:single',
        solanaAddress: isValidSolanaBase58Address(input.lazorSmartWalletPubkeyB58)
          ? input.lazorSmartWalletPubkeyB58
          : undefined,
      };
    default: {
      const _exhaustive: never = input;
      throw new Error(`unhandled scan method: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** dispatch helper used by the orchestrator. */
export function buildCandidates(input: ScanInput, gap: ScanGapLimits = {}): ScanCandidate[] {
  if (input.method === 'hd') {
    return buildHdCandidates(input.mnemonic, gap);
  }
  return [buildIdentityCandidate(input)];
}
