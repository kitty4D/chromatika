import '@/buffer-polyfill';
/**
 * AIP-62 (Wallet Standard) registration for Aptos dapps using `@aptos-labs/wallet-adapter-react`.
 * legacy `window.aptos` stays in `inject.ts`; dapp discovery + `getAptosWallets()` require `registerWallet`.
 * @see https://aptos.dev/build/sdks/wallet-adapter/wallet-standards
 */
import { registerWallet } from '@wallet-standard/wallet';
import type { IdentifierArray, Wallet, WalletIcon } from '@wallet-standard/base';
import {
  APTOS_CHAINS,
  AccountInfo,
  AptosWalletError,
  AptosWalletErrorCode,
  UserResponseStatus,
  type AptosWallet,
  type AptosWalletAccount,
  type NetworkInfo,
  type UserResponse,
} from '@aptos-labs/wallet-standard';
import {
  AccountAddress,
  AccountAuthenticator,
  AnyRawTransaction,
  Deserializer,
  Ed25519PublicKey,
  Ed25519Signature,
  Network,
  SigningScheme,
} from '@aptos-labs/ts-sdk';
import { EIP6963_ICON_DATA_URI } from './eip6963-icon-data';

type JsonRpcReq = { method: string; params?: unknown[] };

const aptosStdChains = [...APTOS_CHAINS] as unknown as IdentifierArray;
const aptosStdAccounts: AptosWalletAccount[] = [];
const aip62AccountChangeListeners = new Set<(a: AccountInfo) => void>();
const aip62NetworkChangeListeners = new Set<(n: NetworkInfo) => void>();

function hexToPkBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

function makeStdAccount(raw: { address: string; publicKey: string }): AptosWalletAccount {
  return {
    address: raw.address,
    publicKey: hexToPkBytes(raw.publicKey),
    chains: aptosStdChains,
    features: [
      'aptos:signMessage',
      'aptos:signTransaction',
      'aptos:signAndSubmitTransaction',
    ] as unknown as IdentifierArray,
    signingScheme: SigningScheme.Ed25519,
  } as AptosWalletAccount;
}

function toAccountInfo(r: { address: string; publicKey: string }): AccountInfo {
  return new AccountInfo({
    address: AccountAddress.from(r.address),
    publicKey: new Ed25519PublicKey(r.publicKey),
  });
}

function networkInfoFromDapp(r: { name: string; chainId: string; url: string }): NetworkInfo {
  const n = r.name;
  const name =
    n === 'mainnet' ? Network.MAINNET : n === 'testnet' ? Network.TESTNET : n === 'devnet' ? Network.DEVNET : Network.CUSTOM;
  return { name, chainId: parseInt(r.chainId, 10), url: r.url };
}

