/**
 * runtime guard that ensures the in-extension ika fee account has enough SOL before an ika
 * operation runs. reads the per-vault `IkaFeeSettings` and:
 *
 *  - **`seeker_direct` mode:** no-op. every gRPC `approve_message` is signed on the phone via
 *    the unlock-time fallthrough in the `solanaIkaGrpc` builder; there's no fee account to
 *    fund.
 *  - **`in_extension` mode + balance >= threshold:** no-op.
 *  - **`in_extension` mode + balance < threshold + `autoRefill: true`:** build a transfer tx
 *    `seeker -> feePayer` for `(refillLamports - currentBalance)`, enqueue a hardware sign
 *    via the same popup pattern used by every other Seeker tx (vendor: 'walletconnect' or 'mwa'),
 *    submit, await confirmation. one Seeker prompt with copy that says "Refill ika fee account
 *    with X SOL" - the user always knows what they're signing.
 *  - **`in_extension` mode + balance < threshold + `autoRefill: false`:** throw
 *    `IkaFeesLowError`. caller catches and surfaces a manual-refill UI.
 *
 * concurrency: `ensureFeePayerFunded` is mutexed per vault id so two ika ops starting at the
 * same time only fire one refill prompt.
 *
 * manual ops: `topUpFeePayerFromSeeker` and `drainFeePayerToSeeker` expose the same primitives
 * to the settings panel for explicit user-driven top-ups and drains. they share the transfer-tx
 * construction with the auto-refill path.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import type { SessionState } from '@/background/session';
import { confirmSolanaTxByPolling } from '@/background/chains/solana-confirm';
import { getIkaFeeSettings } from '@/background/ika/fee-settings';
import { enqueueHardwareSign } from '@/background/hardware/pending-queue';
import { hexNo0xToUint8, uint8ToHexNo0x } from '@/background/util/bytes-hex';
import { loadVaultPayloadWithKey } from '@/background/vault-store';
import { solanaClusterLabelForNetworkId, wcSolanaChainIdForCluster } from '@/config/wc';

/**
 * error thrown by `ensureFeePayerFunded` when the user has disabled auto-refill and the fee
 * account is below threshold. caller catches this to show a "fees low - top up?" UI rather
 * than letting the underlying ika op fail with an opaque insufficient-funds error.
 */
export class IkaFeesLowError extends Error {
  readonly feePayerAddress: string;
  readonly balanceLamports: bigint;
  readonly thresholdLamports: bigint;

  constructor(args: {
    feePayerAddress: string;
    balanceLamports: bigint;
    thresholdLamports: bigint;
  }) {
    super(
      `ika fee account is low (${args.balanceLamports} lamports < threshold ${args.thresholdLamports}). Top up manually from settings, or enable auto-refill.`,
    );
    this.name = 'IkaFeesLowError';
    this.feePayerAddress = args.feePayerAddress;
    this.balanceLamports = args.balanceLamports;
    this.thresholdLamports = args.thresholdLamports;
  }
}

/** per-vault refill mutex so concurrent ika ops only enqueue one Seeker prompt. */
const refillInFlight = new Map<string, Promise<void>>();

function getSeekerSolanaAddress(s: SessionState): string | null {
  if (s.solanaWcAccount?.address) return s.solanaWcAccount.address;
  if (s.solanaMwaAccount?.address) return s.solanaMwaAccount.address;
  return null;
}

function feePayerPublicKey(s: SessionState): PublicKey | null {
  return s.solanaFeePayer?.publicKey ?? null;
}

function pickSolanaConnection(s: SessionState): Connection {
  // ika-side reads + writes share the dwallet RPC. top-up runs on the same RPC so the
  // confirmation matches what subsequent ika ops will see.
  return s.solanaConnection ?? s.dwalletSolanaConnection;
}

/**
 * build a legacy Solana transfer tx and enqueue a hardware sign on the user's phone wallet.
 * the popup signs via WC `solana_signTransaction` (or MWA `signTransactions`); we receive the
 * raw 64-byte ED25519 signature, attach it to the tx, broadcast, and await confirmation.
 *
 * requires `s.solanaWcAccount` or `s.solanaMwaAccount` populated (i.e. a phone-paired Solana
 * hardware vault). throws otherwise.
 */
