import type { Transaction } from '@mysten/sui/transactions';
import type { SessionState } from '@/background/session';
import { dryRunSuiTransaction } from '@/background/sui/sui-simulation';
import { getSuiFeePayerSigningContext } from '@/background/sui/sui-fee-payer-signing';
import { enqueueHardwareSign } from '@/background/hardware/pending-queue';
import { uint8ToHexNo0x } from '@/background/util/bytes-hex';

type ExecuteOpts = {
  include?: { effects?: boolean; events?: boolean; balanceChanges?: boolean };
  /** forwarded to GraphQL `simulateTransaction.checksEnabled` in the preflight dry-run. */
  dryRunChecksEnabled?: boolean;
};

const MIST_PER_SUI = 1_000_000_000n;

function isVagueSimulationMessage(msg: string): boolean {
  const t = msg.trim();
  return (
    /failed to simulate transaction/i.test(msg) ||
    /^simulation failed$/i.test(t) ||
    /^unknown error$/i.test(t)
  );
}

/**
 * when the RPC returns no Move abort detail, show fee-address SUI/IKA totals so "already funded"
 * users can see a network mismatch (zero here) vs an ika abort (balances OK).
 */
async function appendFeeAddressSnapshot(session: SessionState, err: Error): Promise<Error> {
  if (!isVagueSimulationMessage(err.message)) return err;
  if (err.message.includes('fee address (ika Sui side)')) return err;
  try {
    const owner = getSuiFeePayerSigningContext(session).feePayerAddress;
    const { getSuiBalanceMist, getIkaBalanceBaseUnits } = await import('@/background/ika/coins');
    const [suiMist, ikaBase] = await Promise.all([
      getSuiBalanceMist(session.suiClient, owner),
      getIkaBalanceBaseUnits(session.suiClient, session.ikaClient.ikaConfig, owner),
    ]);
    const suiN = Number(suiMist) / Number(MIST_PER_SUI);
    const ikaN = Number(ikaBase) / Number(MIST_PER_SUI);
    return new Error(
      `${err.message} — fee address (ika Sui side) ${owner}: total ~${suiN.toFixed(4)} SUI, ~${ikaN.toFixed(4)} IKA on this wallet’s active Sui RPC. ` +
        `EVM swap balances do not pay these Sui fees. If totals are zero, switch Sui network in settings to the network you funded, or confirm you used this fee address.`,
    );
  } catch {
    return err;
  }
}

/**
 * turns noisy GraphQL / SDK gas errors into something users can act on.
 * exported for tests and any caller that needs the same wording.
 */
export function friendlySuiExecutionError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const looksLikeGenericSim =
    /failed to simulate transaction/i.test(raw) || /^Failed to simulate transaction$/i.test(raw.trim());
  if (looksLikeGenericSim) {
    return new Error(
      `${raw} — ika presign/signing uses Sui PTBs from your HD fee address (auto-split runs if you only have one SUI coin). ` +
        `This RPC message often hides the real cause (wrong Sui network vs where funds live, indexer lag, or ika pricing). The next line may show your fee-address SUI/IKA totals when this error is thrown from execute.`,
    );
  }
  const looksLikeGas =
    /insufficient SUI balance/i.test(raw) && (/gas selection|required budget/i.test(raw) || /Unable to perform gas selection/i.test(raw));
  if (looksLikeGas) {
    const budgetMatch = raw.match(/required budget\s+(\d+)/i);
    let budgetHint = '';
    if (budgetMatch?.[1]) {
      try {
        const mist = BigInt(budgetMatch[1]);
        const sui = Number(mist) / Number(MIST_PER_SUI);
        budgetHint = ` This PTB asked for about ${sui.toFixed(3)} SUI worth of gas budget (before network fee).`;
      } catch {
        /* ignore */
      }
    }
    const feeAddr = feeAddressSuffixHint(raw);
    return new Error(
      `Not enough native SUI on your fee address to pay network gas.${budgetHint}` +
        ` Send more SUI to the address under Advanced → gas / fee address (IKA pays protocol fees; SUI pays chain gas).` +
        ` If the balance already looks high, ika PTBs use one SUI coin for protocol splits and need a separate SUI coin for gas — send a small amount to yourself once to split coins.` +
        feeAddr,
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

function feeAddressSuffixHint(raw: string): string {
  const m = raw.match(/account\s+(0x[a-fA-F0-9]+)/i);
  if (!m?.[1]) return '';
  const hex = m[1].replace(/^0x/i, '');
  return ` Confirm you sent SUI to the same fee address (…${hex.slice(-6)}).`;
}

type SignExecuteResult = Awaited<
  ReturnType<SessionState['suiClient']['signAndExecuteTransaction']>
>;

/** single place for Sui PTB execution (local ed25519 fee payer). */
export async function executeSuiTransaction(
  session: SessionState,
  transaction: Transaction,
  opts?: ExecuteOpts,
): Promise<SignExecuteResult & { suiSimulationSummary?: string[] }> {
  const canSignLocally =
    session.accountKind === 'hd'
    || session.accountKind === 'importedKey'
    || session.accountKind === 'hardware'
    || session.accountKind === 'dwalletAnchored';
  if (!canSignLocally) {
    throw new Error('Unsupported account kind for Sui PTB signing');
  }
  try {
    const dry = await dryRunSuiTransaction(session, transaction, {
      checksEnabled: opts?.dryRunChecksEnabled ?? true,
    });
    if (!dry.ok) {
      const base = friendlySuiExecutionError(new Error(dry.summaryLines.join(' ')));
      throw await appendFeeAddressSnapshot(session, base);
    }
    if (session.suiLedgerFee) {
      const { feePayerAddress } = getSuiFeePayerSigningContext(session);
      transaction.setSenderIfNotSet(feePayerAddress);
      const transactionBytes = await transaction.build({ client: session.suiClient });
      const sigSerialized = await enqueueHardwareSign({
        vendor: 'ledger',
        chain: 'sui',
        derivationPath: session.suiLedgerFee.derivationPath,
        payloadHex: uint8ToHexNo0x(transactionBytes),
        kind: 'suiTx',
        ed25519PublicKeyB64: session.suiLedgerFee.publicKeyB64,
      });
      const result = await session.suiClient.core.executeTransaction({
        transaction: transactionBytes,
        signatures: [sigSerialized],
        include: opts?.include,
      });
      return Object.assign(result, { suiSimulationSummary: dry.summaryLines });
    }

    const { signer } = getSuiFeePayerSigningContext(session);
    const result = await session.suiClient.signAndExecuteTransaction({
      transaction,
      signer,
      include: opts?.include,
    });
    return Object.assign(result, { suiSimulationSummary: dry.summaryLines });
  } catch (e) {
    const base = friendlySuiExecutionError(e);
    throw await appendFeeAddressSnapshot(session, base);
  }
}
