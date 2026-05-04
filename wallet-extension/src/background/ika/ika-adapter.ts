/**
 * IkaAdapter - base-chain-agnostic interface for dWallet operations.
 *
 * today: SuiIkaAdapter wraps the existing IkaClient
 * soon: SolanaIkaAdapter wraps a future SolanaIkaClient (not yet in SDK)
 *
 * why this exists: when Ika lands on Solana, dWallets become Solana PDAs,
 * fee payers are Solana keypairs, and tx execution goes through @solana/web3.js.
 * signing.ts etc. call through this interface so they never touch base-chain
 * specifics directly.
 */

import type {
  IkaClient,
  ZeroTrustDWallet,
  UserShareEncryptionKeys,
} from '@ika.xyz/sdk';
import type { Transaction } from '@mysten/sui/transactions';
import type { SessionState } from '@/background/session';
import type { SolanaIkaGrpcClient } from '@/background/ika/solana-grpc-client';
import { buildSyntheticZeroTrustDWalletFromSolanaAccount } from '@/background/ika/solana-dwallet-onchain';

export type BaseChain = 'sui' | 'solana';

/** return type from a submitted IKA transaction - normalized across both chains. */
export type IkaExecResult =
  | {
      $kind: 'Transaction';
      Transaction: {
        effects?: { changedObjects?: { idOperation: string; objectId: string }[] };
        events?: { type?: string | null; parsedJson?: unknown }[];
      };
    }
  | { $kind: 'FailedTransaction'; FailedTransaction: { status: { error?: unknown } } };

export interface IkaAdapterOpts {
  /** chain-specific config pulled from session */
  suiCoinId: string;
  ikaCoinId: string;
  owner: string;
  keys: UserShareEncryptionKeys;
}

/**
 * everything signing.ts and dwallet-lifecycle.ts need, abstracted over base chain.
 */
export interface IkaAdapter {
  readonly baseChain: BaseChain;

  /** raw IkaClient access, only use for operations not yet abstracted */
  readonly ikaClient: IkaClient;

  getDWallet(id: string): Promise<ZeroTrustDWallet>;

  getOwnedDWalletCaps(
    owner: string,
    cursor?: string | null,
    limit?: number,
  ): ReturnType<IkaClient['getOwnedDWalletCaps']>;

  getPresignInParticularState(
    id: string,
    state: 'Completed',
    opts?: { timeout?: number },
  ): ReturnType<IkaClient['getPresignInParticularState']>;

  getEncryptedUserSecretKeyShare(id: string): ReturnType<IkaClient['getEncryptedUserSecretKeyShare']>;

  getSign(
    id: string,
    curve: Parameters<IkaClient['getSign']>[1],
    algo: Parameters<IkaClient['getSign']>[2],
  ): ReturnType<IkaClient['getSign']>;

  getSignInParticularState(
    ...args: Parameters<IkaClient['getSignInParticularState']>
  ): ReturnType<IkaClient['getSignInParticularState']>;

  /**
   * build and execute a complete IKA transaction (approve + requestSign).
   * the adapter handles fee-payer keypair, gas coins, and submission.
   */
  executeTx(session: SessionState, tx: Transaction): Promise<IkaExecResult>;
}

// ---------- Sui implementation ----------

export class SuiIkaAdapter implements IkaAdapter {
  readonly baseChain: BaseChain = 'sui';
  readonly ikaClient: IkaClient;

  constructor(ikaClient: IkaClient) {
    this.ikaClient = ikaClient;
  }

  getDWallet(id: string) {
    return this.ikaClient.getDWallet(id) as Promise<ZeroTrustDWallet>;
  }

  getOwnedDWalletCaps(owner: string, cursor?: string | null, limit?: number) {
    return this.ikaClient.getOwnedDWalletCaps(owner, cursor ?? undefined, limit);
  }

  getPresignInParticularState(id: string, state: 'Completed', opts?: { timeout?: number }) {
    return this.ikaClient.getPresignInParticularState(id, state, opts);
  }

  getEncryptedUserSecretKeyShare(id: string) {
    return this.ikaClient.getEncryptedUserSecretKeyShare(id);
  }

  getSign(
    id: string,
    curve: Parameters<IkaClient['getSign']>[1],
    algo: Parameters<IkaClient['getSign']>[2],
  ) {
    return this.ikaClient.getSign(id, curve, algo);
  }

  getSignInParticularState(
    ...args: Parameters<IkaClient['getSignInParticularState']>
  ) {
    return this.ikaClient.getSignInParticularState(...args);
  }

  async executeTx(session: SessionState, tx: Transaction): Promise<IkaExecResult> {
    const { executeSuiTransaction } = await import('@/background/sui/execute-transaction');
    return executeSuiTransaction(session, tx, { include: { effects: true, events: true } });
  }
}

// ---------- Solana (pre-alpha gRPC) ----------
// read paths: devnet dWallet account + synthetic `ZeroTrustDWallet` for ika-sdk-shaped checks.
// write paths (Sui PTB `executeTx`, ika presign / sign objects) stay Sui-only until Solana execution is modeled.

export class SolanaIkaAdapter implements IkaAdapter {
  readonly baseChain: BaseChain = 'solana';

  constructor(
    readonly grpc: SolanaIkaGrpcClient | undefined,
    private readonly session: SessionState,
  ) {}

  get ikaClient(): IkaClient {
    void this.grpc;
    throw new Error('Solana path uses gRPC DWalletService — not IkaClient (see solana-grpc-client.ts)');
  }

  private _suiOnly(method: string): never {
    throw new Error(
      `${method} is Sui ika PTB / object graph only — ika Solana pre-alpha uses gRPC for DKG/sign where wired (see solana-grpc-client.ts)`,
    );
  }

  async getDWallet(id: string): Promise<ZeroTrustDWallet> {
    const conn = this.session.solanaConnection;
    if (!conn) throw new Error('Solana RPC not configured — cannot load dWallet account');
    return buildSyntheticZeroTrustDWalletFromSolanaAccount(conn, id);
  }

  getOwnedDWalletCaps(
    _owner: string,
    _cursor?: string | null,
    _limit?: number,
  ): ReturnType<IkaClient['getOwnedDWalletCaps']> {
    void _owner;
    void _cursor;
    void _limit;
    return Promise.resolve({ dWalletCaps: [], hasNextPage: false, cursor: null });
  }

  getPresignInParticularState(): never {
    return this._suiOnly('getPresignInParticularState');
  }
  getEncryptedUserSecretKeyShare(): never {
    return this._suiOnly('getEncryptedUserSecretKeyShare');
  }
  getSign(): never {
    return this._suiOnly('getSign');
  }
  getSignInParticularState(): never {
    return this._suiOnly('getSignInParticularState');
  }
  executeTx(): never {
    return this._suiOnly('executeTx');
  }
}

// ---------- factory ----------

/** returns the right adapter from the active session for a given base chain. */
export function getIkaAdapter(session: SessionState, baseChain: BaseChain): IkaAdapter {
  if (baseChain === 'sui') {
    return new SuiIkaAdapter(session.ikaClient);
  }
  return new SolanaIkaAdapter(session.solanaIkaGrpc, session);
}
