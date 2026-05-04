import { PublicKey, Transaction as SolanaLegacyTransaction } from '@solana/web3.js';
import { getSession } from '@/background/session';
import {
  sendApproveMessageForEd25519Sign,
  sendApproveMessageForSecp256k1Sign,
} from '@/background/ika/solana-approve-message';
import { enqueueHardwareSign } from '@/background/hardware/pending-queue';
import { ensureFeePayerFunded } from '@/background/ika/ensure-fee-payer-funded';
import { updateCurrentOperationStage } from '@/background/progress/operation-progress';
import { hexNo0xToUint8, uint8ToHexNo0x } from '@/background/util/bytes-hex';
import { solanaClusterLabelForNetworkId, wcSolanaChainIdForCluster } from '@/config/wc';
import { DWalletGoneError, isDWalletGoneServerMessage } from '@/background/ika/errors';
import { b64ToU8Local, hexToU8 } from './internal';

type SolanaCluster = 'devnet' | 'testnet' | 'localnet' | 'mainnet';

function clusterFromSession(s: NonNullable<ReturnType<typeof getSession>>): SolanaCluster {
  const label = solanaClusterLabelForNetworkId(s.solanaNetworkId);
  return label === 'devnet' || label === 'testnet' || label === 'localnet'
    ? (label as SolanaCluster)
    : 'mainnet';
}

export async function signSecp256k1MessageSolanaGrpc(
  message: Uint8Array,
  presignIdHex: string,
  dwalletId: string,
  s: NonNullable<ReturnType<typeof getSession>>,
  hashScheme: 'Keccak256' | 'DoubleSHA256',
): Promise<{ signature: string; signId: string }> {
  if (!s.solanaConnection || !s.solanaIkaGrpc) {
    throw new Error('Solana session not ready (connection / gRPC)');
  }
  // ika sign fires several `approve_message` gRPC calls under the hood. in `in_extension` fee
  // mode (the default), top up the in-extension fee account from the Seeker if it's below
  // threshold, one Seeker prompt before the signing chain runs. in `seeker_direct` mode this
  // is a no-op, every gRPC call surfaces its own phone prompt via the unlock-time fallthrough.
  await ensureFeePayerFunded(s);
  const feePk =
    s.solanaFeePayer?.publicKey
    ?? (s.solanaLedgerFee ? new PublicKey(s.solanaLedgerFee.feePayerPubkeyB58) : null)
    ?? (s.solanaMwaAccount ? new PublicKey(s.solanaMwaAccount.address) : null)
    ?? (s.solanaWcAccount ? new PublicKey(s.solanaWcAccount.address) : null);
  if (!feePk) throw new Error('Solana fee signer missing (keypair, Ledger, MWA, or WalletConnect)');

  const meta = s.dwalletMeta.SECP256K1;
  if (!meta || meta.dwalletId !== dwalletId || !meta.dwalletPublicKeyB64 || !meta.dwalletAttestationBytesB64) {
    throw new Error('Missing Solana SECP256K1 dWallet attestation, re-run DKG on 0.1.1');
  }
  const dwalletPublicKey = b64ToU8Local(meta.dwalletPublicKeyB64);

  const presignBytes = hexToU8(presignIdHex);
  const signAndSend = async (tx: SolanaLegacyTransaction): Promise<string> => {
    if (s.solanaFeePayer) {
      tx.sign(s.solanaFeePayer);
      const raw = tx.serialize();
      return s.solanaConnection!.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    }
    if (s.solanaLedgerFee) {
      const msg = tx.serializeMessage();
      const sigHex = await enqueueHardwareSign({
        vendor: 'ledger',
        chain: 'solana',
        derivationPath: s.solanaLedgerFee.derivationPath,
        payloadHex: uint8ToHexNo0x(new Uint8Array(msg)),
        kind: 'solanaTx',
      });
      const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
      const sigBytes = hexNo0xToUint8(digits);
      tx.addSignature(feePk, Buffer.from(sigBytes));
      const raw = tx.serialize();
      return s.solanaConnection!.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    }
    if (s.solanaMwaAccount) {
      const msg = tx.serializeMessage();
      const sigHex = await enqueueHardwareSign({
        vendor: 'mwa',
        chain: 'solana',
        derivationPath: s.solanaMwaAccount.derivationPath,
        payloadHex: uint8ToHexNo0x(new Uint8Array(msg)),
        kind: 'solanaTx',
        mwaTransport: s.solanaMwaAccount.transport,
        ...(s.solanaMwaAccount.authToken ? { mwaAuthToken: s.solanaMwaAccount.authToken } : {}),
        ...(s.solanaMwaAccount.reflectorHost ? { mwaReflectorHost: s.solanaMwaAccount.reflectorHost } : {}),
        solanaCluster: solanaClusterLabelForNetworkId(s.solanaNetworkId),
      });
      const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
      const sigBytes = hexNo0xToUint8(digits);
      tx.addSignature(feePk, Buffer.from(sigBytes));
      const raw = tx.serialize();
      return s.solanaConnection!.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    }
    if (s.solanaWcAccount) {
      const msg = tx.serializeMessage();
      const sigHex = await enqueueHardwareSign({
        vendor: 'walletconnect',
        chain: 'solana',
        derivationPath: 'wc:solana',
        payloadHex: uint8ToHexNo0x(new Uint8Array(msg)),
        kind: 'solanaTx',
        wcSessionTopic: s.solanaWcAccount.sessionTopic,
        // send on the chainId of the cluster the broadcast actually targets
        // (`s.solanaConnection`), not the pair-time-frozen mainnet chainId. see
        // doc-comment in `ensure-fee-payer-funded.ts:topUpFeePayerFromSeeker` for
        // why the frozen value causes Jupiter/Phantom-class wallets to reject.
        wcChainId: wcSolanaChainIdForCluster(s.solanaNetworkId),
        wcAccountAddress: s.solanaWcAccount.address,
        solanaCluster: solanaClusterLabelForNetworkId(s.solanaNetworkId),
      });
      const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
      const sigBytes = hexNo0xToUint8(digits);
      tx.addSignature(feePk, Buffer.from(sigBytes));
      const raw = tx.serialize();
      return s.solanaConnection!.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    }
    throw new Error('No Solana fee material for approve_message');
  };

  const { txSigBytes, slot } = await sendApproveMessageForSecp256k1Sign(
    s.solanaConnection,
    feePk,
    { dwalletPublicKey, message, hashScheme },
    signAndSend,
  );
  let sig64: Uint8Array;
  try {
    sig64 = await s.solanaIkaGrpc.requestSignSecp256k1Message(
      message,
      dwalletId,
      presignBytes,
      txSigBytes,
      slot,
      { dwalletAttestationBytesB64: meta.dwalletAttestationBytesB64 },
    );
  } catch (e) {
    // see `signMessageSolSolanaGrpc` for the rationale.
    const cluster = clusterFromSession(s);
    const msg = e instanceof Error ? e.message : String(e);
    if (cluster !== 'mainnet' && isDWalletGoneServerMessage(msg)) {
      throw new DWalletGoneError({ curve: 'SECP256K1', cluster, serverMessage: msg });
    }
    throw e;
  }
  const hex = Array.from(sig64, (b) => b.toString(16).padStart(2, '0')).join('');
  return { signature: `0x${hex}`, signId: 'solana-ika-grpc-secp' };
}

