import { Curve, publicKeyFromDWalletOutput } from '@ika.xyz/sdk';
import { PublicKey } from '@solana/web3.js';
import { getSession } from '@/background/session';
import { resolveDwalletIdentity } from '@/background/dwallet-identity';
import { fetchSolanaDWalletAccount, isSuiIkaDwalletObjectId } from '@/background/ika/solana-dwallet-account-read';

/** Solana pre-alpha PDA stores raw 32-byte ed25519 pubkey, Sui ika stores a wasm-shaped `public_output` blob. */
async function ed25519PubkeyFromDwalletOutput(publicOutput: Uint8Array): Promise<Uint8Array> {
  try {
    return await publicKeyFromDWalletOutput(Curve.ED25519, publicOutput);
  } catch (wasmErr) {
    if (publicOutput.length === 32) return new Uint8Array(publicOutput);
    throw wasmErr;
  }
}

/** ed25519 public key bytes from a specific Active ED25519 dWallet object id. */
export async function getDwalletEd25519PublicKeyForDwalletId(dwalletId: string): Promise<Uint8Array> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  if (!isSuiIkaDwalletObjectId(dwalletId)) {
    if (!s.dwalletSolanaConnection) throw new Error('Solana RPC not configured');
    const { publicOutput, curveKey } = await fetchSolanaDWalletAccount(s.dwalletSolanaConnection, dwalletId);
    if (curveKey !== 'ED25519') {
      throw new Error(`Expected ED25519 dWallet for Solana/Sui identity (on-chain curve: ${curveKey})`);
    }
    return ed25519PubkeyFromDwalletOutput(publicOutput);
  }
  const dWallet = await s.ikaClient.getDWallet(dwalletId);
  const state = dWallet.state as { $kind: string; Active?: { public_output: number[] } };
  if (state.$kind !== 'Active') {
    throw new Error(`dWallet must be Active to derive addresses (current: ${state.$kind})`);
  }
  const publicOutput = Uint8Array.from(state.Active!.public_output);
  return ed25519PubkeyFromDwalletOutput(publicOutput);
}

/** ed25519 public key bytes from the ED25519 dWallet public output. */
export async function getDwalletEd25519PublicKey(): Promise<Uint8Array> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const { dwalletId } = await resolveDwalletIdentity('ED25519');
  if (!dwalletId) throw new Error('No ED25519 dWallet - create one first');
  return getDwalletEd25519PublicKeyForDwalletId(dwalletId);
}

/** base58-encoded Solana address from the ED25519 dWallet. */
export async function getSolanaAddress(): Promise<string> {
  const pubkey = await getDwalletEd25519PublicKey();
  return new PublicKey(pubkey).toBase58();
}

export async function getSolanaAddressForDwalletId(dwalletId: string): Promise<string> {
  const pubkey = await getDwalletEd25519PublicKeyForDwalletId(dwalletId);
  return new PublicKey(pubkey).toBase58();
}
