import { registerWallet } from '@wallet-standard/wallet';
import type { Wallet, WalletAccount, IdentifierArray } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
} from '@wallet-standard/features';
import {
  SUI_CHAINS,
  SuiSignPersonalMessage,
  SuiSignTransaction,
  SuiSignAndExecuteTransaction,
} from '@mysten/wallet-standard';
import {
  SolanaSignMessage,
  SolanaSignTransaction,
} from '@solana/wallet-standard-features';
import { EIP6963_ICON_DATA_URI } from './eip6963-icon-data';
import { registerChromatikaAptosWallet } from './aptos-wallet-standard-register';

type JsonRpcReq = { method: string; params?: unknown[] };

const SOLANA_CHAINS = ['solana:mainnet', 'solana:devnet', 'solana:testnet'] as const;

function u8ToBinaryString(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return s;
}

function bytesToBase64(u8: Uint8Array): string {
  return btoa(u8ToBinaryString(u8));
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

/** Sui + Solana + Aptos (AIP-62) Wallet Standard registrations (dApp Kit + wallet-adapter discovery). */
export function registerChromatikaWalletStandard(post: (req: JsonRpcReq) => Promise<unknown>): void {
  const icon = EIP6963_ICON_DATA_URI as Wallet['icon'];
  const suiChains: IdentifierArray = [...SUI_CHAINS];
  const solChains: IdentifierArray = [...SOLANA_CHAINS];

  const suiListeners = new Set<() => void>();
  const suiState: { accounts: WalletAccount[] } = { accounts: [] };

  const suiWallet = {
    version: '1.0.0' as const,
    name: 'Chromatika Sui',
    icon,
    chains: suiChains,
    get accounts(): readonly WalletAccount[] {
      return suiState.accounts;
    },
    features: {
      [StandardConnect]: {
        version: '1.0.0' as const,
        connect: async () => {
          await post({ method: 'sui_connect' });
          const meta = (await post({ method: 'sui_walletStandardAccount' })) as {
            address: string;
            publicKey: number[];
          };
          const acc: WalletAccount = {
            address: meta.address,
            publicKey: new Uint8Array(meta.publicKey),
            chains: suiChains,
            features: [
              SuiSignPersonalMessage,
              SuiSignTransaction,
              SuiSignAndExecuteTransaction,
            ] satisfies IdentifierArray,
          };
          suiState.accounts = [acc];
          suiListeners.forEach((l) => {
            try {
              l();
            } catch {
              /* ignore */
            }
          });
          return { accounts: suiState.accounts };
        },
      },
      [StandardDisconnect]: {
        version: '1.0.0' as const,
        disconnect: async () => {
          suiState.accounts = [];
          suiListeners.forEach((l) => {
            try {
              l();
            } catch {
              /* ignore */
            }
          });
          await post({ method: 'sui_disconnect' }).catch(() => {});
        },
      },
      [StandardEvents]: {
        version: '1.0.0' as const,
        on: (event: string, listener: (props: { accounts: readonly WalletAccount[] }) => void) => {
          if (event !== 'change') return () => {};
          const wrapped = () => listener({ accounts: suiState.accounts });
          suiListeners.add(wrapped);
          return () => suiListeners.delete(wrapped);
        },
      },
      [SuiSignPersonalMessage]: {
        version: '1.1.0' as const,
        signPersonalMessage: async (input: {
          message: Uint8Array;
          account: WalletAccount;
        }) => {
          const msg = input.message instanceof Uint8Array ? input.message : Uint8Array.from(input.message);
          const hex = Array.from(msg, (b) => b.toString(16).padStart(2, '0')).join('');
          const out = (await post({
            method: 'sui_signPersonalMessage',
            params: [{ message: hex }],
          })) as { bytes?: string; signature?: string };
          const sigStr = out.signature ?? '';
          const signature =
            sigStr.startsWith('0x') ? bytesToBase64(hexToBytes(sigStr)) : sigStr;
          return {
            bytes: out.bytes ?? bytesToBase64(msg),
            signature,
          };
        },
      },
      [SuiSignTransaction]: {
        version: '2.0.0' as const,
        signTransaction: async (input: { transaction: { toJSON: () => Promise<string> } }) => {
          const json = await input.transaction.toJSON();
          const out = (await post({
            method: 'sui_signTransaction',
            params: [json],
          })) as { bytes?: string; signature?: string };
          return {
            bytes: out.bytes ?? '',
            signature: out.signature ?? '',
          };
        },
      },
      [SuiSignAndExecuteTransaction]: {
        version: '2.0.0' as const,
        signAndExecuteTransaction: async (input: {
          transaction: { toJSON: () => Promise<string> };
        }) => {
          const json = await input.transaction.toJSON();
          const raw = (await post({
            method: 'sui_signAndExecuteTransaction',
            params: [json],
          })) as Record<string, unknown>;
          const tx = raw.transaction as Record<string, unknown> | undefined;
          const digest = String(tx?.digest ?? raw.digest ?? '');
          const effectsUnknown = raw.effects ?? raw.rawEffects;
          let effects = '';
          if (typeof effectsUnknown === 'string') effects = effectsUnknown;
          else if (effectsUnknown && typeof effectsUnknown === 'object' && 'bcs' in effectsUnknown) {
            effects = String((effectsUnknown as { bcs?: string }).bcs ?? '');
          }
          const sigs = raw.signatures;
          const signature =
            Array.isArray(sigs) && typeof sigs[0] === 'string' ? sigs[0] : '';
          const bcs = typeof tx?.bcs === 'string' ? tx.bcs : '';
          return {
            bytes: bcs,
            signature,
            digest,
            effects,
          };
        },
      },
    },
  } satisfies Wallet;

  const solListeners = new Set<() => void>();
  const solState: { accounts: WalletAccount[] } = { accounts: [] };

  const solWallet = {
    version: '1.0.0' as const,
    name: 'Chromatika Solana',
    icon,
    chains: solChains,
    get accounts(): readonly WalletAccount[] {
      return solState.accounts;
    },
    features: {
      [StandardConnect]: {
        version: '1.0.0' as const,
        connect: async () => {
          await post({ method: 'solana_connect' });
          const meta = (await post({ method: 'solana_walletStandardAccount' })) as {
            address: string;
            publicKey: number[];
          };
          const acc: WalletAccount = {
            address: meta.address,
            publicKey: new Uint8Array(meta.publicKey),
            chains: solChains,
            features: [SolanaSignTransaction, SolanaSignMessage] satisfies IdentifierArray,
          };
          solState.accounts = [acc];
          solListeners.forEach((l) => {
            try {
              l();
            } catch {
              /* ignore */
            }
          });
          return { accounts: solState.accounts };
        },
      },
      [StandardDisconnect]: {
        version: '1.0.0' as const,
        disconnect: async () => {
          solState.accounts = [];
          solListeners.forEach((l) => {
            try {
              l();
            } catch {
              /* ignore */
            }
          });
          await post({ method: 'solana_disconnect' }).catch(() => {});
        },
      },
      [StandardEvents]: {
        version: '1.0.0' as const,
        on: (event: string, listener: (props: { accounts: readonly WalletAccount[] }) => void) => {
          if (event !== 'change') return () => {};
          const wrapped = () => listener({ accounts: solState.accounts });
          solListeners.add(wrapped);
          return () => solListeners.delete(wrapped);
        },
      },
      [SolanaSignTransaction]: {
        version: '1.0.0' as const,
        supportedTransactionVersions: ['legacy', 0] as const,
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          const out: { signedTransaction: Uint8Array }[] = [];
          for (const inp of inputs) {
            const payload = { wire: Array.from(inp.transaction) };
            const res = (await post({
              method: 'solana_signTransaction',
              params: [payload],
            })) as { wire: number[] };
            out.push({ signedTransaction: Uint8Array.from(res.wire) });
          }
          return out;
        },
      },
      [SolanaSignMessage]: {
        version: '1.1.0' as const,
        signMessage: async (...inputs: { message: Uint8Array }[]) => {
          const out: { signedMessage: Uint8Array; signature: Uint8Array; signatureType: 'ed25519' }[] = [];
          for (const inp of inputs) {
            const hex = Array.from(inp.message, (b) => b.toString(16).padStart(2, '0')).join('');
            const res = (await post({
              method: 'solana_signMessage',
              params: [hex],
            })) as { signature: string };
            const sig = hexToBytes(res.signature);
            out.push({
              signedMessage: inp.message,
              signature: sig,
              signatureType: 'ed25519',
            });
          }
          return out;
        },
      },
    },
  } satisfies Wallet;

  // aptos first so AIP-62 registration runs even if another wallet's register path misbehaves;
  // dapps using `@aptos-labs/wallet-adapter-core` only show Aptos wallets that pass `getAptosWallets()`.
  try {
    registerChromatikaAptosWallet(post);
  } catch (e) {
    console.warn('[chromatika] aptos wallet standard register failed', e);
  }
  try {
    registerWallet(suiWallet);
  } catch (e) {
    console.warn('[chromatika] sui wallet standard register failed', e);
  }
  try {
    registerWallet(solWallet);
  } catch (e) {
    console.warn('[chromatika] solana wallet standard register failed', e);
  }
}
