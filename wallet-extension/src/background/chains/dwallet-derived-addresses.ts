import { Curve, publicKeyFromDWalletOutput } from '@ika.xyz/sdk';
import { Point } from '@noble/secp256k1';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { computeAddress, hexlify } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import {
  compressedSecp256k1PubkeyFromDwalletOutput,
  p2wpkhAddress,
  p2trAddress,
  type BtcNetwork,
} from '@/background/chains/bitcoin';
import { encodeDeSoAddress } from '@/background/chains/deso/deso-address';
import { curveKeyFromDWallet } from '@/background/ika/dwallet-curve-key';
import {
  fetchSolanaDWalletAccount,
  isSuiIkaDwalletObjectId,
} from '@/background/ika/solana-dwallet-account-read';

function ed25519RailAddressesFromRaw32(pubkey32: Uint8Array): DwalletCapChainAddresses {
  if (pubkey32.length !== 32) {
    throw new Error(`expected 32-byte ed25519 public key, got ${pubkey32.length}`);
  }
  const input = new Uint8Array(pubkey32.length + 1);
  input.set(pubkey32);
  input[pubkey32.length] = 0x00;
  return {
    sui: new Ed25519PublicKey(pubkey32).toSuiAddress(),
    solana: new PublicKey(pubkey32).toBase58(),
    aptos: `0x${bytesToHex(sha3_256(input))}`,
  };
}

/** chain-facing addresses derived from an Active dWallet's on-chain `public_output`. */
export type DwalletCapChainAddresses = {
  evm?: string;
  btcP2wpkh?: string;
  btcP2tr?: string;
  sui?: string;
  solana?: string;
  aptos?: string;
  /**
   * DeSo mainnet `BC1Y...` address. derived from the same SECP256K1 compressed pubkey that
   * produces `evm` / `btcP2wpkh` / `btcP2tr` - just a different encoding (base58check + DeSo
   * prefix). only populated for SECP256K1 dwallets in Active state.
   */
  deso?: string;
  /** DeSo testnet `tBC1...` address. same compressed pubkey, testnet prefix bytes. */
  desoTestnet?: string;
};

/**
 * map ika dWallet public output bytes to user-visible addresses for this curve.
 * caller must only pass Active dWallet output (same path as `publicKeyFromDWalletOutput` in ika SDK).
 */
export async function deriveChainAddressesFromActivePublicOutput(
  curveKey: CurveKey,
  publicOutput: Uint8Array,
  btcNetwork: BtcNetwork = 'mainnet',
): Promise<DwalletCapChainAddresses> {
  if (curveKey === 'SECP256K1') {
    const compressed = await compressedSecp256k1PubkeyFromDwalletOutput(publicOutput);
    const uncompressed = Point.fromBytes(compressed).toBytes(false);
    return {
      evm: computeAddress(hexlify(uncompressed)),
      btcP2wpkh: p2wpkhAddress(compressed, btcNetwork),
      btcP2tr: p2trAddress(compressed, btcNetwork),
      // same compressed secp pubkey as evm/btc, just base58check'd with the DeSo prefix.
      deso: encodeDeSoAddress(compressed, 'mainnet'),
      desoTestnet: encodeDeSoAddress(compressed, 'testnet'),
    };
  }
  let pubkey: Uint8Array;
  try {
    pubkey = await publicKeyFromDWalletOutput(Curve.ED25519, publicOutput);
  } catch (wasmErr) {
    /** Solana pre-alpha persists raw 32-byte keys in the DWallet account, Sui stores ika wasm-shaped `public_output`. */
    if (publicOutput.length === 32) {
      return ed25519RailAddressesFromRaw32(publicOutput);
    }
    throw wasmErr;
  }
  const input = new Uint8Array(pubkey.length + 1);
  input.set(pubkey);
  input[pubkey.length] = 0x00;
  return {
    sui: new Ed25519PublicKey(pubkey).toSuiAddress(),
    solana: new PublicKey(pubkey).toBase58(),
    aptos: `0x${bytesToHex(sha3_256(input))}`,
  };
}

/** MoveEnum JSON sometimes omits `$kind`, infer from variant fields (GraphQL / older clients). */
export function readDwalletStateKind(state: unknown): string {
  if (!state || typeof state !== 'object') return 'unknown';
  const s = state as Record<string, unknown>;
  if (typeof s.$kind === 'string') return s.$kind;
  if ('Active' in s && s.Active) return 'Active';
  if ('AwaitingKeyHolderSignature' in s && s.AwaitingKeyHolderSignature) return 'AwaitingKeyHolderSignature';
  return 'unknown';
}

export function activePublicOutputFromState(state: unknown): number[] | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const active = (state as Record<string, unknown>).Active;
  if (active && typeof active === 'object') {
    const po = (active as { public_output?: number[] }).public_output;
    if (Array.isArray(po) && po.length) return po;
  }
  return undefined;
}

function awaitingKhPublicOutputFromState(state: unknown): number[] | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const zt = (state as Record<string, unknown>).AwaitingKeyHolderSignature;
  if (zt && typeof zt === 'object') {
    const po = (zt as { public_output?: number[] }).public_output;
    if (Array.isArray(po) && po.length) return po;
  }
  return undefined;
}

/** prefer Active, fall back to zero-trust pending output so deposit addresses can show before completion. */
export function publicOutputForChainAddresses(state: unknown): number[] | undefined {
  return activePublicOutputFromState(state) ?? awaitingKhPublicOutputFromState(state);
}

/**
 * load a dWallet by id and return chain addresses whenever `public_output` bytes exist on-chain
 * (any state ika exposes them on, not gated on `$kind === Active`).
 */
export async function chainAddressesForDwalletId(
  dwalletId: string,
  btcNetwork: BtcNetwork = 'mainnet',
): Promise<{ status: string; curve: CurveKey | 'unknown'; addresses: DwalletCapChainAddresses }> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const trimmed = dwalletId.trim();
  if (!isSuiIkaDwalletObjectId(trimmed)) {
    if (!s.dwalletSolanaConnection) {
      return { status: 'unknown', curve: 'unknown', addresses: {} };
    }
    try {
      const { curveKey, publicOutput } = await fetchSolanaDWalletAccount(s.dwalletSolanaConnection, trimmed);
      const addresses = await deriveChainAddressesFromActivePublicOutput(curveKey, publicOutput, btcNetwork);
      return { status: 'Active', curve: curveKey, addresses };
    } catch (err) {
      console.warn('[chromatika][dwallet-derive] chainAddressesForDwalletId solana failed', {
        dwallet: trimmed,
        err: err instanceof Error ? err.message : String(err),
      });
      return { status: 'unknown', curve: 'unknown', addresses: {} };
    }
  }
  const dWallet = await s.ikaClient.getDWallet(trimmed);
  const curveKey = curveKeyFromDWallet(dWallet as { curve?: unknown }) ?? 'unknown';

  const state = dWallet.state;
  const kind = readDwalletStateKind(state);
  const addresses: DwalletCapChainAddresses = {};

  if (curveKey === 'unknown') {
    return { status: kind, curve: curveKey, addresses };
  }
  const raw = publicOutputForChainAddresses(state);
  if (!raw?.length) {
    return { status: kind, curve: curveKey, addresses };
  }
  try {
    const publicOutput = Uint8Array.from(raw);
    Object.assign(
      addresses,
      await deriveChainAddressesFromActivePublicOutput(curveKey, publicOutput, btcNetwork),
    );
  } catch {
    /* leave addresses empty */
  }
  return { status: kind, curve: curveKey, addresses };
}