export async function signMessageSolSolanaGrpc(
  message: Uint8Array,
  presignIdHex: string,
  dwalletId: string,
  s: NonNullable<ReturnType<typeof getSession>>,
): Promise<{ signature: string; signId: string }> {
  if (!s.solanaConnection || !s.solanaIkaGrpc) {
    throw new Error('Solana session not ready (connection / gRPC)');
  }
  // see `signSecp256k1MessageSolanaGrpc` for the rationale, same auto-refill guard runs here.
  await ensureFeePayerFunded(s);
  const feePk =
    s.solanaFeePayer?.publicKey
    ?? (s.solanaLedgerFee ? new PublicKey(s.solanaLedgerFee.feePayerPubkeyB58) : null)
    ?? (s.solanaMwaAccount ? new PublicKey(s.solanaMwaAccount.address) : null)
    ?? (s.solanaWcAccount ? new PublicKey(s.solanaWcAccount.address) : null);
  if (!feePk) throw new Error('Solana fee signer missing (keypair, Ledger, MWA, or WalletConnect)');

  const presignBytes = hexToU8(presignIdHex);
  const signAndSend = async (tx: SolanaLegacyTransaction): Promise<string> => {
    if (s.solanaFeePayer) {
      tx.sign(s.solanaFeePayer);
      const raw = tx.serialize();
      return s.solanaConnection!.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    }
    if (s.solanaLedgerFee) {
      const msg = tx.serializeMessage();
      const sigHex = await enqueueHardwareSign({
        vendor: 'ledger',
        chain: 'solana',
        derivationPath: s.solanaLedgerFee.derivationPath,
        payloadHex: uint8ToHexNo0x(new Uint8Array(msg)),
        kind: 'solanaTx',
      });
      const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
      const sigBytes = hexNo0xToUint8(digits);
      tx.addSignature(feePk, Buffer.from(sigBytes));
      const raw = tx.serialize();
      return s.solanaConnection!.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    }
    if (s.solanaMwaAccount) {
      const msg = tx.serializeMessage();
      const sigHex = await enqueueHardwareSign({
        vendor: 'mwa',
        chain: 'solana',
        derivationPath: s.solanaMwaAccount.derivationPath,
        payloadHex: uint8ToHexNo0x(new Uint8Array(msg)),
        kind: 'solanaTx',
        mwaTransport: s.solanaMwaAccount.transport,
        ...(s.solanaMwaAccount.authToken ? { mwaAuthToken: s.solanaMwaAccount.authToken } : {}),
        ...(s.solanaMwaAccount.reflectorHost ? { mwaReflectorHost: s.solanaMwaAccount.reflectorHost } : {}),
        solanaCluster: solanaClusterLabelForNetworkId(s.solanaNetworkId),
      });
      const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
      const sigBytes = hexNo0xToUint8(digits);
      tx.addSignature(feePk, Buffer.from(sigBytes));
      const raw = tx.serialize();
      return s.solanaConnection!.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    }
    if (s.solanaWcAccount) {
      const msg = tx.serializeMessage();
      const sigHex = await enqueueHardwareSign({
        vendor: 'walletconnect',
        chain: 'solana',
        derivationPath: 'wc:solana',
        payloadHex: uint8ToHexNo0x(new Uint8Array(msg)),
        kind: 'solanaTx',
        wcSessionTopic: s.solanaWcAccount.sessionTopic,
        // send on the chainId of the cluster the broadcast actually targets
        // (`s.solanaConnection`), not the pair-time-frozen mainnet chainId.
        wcChainId: wcSolanaChainIdForCluster(s.solanaNetworkId),
        wcAccountAddress: s.solanaWcAccount.address,
        solanaCluster: solanaClusterLabelForNetworkId(s.solanaNetworkId),
      });
      const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
      const sigBytes = hexNo0xToUint8(digits);
      tx.addSignature(feePk, Buffer.from(sigBytes));
      const raw = tx.serialize();
      return s.solanaConnection!.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: 'confirmed' });
    }
    throw new Error('No Solana fee material for approve_message');
  };

  const meta = s.dwalletMeta.ED25519;
  if (!meta || meta.dwalletId !== dwalletId || !meta.dwalletPublicKeyB64 || !meta.dwalletAttestationBytesB64) {
    throw new Error('Missing Solana ED25519 dWallet attestation, re-run DKG on 0.1.1');
  }
  const dwalletPublicKey = b64ToU8Local(meta.dwalletPublicKeyB64);
  await updateCurrentOperationStage('approve-message', 'Submitting approve_message tx to Solana');
  const { txSigBytes, slot } = await sendApproveMessageForEd25519Sign(
    s.solanaConnection,
    feePk,
    { dwalletPublicKey, message },
    signAndSend,
  );
  await updateCurrentOperationStage('ika-grpc-sign', 'Requesting Ika signature');
  let sig64: Uint8Array;
  try {
    sig64 = await s.solanaIkaGrpc.requestSignEd25519Message(
      message,
      dwalletId,
      presignBytes,
      txSigBytes,
      slot,
      { dwalletAttestationBytesB64: meta.dwalletAttestationBytesB64 },
    );
  } catch (e) {
    // convert the upstream "no key for dwallet" pre-alpha pattern into a typed exception so the
    // UI can offer a "recreate dWallet" recovery affordance. gated to non-mainnet clusters, on
    // mainnet (which Ika Solana pre-alpha doesn't actually run on per the disclaimer) we surface
    // the raw error verbatim, no automatic recovery prompt.
    //
    // we don't probe the on-chain PDA here: at sign time the DKG flow already polled
    // `pollForSolanaDwalletPda` to completion, so a still-existing PDA + "no key" almost always
    // means an ika node-state reset rather than NOA pipeline lag. gating recovery on PDA
    // existence leaves the user stuck with a dwallet that ika permanently can't sign for.
    const cluster = clusterFromSession(s);
    const msg = e instanceof Error ? e.message : String(e);
    if (cluster !== 'mainnet' && isDWalletGoneServerMessage(msg)) {
      throw new DWalletGoneError({ curve: 'ED25519', cluster, serverMessage: msg });
    }
    throw e;
  }
  const hex = Array.from(sig64, (b) => b.toString(16).padStart(2, '0')).join('');
  return { signature: `0x${hex}`, signId: 'solana-ika-grpc' };
}
