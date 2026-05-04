import { Curve, publicKeyFromDWalletOutput } from '@ika.xyz/sdk';
import { Point } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bech32, bech32m } from '@scure/base';
import { getSession } from '@/background/session';
import { resolveDwalletIdentity } from '@/background/dwallet-identity';
import { fetchSolanaDWalletAccount, isSuiIkaDwalletObjectId } from '@/background/ika/solana-dwallet-account-read';

export type BtcNetwork = 'mainnet' | 'testnet';

/** Solana program stores raw compressed (33) or padded SEC1, Sui stores ika wasm-shaped `public_output`. */
export function compressedSecpPubkeyFromSolanaStyleOutput(publicOutput: Uint8Array): Uint8Array {
  if (publicOutput.length === 33) return new Uint8Array(publicOutput);
  if (publicOutput.length === 65) return Point.fromBytes(publicOutput).toBytes(true);
  if (publicOutput.length === 64) {
    const u = new Uint8Array(65);
    u[0] = 0x04;
    u.set(publicOutput, 1);
    return Point.fromBytes(u).toBytes(true);
  }
  throw new Error(`unsupported secp256k1 dWallet public output length ${publicOutput.length}`);
}

export async function compressedSecp256k1PubkeyFromDwalletOutput(publicOutput: Uint8Array): Promise<Uint8Array> {
  try {
    return await publicKeyFromDWalletOutput(Curve.SECP256K1, publicOutput);
  } catch {
    return compressedSecpPubkeyFromSolanaStyleOutput(publicOutput);
  }
}

const NETWORK_HRP: Record<BtcNetwork, string> = {
  mainnet: 'bc',
  testnet: 'tb',
};

/** secp256k1 compressed public key from the SECP256K1 dWallet public output. */
export async function getDwalletSecpPublicKey(): Promise<Uint8Array> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const { dwalletId } = await resolveDwalletIdentity('SECP256K1');
  if (!dwalletId) throw new Error('No SECP256K1 dWallet — create one first');
  if (!isSuiIkaDwalletObjectId(dwalletId)) {
    if (!s.dwalletSolanaConnection) throw new Error('Solana RPC not configured');
    const { publicOutput, curveKey } = await fetchSolanaDWalletAccount(s.dwalletSolanaConnection, dwalletId);
    if (curveKey !== 'SECP256K1') {
      throw new Error(`Expected SECP256K1 dWallet for BTC/EVM identity (on-chain curve: ${curveKey})`);
    }
    return compressedSecp256k1PubkeyFromDwalletOutput(publicOutput);
  }
  const dWallet = await s.ikaClient.getDWallet(dwalletId);
  const state = dWallet.state as { $kind: string; Active?: { public_output: number[] } };
  if (state.$kind !== 'Active') {
    throw new Error(`dWallet must be Active to derive addresses (current: ${state.$kind})`);
  }
  const publicOutput = Uint8Array.from(state.Active!.public_output);
  return publicKeyFromDWalletOutput(Curve.SECP256K1, publicOutput);
}

/** p2wpkh (bc1q...) address from a compressed secp256k1 public key. */
export function p2wpkhAddress(pubkey: Uint8Array, network: BtcNetwork = 'mainnet'): string {
  const hash160 = ripemd160(sha256(pubkey));
  return bech32.encode(NETWORK_HRP[network], [0, ...bech32.toWords(hash160)]);
}

/** p2tr (bc1p...) address from a compressed secp256k1 public key (key-path only, no script tweak). */
export function p2trAddress(pubkey: Uint8Array, network: BtcNetwork = 'mainnet'): string {
  const xOnlyPubkey = pubkey.slice(1, 33); // drop 02/03 prefix
  return bech32m.encode(NETWORK_HRP[network], [1, ...bech32m.toWords(xOnlyPubkey)]);
}

export async function getBitcoinAddresses(
  network: BtcNetwork = 'mainnet',
): Promise<{ p2wpkh: string; p2tr: string }> {
  const pubkey = await getDwalletSecpPublicKey();
  return { p2wpkh: p2wpkhAddress(pubkey, network), p2tr: p2trAddress(pubkey, network) };
}

/**
 * wrap raw message bytes in the standard Bitcoin signed-message envelope:
 *   "\x18Bitcoin Signed Message:\n" + varint(len) + message
 * ika will then apply DoubleSHA256 to this envelope.
 */
export function bitcoinMessageBytes(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode('\x18Bitcoin Signed Message:\n');
  const len = message.length;
  let varint: number[];
  if (len < 0xfd) {
    varint = [len];
  } else if (len < 0x10000) {
    varint = [0xfd, len & 0xff, (len >> 8) & 0xff];
  } else {
    varint = [0xfe, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff];
  }
  const out = new Uint8Array(prefix.length + varint.length + message.length);
  out.set(prefix, 0);
  out.set(varint, prefix.length);
  out.set(message, prefix.length + varint.length);
  return out;
}