/** call from `inject.ts` when the content script forwards `aptosAccountChange`. */
export async function dispatchAptosWalletStandardAccount(
  post: (req: JsonRpcReq) => Promise<unknown>,
  ev: { address: string } | null,
): Promise<void> {
  try {
    if (!ev?.address) {
      aptosStdAccounts.length = 0;
      return;
    }
    const raw = (await post({ method: 'aptos_account' })) as { address: string; publicKey: string } | null;
    if (!raw?.address) {
      aptosStdAccounts.length = 0;
      return;
    }
    aptosStdAccounts.length = 0;
    aptosStdAccounts.push(makeStdAccount(raw));
    const info = toAccountInfo(raw);
    aip62AccountChangeListeners.forEach((cb) => {
      try {
        cb(info);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

export function dispatchAptosWalletStandardNetwork(ev: { name: string; chainId: string; url: string }): void {
  const info = networkInfoFromDapp(ev);
  aip62NetworkChangeListeners.forEach((cb) => {
    try {
      cb(info);
    } catch {
      /* ignore */
    }
  });
}

export function registerChromatikaAptosWallet(post: (req: JsonRpcReq) => Promise<unknown>): void {
  const icon = EIP6963_ICON_DATA_URI as WalletIcon;

  const aptosWallet: AptosWallet = {
    version: '1.0.0',
    name: 'Chromatika',
    icon,
    url: 'https://chromatika.xyz',
    chains: aptosStdChains,
    get accounts(): readonly AptosWalletAccount[] {
      return aptosStdAccounts;
    },
    features: {
      'aptos:connect': {
        version: '1.0.0' as const,
        connect: async () => {
          const raw = (await post({ method: 'aptos_connect' })) as { address: string; publicKey: string };
          aptosStdAccounts.length = 0;
          aptosStdAccounts.push(makeStdAccount(raw));
          return { status: UserResponseStatus.APPROVED, args: toAccountInfo(raw) };
        },
      },
      'aptos:disconnect': {
        version: '1.0.0' as const,
        disconnect: async () => {
          aptosStdAccounts.length = 0;
          await post({ method: 'aptos_disconnect' }).catch(() => {});
        },
      },
      'aptos:account': {
        version: '1.0.0' as const,
        account: async () => {
          const raw = (await post({ method: 'aptos_account' })) as { address: string; publicKey: string } | null;
          if (!raw) throw new AptosWalletError(AptosWalletErrorCode.Unauthorized, 'not connected');
          return toAccountInfo(raw);
        },
      },
      'aptos:network': {
        version: '1.0.0' as const,
        network: async () => {
          const raw = (await post({ method: 'aptos_network' })) as { name: string; chainId: string; url: string };
          return networkInfoFromDapp(raw);
        },
      },
      'aptos:onAccountChange': {
        version: '1.0.0' as const,
        onAccountChange: async (listener: (a: AccountInfo) => void) => {
          aip62AccountChangeListeners.add(listener);
        },
      },
      'aptos:onNetworkChange': {
        version: '1.0.0' as const,
        onNetworkChange: async (listener: (n: NetworkInfo) => void) => {
          aip62NetworkChangeListeners.add(listener);
        },
      },
      'aptos:signMessage': {
        version: '1.0.0' as const,
        signMessage: async (input) => {
          const r = (await post({
            method: 'aptos_signMessage',
            params: [{ message: input.message, nonce: input.nonce }],
          })) as { signature: string; fullMessage: string; message: string; nonce: string; prefix: 'APTOS' };
          const sigBytes = hexToPkBytes(r.signature);
          return {
            status: UserResponseStatus.APPROVED,
            args: {
              fullMessage: r.fullMessage,
              message: r.message,
              nonce: r.nonce,
              prefix: 'APTOS' as const,
              signature: new Ed25519Signature(sigBytes),
            },
          };
        },
      },
      'aptos:signTransaction': {
        version: '1.0.0' as const,
        signTransaction: async (transaction: AnyRawTransaction, asFeePayer?: boolean): Promise<UserResponse<AccountAuthenticator>> => {
          void asFeePayer;
          try {
            const tx = transaction as { bcsToBytes?: () => Uint8Array };
            if (typeof tx?.bcsToBytes !== 'function') {
              return { status: UserResponseStatus.REJECTED } as UserResponse<AccountAuthenticator>;
            }
            const wire = Array.from(tx.bcsToBytes());
            const res = (await post({
              method: 'aptos_signTransaction',
              params: [{ wire }],
            })) as { authenticatorBcs: number[] };
            const auth = AccountAuthenticator.deserialize(
              new Deserializer(Uint8Array.from(res.authenticatorBcs)),
            );
            return { status: UserResponseStatus.APPROVED, args: auth };
          } catch {
            return { status: UserResponseStatus.REJECTED } as UserResponse<AccountAuthenticator>;
          }
        },
      },
      'aptos:signAndSubmitTransaction': {
        version: '1.1.0' as const,
        signAndSubmitTransaction: async (input) => {
          const out = (await post({
            method: 'aptos_signAndSubmitTransaction',
            params: [input],
          })) as { hash?: string };
          const hash = (out as { hash?: string })?.hash ?? (out as { transactionHash?: string })?.transactionHash ?? '';
          return { status: UserResponseStatus.APPROVED, args: { hash } };
        },
      },
    },
  };

  registerWallet(aptosWallet as unknown as Wallet);
}