export async function topUpFeePayerFromSeeker(
  s: SessionState,
  lamports: bigint,
): Promise<{ txSignature: string }> {
  if (lamports <= 0n) throw new Error('topUpFeePayerFromSeeker: lamports must be positive');
  const seekerAddr = getSeekerSolanaAddress(s);
  if (!seekerAddr) throw new Error('No phone-paired Solana account on this session');
  const feePk = feePayerPublicKey(s);
  if (!feePk) throw new Error('No in-extension fee payer on this session');
  const fromPubkey = new PublicKey(seekerAddr);

  const connection = pickSolanaConnection(s);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey, toPubkey: feePk, lamports }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = fromPubkey;
  // wire bytes for the popup. legacy Transaction.serialize with relaxed signature requirements
  // produces the full wire format (header + accounts + blockhash + instructions + empty sigs
  // slot) - that's what the WC `solana_signTransaction` and MWA `signTransactions` calls expect.
  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

  let sigHex: string;
  if (s.solanaWcAccount) {
    sigHex = await enqueueHardwareSign({
      vendor: 'walletconnect',
      chain: 'solana',
      derivationPath: 'wc:solana',
      payloadHex: uint8ToHexNo0x(new Uint8Array(wire)),
      kind: 'solanaTx',
      wcSessionTopic: s.solanaWcAccount.sessionTopic,
      // the blockhash on `tx` was fetched via `s.solanaConnection`, which lives on
      // `s.solanaNetworkId`. send the request on that cluster's CAIP-2 chain id so
      // the wallet's pre-sign sanity check finds the blockhash; pair-time-frozen
      // mainnet chainId would make Jupiter / Phantom / Solflare reject ("there's a
      // problem with the transaction") on devnet ika pre-alpha builds.
      wcChainId: wcSolanaChainIdForCluster(s.solanaNetworkId),
      wcAccountAddress: s.solanaWcAccount.address,
      solanaCluster: solanaClusterLabelForNetworkId(s.solanaNetworkId),
    });
  } else if (s.solanaMwaAccount) {
    sigHex = await enqueueHardwareSign({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: s.solanaMwaAccount.derivationPath,
      payloadHex: uint8ToHexNo0x(new Uint8Array(wire)),
      kind: 'solanaTx',
      mwaTransport: s.solanaMwaAccount.transport,
      ...(s.solanaMwaAccount.authToken ? { mwaAuthToken: s.solanaMwaAccount.authToken } : {}),
      ...(s.solanaMwaAccount.reflectorHost ? { mwaReflectorHost: s.solanaMwaAccount.reflectorHost } : {}),
      solanaCluster: solanaClusterLabelForNetworkId(s.solanaNetworkId),
    });
  } else {
    throw new Error('topUpFeePayerFromSeeker: no phone-paired account on session');
  }
  const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
  const sigBytes = hexNo0xToUint8(digits);
  tx.addSignature(fromPubkey, Buffer.from(sigBytes));

  const raw = tx.serialize();
  const txSig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmSolanaTxByPolling(connection, txSig, { commitment: 'confirmed' });
  return { txSignature: txSig };
}

/**
 * send `lamports` from the in-extension fee payer back to the user's Seeker address. used by
 * the settings panel "drain to wallet" action - the fee payer keypair lives in the encrypted
 * vault, so we can sign locally with no phone prompt. if `lamports` is omitted, drain the
 * full balance (minus a tiny rent-exempt buffer so the account survives) but cap at the
 * fee-payer's current balance.
 *
 * if `feePayerSecretKeyB64` is provided, drain from that keypair instead of the session's
 * `solanaFeePayer`. this is the residual-funds path: when a user has flipped from
 * `in_extension` to `seeker_direct` without draining, the keypair lives in the vault record
 * but the session no longer loads it. the settings panel reads the record directly and
 * passes the keypair bytes here.
 */
export async function drainFeePayerToSeeker(
  s: SessionState,
  opts?: { lamports?: bigint; feePayerSecretKeyB64?: string },
): Promise<{ txSignature: string; lamportsSent: bigint }> {
  const seekerAddr = getSeekerSolanaAddress(s);
  if (!seekerAddr) throw new Error('No phone-paired Solana account on this session');
  const toPubkey = new PublicKey(seekerAddr);

  let payer: Keypair;
  if (opts?.feePayerSecretKeyB64) {
    const secret = Uint8Array.from(atob(opts.feePayerSecretKeyB64), (c) => c.charCodeAt(0));
    if (secret.length !== 64) throw new Error('feePayerSecretKeyB64 must decode to 64 bytes');
    payer = Keypair.fromSecretKey(secret);
  } else if (s.solanaFeePayer) {
    payer = s.solanaFeePayer;
  } else {
    throw new Error('No in-extension fee payer to drain');
  }

  const connection = pickSolanaConnection(s);
  const balance = BigInt(await connection.getBalance(payer.publicKey));
  // Solana System Program transfer fee is ~5000 lamports; leave a small buffer so the tx itself
  // can be paid by the source. cap requested amount to (balance - feeBuffer).
  const FEE_BUFFER_LAMPORTS = 5_000n;
  if (balance <= FEE_BUFFER_LAMPORTS) {
    throw new Error(`Fee payer balance (${balance}) too low to cover transfer fee`);
  }
  const max = balance - FEE_BUFFER_LAMPORTS;
  const lamports = opts?.lamports != null ? (opts.lamports < max ? opts.lamports : max) : max;
  if (lamports <= 0n) throw new Error('Nothing to drain');

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey, lamports }),
  );
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);
  const raw = tx.serialize();
  const txSig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmSolanaTxByPolling(connection, txSig, { commitment: 'confirmed' });
  return { txSignature: txSig, lamportsSent: lamports };
}

