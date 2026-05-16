import * as ed25519 from '@noble/ed25519';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { signMessageSol } from '@/background/chains/signing';
import {
  getDwalletEd25519PublicKey,
  getDwalletEd25519PublicKeyForDwalletId,
} from '@/background/chains/solana';
import { getSession } from '@/background/session';
import { BUILTIN_SOLANA } from '@/config/networks';
import { setDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import { getActiveVaultId, refreshSessionNetworkClients } from '@/background/wallet-service';

function hexSigToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (h.length !== 128) throw new Error('expected 64-byte Ed25519 signature (hex)');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

/**
 * signs a Solana wire transaction with the active ED25519 dWallet (ika presign pool).
 * verifies the ika output with standard ed25519 on the serialized message (Solana RPC expectation).
 */
export async function signSolanaTransactionWire(
  wire: Uint8Array,
  opts?: { ed25519DwalletId?: string },
): Promise<Uint8Array> {
  console.warn('[chromatika][solana-tx-sign] begin', { wireLen: wire.length, edId: opts?.ed25519DwalletId });
  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(wire);
  } catch (e) {
    throw new Error(`invalid Solana transaction: ${e instanceof Error ? e.message : String(e)}`);
  }

  const messageBytes = vtx.message.serialize();
  const edId = opts?.ed25519DwalletId;
  const pubkeyBytes = edId
    ? await getDwalletEd25519PublicKeyForDwalletId(edId)
    : await getDwalletEd25519PublicKey();
  const ourPk = new PublicKey(pubkeyBytes);
  console.warn('[chromatika][solana-tx-sign] pubkey resolved', { ourPk: ourPk.toBase58() });

  const signerKeys = vtx.message.staticAccountKeys.slice(0, vtx.message.header.numRequiredSignatures);
  const signerAddrs = signerKeys.map((pk) => pk.toBase58());
  console.warn('[chromatika][solana-tx-sign] required signers', { signerAddrs, numRequired: vtx.message.header.numRequiredSignatures });
  if (!signerKeys.some((pk) => pk.equals(ourPk))) {
    throw new Error('Chromatika wallet is not a required signer for this transaction');
  }

  // preflight: cluster-mismatch detection + auto-switch.
  //
  // the dapp picks a `recentBlockhash` from its own RPC; that blockhash is only valid on
  // the cluster the dapp built on. if our wallet is on a different Solana cluster, the
  // dapp's broadcast will fail with "Blockhash not found" after we hand back signed wire
  // bytes (or, if the dapp uses chromatika's wallet-standard connection to fetch the
  // blockhash itself, the build picks one from our cluster and the dapp's broadcast to its
  // own RPC fails).
  //
  // we ask our current dwallet-tier Solana connection whether the blockhash is valid. if
  // yes, we proceed. if no, we probe the other built-in clusters (devnet/mainnet/testnet)
  // - whichever recognizes the blockhash is the one the dapp is on. we then auto-switch
  // the dwallet-tier active Solana network to match, refresh the session's connections, and
  // continue signing. so the user doesn't need to manually flip a cluster setting before
  // every dapp interaction; the wallet tracks the dapp's intent from the tx itself.
  //
  // why dwallet-tier specifically: the dapp interacts with the dWallet's Solana address,
  // so dwallet-tier is the right scope. the vault tier is a separate concept (Solana
  // ika-base vaults) and isn't relevant here.
  await (async () => {
    const session = getSession();
    const conn = session?.dwalletSolanaConnection ?? session?.solanaConnection;
    if (!conn || !session) return;

    const txBlockhash = vtx.message.recentBlockhash;
    const isBlockhashValidOn = async (c: Connection): Promise<boolean | null> => {
      try {
        const probe = await c.isBlockhashValid(txBlockhash, { commitment: 'confirmed' });
        const v = (probe as { value?: boolean } | boolean | undefined);
        return typeof v === 'boolean' ? v : v?.value ?? null;
      } catch (e) {
        console.warn('[chromatika][solana-tx-sign] isBlockhashValid probe threw', e);
        return null;
      }
    };

    const currentValid = await isBlockhashValidOn(conn);
    console.warn('[chromatika][solana-tx-sign] blockhash preflight (current)', {
      txBlockhash,
      walletCluster: session.solanaNetworkId,
      walletRpc: (conn as unknown as { rpcEndpoint?: string }).rpcEndpoint,
      isValidOnCurrent: currentValid,
    });
    if (currentValid !== false) return; // valid, unknown (null), or true - proceed

    // current cluster doesn't recognize the blockhash. probe the other built-ins.
    let matched: { id: string; rpcUrl: string } | null = null;
    for (const cluster of BUILTIN_SOLANA) {
      if (cluster.id === session.solanaNetworkId) continue; // already tested via current
      const candidateConn = new Connection(cluster.rpcUrl, 'confirmed');
      const ok = await isBlockhashValidOn(candidateConn);
      console.warn('[chromatika][solana-tx-sign] probing cluster for blockhash', {
        clusterId: cluster.id,
        rpcUrl: cluster.rpcUrl,
        isValid: ok,
      });
      if (ok === true) {
        matched = { id: cluster.id, rpcUrl: cluster.rpcUrl };
        break;
      }
    }

    if (!matched) {
      throw new Error(
        `Cluster mismatch: this dapp transaction's blockhash ${txBlockhash} isn't recognized on ` +
          `any built-in Solana cluster (mainnet/devnet/testnet). Either the blockhash already ` +
          `expired (Solana blockhashes age out after ~60s) or the dapp is on a custom cluster ` +
          `chromatika doesn't track. Refresh the dapp and try again.`,
      );
    }

    // auto-switch dwallet-tier Solana to the matched cluster, refresh session clients so
    // the rest of this sign + future requests use the right RPC.
    const vid = getActiveVaultId();
    if (!vid) {
      throw new Error('Wallet locked - cannot auto-switch Solana cluster.');
    }
    console.warn('[chromatika][solana-tx-sign] AUTO-SWITCHING Solana cluster to match dapp', {
      from: session.solanaNetworkId,
      to: matched.id,
      toRpc: matched.rpcUrl,
    });
    await setDwalletNetworkSettings(vid, { solana: { solNetworkId: matched.id } });
    await refreshSessionNetworkClients();
    console.warn('[chromatika][solana-tx-sign] cluster auto-switch complete; proceeding with sign');
  })().catch((e) => {
    if (e instanceof Error && (e.message.startsWith('Cluster mismatch:') || e.message.startsWith('Wallet locked'))) {
      throw e;
    }
    console.warn('[chromatika][solana-tx-sign] cluster preflight unexpected error (proceeding)', e);
  });

  console.warn('[chromatika][solana-tx-sign] calling signMessageSol...', { messageBytesLen: messageBytes.length });
  const t0 = Date.now();
  const { signature } = await signMessageSol(messageBytes, edId ? { ed25519DwalletId: edId } : undefined);
  console.warn('[chromatika][solana-tx-sign] signMessageSol returned', { elapsedMs: Date.now() - t0, sigLen: signature.length });
  const sigBytes = hexSigToBytes(signature);
  if (!ed25519.verify(sigBytes, messageBytes, pubkeyBytes)) {
    throw new Error(
      'ika Ed25519 output failed Solana verification on tx message - hash/scheme mismatch vs chain',
    );
  }

  vtx.addSignature(ourPk, sigBytes);
  console.warn('[chromatika][solana-tx-sign] signature verified and added, serializing');
  return vtx.serialize();
}
