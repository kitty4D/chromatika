import { sha3_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  AccountAuthenticatorEd25519,
  Aptos,
  AptosConfig,
  Deserializer,
  Ed25519PublicKey,
  Ed25519Signature,
  Network,
  SimpleTransaction,
  generateSigningMessageForTransaction,
  type InputGenerateTransactionOptions,
  type InputGenerateTransactionPayloadData,
} from '@aptos-labs/ts-sdk';
import { getSession } from '@/background/session';
import { getDwalletEd25519PublicKey, getDwalletEd25519PublicKeyForDwalletId } from './solana';
import { signMessageSol } from '@/background/chains/signing';
import { getActiveNetworks } from '@/background/network/active-network';
import { BUILTIN_APTOS } from '@/config/networks';

// --- public API ---

/**
 * aptos account address from a 32-byte ed25519 public key.
 * derivation: SHA3-256(pubkey_32_bytes || 0x00) where 0x00 = single ed25519 auth scheme tag.
 */
function aptosAddressFromPubkey(pubkey: Uint8Array): string {
  const input = new Uint8Array(pubkey.length + 1);
  input.set(pubkey);
  input[pubkey.length] = 0x00;
  return '0x' + bytesToHex(sha3_256(input));
}

function aptosPubkeyHex(pubkey: Uint8Array): string {
  return '0x' + bytesToHex(pubkey);
}

export async function getAptosAddress(): Promise<string> {
  return aptosAddressFromPubkey(await getDwalletEd25519PublicKey());
}

export async function getAptosAddressForDwalletId(dwalletId: string): Promise<string> {
  return aptosAddressFromPubkey(await getDwalletEd25519PublicKeyForDwalletId(dwalletId));
}

/** raw ed25519 public key bytes as hex (0x-prefixed), used by the Aptos dapp provider. */
export async function getAptosPublicKeyHex(): Promise<string> {
  return aptosPubkeyHex(await getDwalletEd25519PublicKey());
}

export async function getAptosPublicKeyHexForDwalletId(dwalletId: string): Promise<string> {
  return aptosPubkeyHex(await getDwalletEd25519PublicKeyForDwalletId(dwalletId));
}

/** aptos message signing via ika MPC (ed25519 + EDDSA + SHA512), same path as Sui/Solana personal message. */
export async function signMessageAptos(
  message: Uint8Array,
  opts?: { ed25519DwalletId?: string },
): Promise<{ signature: string; signId: string }> {
  return signMessageSol(message, opts);
}

function parseAptosWalletTransactionData(
  body: unknown,
): { data: InputGenerateTransactionPayloadData; options?: InputGenerateTransactionOptions } {
  if (!body || typeof body !== 'object') throw new Error('invalid Aptos transaction payload');
  const o = body as Record<string, unknown>;
  const pickData = (d: Record<string, unknown>): InputGenerateTransactionPayloadData => {
    const fn = d.function as string | undefined;
    const fnArgs = (d.functionArguments ?? d.arguments) as unknown[] | undefined;
    if (!fn || !Array.isArray(fnArgs)) {
      throw new Error('Aptos payload needs function and functionArguments (or arguments)');
    }
    return {
      function: fn,
      typeArguments: Array.isArray(d.typeArguments) ? (d.typeArguments as string[]) : [],
      functionArguments: fnArgs,
    } as InputGenerateTransactionPayloadData;
  };
  if ('data' in o && o.data && typeof o.data === 'object') {
    return {
      data: pickData(o.data as Record<string, unknown>),
      options: o.options as InputGenerateTransactionOptions | undefined,
    };
  }
  return {
    data: pickData(o),
    options: o.options as InputGenerateTransactionOptions | undefined,
  };
}

export async function createAptosClientForWallet(): Promise<Aptos> {
  const { aptNetworkId } = await getActiveNetworks();
  const cfg = BUILTIN_APTOS.find((n) => n.id === aptNetworkId) ?? BUILTIN_APTOS[0];
  return new Aptos(
    new AptosConfig({
      network: Network.CUSTOM,
      fullnode: cfg.rpcUrl,
    }),
  );
}

/** ed25519 authenticator for a built `SimpleTransaction` (shared by submit + AIP-62 `aptos:signTransaction`). */
export async function signAptosSimpleTransactionAuthenticator(
  simpleTxn: SimpleTransaction,
  opts?: { ed25519DwalletId?: string },
): Promise<AccountAuthenticatorEd25519> {
  const dwalletId = opts?.ed25519DwalletId;
  const signingMessage = generateSigningMessageForTransaction(simpleTxn);
  const { signature: sigHex } = await signMessageAptos(signingMessage, {
    ed25519DwalletId: dwalletId,
  });
  const sigBytes = Uint8Array.from(
    sigHex.replace(/^0x/i, '').match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
  );
  const pkHex = dwalletId
    ? await getAptosPublicKeyHexForDwalletId(dwalletId)
    : await getAptosPublicKeyHex();
  const pub = new Ed25519PublicKey(pkHex);
  const edSig = new Ed25519Signature(sigBytes);
  if (!pub.verifySignature({ message: signingMessage, signature: edSig })) {
    throw new Error('ika signature failed Aptos verification on signing message');
  }
  return new AccountAuthenticatorEd25519(pub, edSig);
}

/**
 * AIP-62 `aptos:signTransaction` (wallet standard): deserialize a `SimpleTransaction` BCS payload,
 * sign with the ED25519 dWallet, return authenticator BCS (page deserializes to `AccountAuthenticator`).
 */
export async function signAptosTransactionFromBcs(
  bcs: Uint8Array,
  opts?: { ed25519DwalletId?: string },
): Promise<Uint8Array> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const des = new Deserializer(bcs);
  const simpleTxn = SimpleTransaction.deserialize(des);
  const auth = await signAptosSimpleTransactionAuthenticator(simpleTxn, opts);
  return auth.bcsToBytes();
}

/** petra-style `{ name, chainId, url }` from the active Aptos preset in chrome.storage. */
export async function getAptosNetworkInfoForDapp(): Promise<{ name: string; chainId: string; url: string }> {
  const { aptNetworkId } = await getActiveNetworks();
  const net = BUILTIN_APTOS.find((n) => n.id === aptNetworkId) ?? BUILTIN_APTOS[0];
  const name = net.id.includes('devnet') ? 'devnet' : net.id.includes('testnet') ? 'testnet' : 'mainnet';
  const chainId = net.id === 'apt-mainnet' ? '1' : net.id === 'apt-testnet' ? '2' : '3';
  return { name, chainId, url: net.rpcUrl };
}

export async function signAndSubmitAptosFromDapp(
  input: unknown,
  opts?: { ed25519DwalletId?: string },
) {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const aptos = await createAptosClientForWallet();
  const dwalletId = opts?.ed25519DwalletId;
  const senderAddr = dwalletId ? await getAptosAddressForDwalletId(dwalletId) : await getAptosAddress();
  const { data, options } = parseAptosWalletTransactionData(input);

  const simpleTxn = await aptos.transaction.build.simple({
    sender: senderAddr,
    data,
    options,
  });

  const authenticator = await signAptosSimpleTransactionAuthenticator(simpleTxn, {
    ed25519DwalletId: dwalletId,
  });
  return aptos.transaction.submit.simple({
    transaction: simpleTxn,
    senderAuthenticator: authenticator,
  });
}