/**
 * read the in-extension fee payer's lamports balance from the active session, or `null` when
 * the active vault is not in `in_extension` mode (no fee payer to query).
 */
export async function ikaFeePayerBalanceLamports(s: SessionState): Promise<bigint | null> {
  const feePk = feePayerPublicKey(s);
  if (!feePk) return null;
  const connection = pickSolanaConnection(s);
  const balance = await connection.getBalance(feePk);
  return BigInt(balance);
}

/**
 * read the lamports balance of an arbitrary fee-payer address (used by the settings panel to
 * surface residual balances on "abandoned" keypairs from prior dev installs or post-mode-flip
 * vaults).
 */
export async function ikaFeePayerBalanceLamportsForAddress(
  s: SessionState,
  address: string,
): Promise<bigint> {
  const connection = pickSolanaConnection(s);
  const balance = await connection.getBalance(new PublicKey(address));
  return BigInt(balance);
}

/**
 * look up the encrypted vault and return the in-extension fee-payer keypair material for
 * `vaultId`, if any. used by the settings panel when surfacing residual balances - the
 * session may not load the keypair (because the user flipped to `seeker_direct`), but the
 * keypair still lives in the encrypted blob.
 */
export async function readFeePayerSecretKeyB64ForVault(
  s: SessionState,
  vaultId: string,
): Promise<string | null> {
  const payload = await loadVaultPayloadWithKey(s.vaultKey);
  const v = payload.vaults.find((x) => x.id === vaultId);
  if (!v || v.accountKind !== 'hardware') return null;
  const b64 = v.ikaGrpcFeePayerSolSecretKeyB64?.trim();
  return b64 || null;
}

/**
 * returns the fee-payer's public address for a vault by reading the encrypted blob and
 * decoding `ikaGrpcFeePayerSolSecretKeyB64`. returns `null` when the vault has no in-extension
 * fee payer (seeker_direct vault that was created in that mode from the start).
 */
export async function readFeePayerAddressForVault(
  s: SessionState,
  vaultId: string,
): Promise<string | null> {
  const b64 = await readFeePayerSecretKeyB64ForVault(s, vaultId);
  if (!b64) return null;
  const secret = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (secret.length !== 64) return null;
  return Keypair.fromSecretKey(secret).publicKey.toBase58();
}

/**
 * pre-flight guard called at the start of each user-initiated ika operation. see module
 * doc-comment for the decision matrix.
 */
export async function ensureFeePayerFunded(s: SessionState): Promise<void> {
  if (s.activeVaultBaseChain !== 'solana') return;
  const settings = await getIkaFeeSettings(s.activeVaultId);
  if (settings.mode === 'seeker_direct') return;

  const feePk = feePayerPublicKey(s);
  if (!feePk) return; // no in-extension fee payer (shouldn't happen in `in_extension` mode unless something is desync'd)

  const connection = pickSolanaConnection(s);
  const balance = BigInt(await connection.getBalance(feePk));
  if (balance >= settings.thresholdLamports) return;

  if (!settings.autoRefill) {
    throw new IkaFeesLowError({
      feePayerAddress: feePk.toBase58(),
      balanceLamports: balance,
      thresholdLamports: settings.thresholdLamports,
    });
  }

  // auto-refill, mutexed per vault to coalesce concurrent ika ops.
  const vaultId = s.activeVaultId;
  const existing = refillInFlight.get(vaultId);
  if (existing) return existing;
  const needed = settings.refillLamports - balance;
  const flight = (async () => {
    try {
      await topUpFeePayerFromSeeker(s, needed);
    } finally {
      refillInFlight.delete(vaultId);
    }
  })();
  refillInFlight.set(vaultId, flight);
  return flight;
}
