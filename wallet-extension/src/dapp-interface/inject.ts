import '@/buffer-polyfill';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { EIP6963_ICON_DATA_URI } from './eip6963-icon-data';
import {
  dispatchAptosWalletStandardAccount,
  dispatchAptosWalletStandardNetwork,
} from './aptos-wallet-standard-register';
import { registerChromatikaWalletStandard } from './wallet-standard-register';
import { installX402FetchWrapper } from './x402-fetch-wrapper';

export {};

type JsonRpcReq = { method: string; params?: unknown[] };
type EventHandler = (...args: unknown[]) => void;

/** EIP-1193 / EIP-1474 style error for dapp providers (viem, ethers parse `error.code`). */
class ChromatikaProviderRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ChromatikaProviderRpcError';
    this.code = code;
    this.data = data;
  }
}

// --- message bridge ---

/** serialize a dapp @solana/web3.js transaction for the extension bridge (structured clone safe). */
function solanaTxToWirePayload(tx: unknown): { wire: number[] } {
  if (!tx || typeof tx !== 'object') {
    throw new ChromatikaProviderRpcError(-32602, 'invalid transaction');
  }
  const ser = (tx as { serialize?: (opts?: unknown) => Uint8Array }).serialize;
  if (typeof ser !== 'function') {
    throw new ChromatikaProviderRpcError(
      -32602,
      'transaction must have serialize(), use @solana/web3.js Transaction or VersionedTransaction',
    );
  }
  try {
    const u8 = ser.call(tx, { requireAllSignatures: false, verifySignatures: false });
    return { wire: Array.from(u8) };
  } catch {
    const u8 = ser.call(tx);
    return { wire: Array.from(u8) };
  }
}

function wirePayloadToSolanaTx(wire: number[]): Transaction | VersionedTransaction {
  const u8 = Uint8Array.from(wire);
  try {
    return Transaction.from(u8);
  } catch {
    return VersionedTransaction.deserialize(u8);
  }
}

function postToExtension(req: JsonRpcReq): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const onMsg = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const d = ev.data as {
        source?: string;
        type?: string;
        id?: string;
        ok?: boolean;
        result?: unknown;
        error?: string;
        code?: number;
      };
      if (d?.source !== 'chromatika-content' || d?.type !== 'chromatika-dapp-res' || d.id !== id) {
        return;
      }
      window.removeEventListener('message', onMsg);
      if (d.ok) resolve(d.result);
      else {
        const msg = d.error ?? 'chromatika dapp error';
        if (typeof d.code === 'number') reject(new ChromatikaProviderRpcError(d.code, msg));
        else reject(new Error(msg));
      }
    };
    window.addEventListener('message', onMsg);
    window.postMessage(
      {
        source: 'chromatika-page',
        type: 'chromatika-dapp-req',
        id,
        method: req.method,
        params: req.params,
      },
      '*',
    );
  });
}

// x402 fetch wrapper installs on demand instead of for every <all_urls> page. content-script.ts
// asks the background whether the current origin is connected via dapp-permissions; if yes, it
// posts a `chromatika-x402-enable` event and we replace window.fetch then. unconnected sites
// (most of the web, docs.deso.org, github, etc.) keep native window.fetch and chromatika
// stays off the fetch call stack, so third-party preload-credentials-mode warnings stop being
// attributed to inject.js.
window.addEventListener('message', function onEnableX402(ev: MessageEvent) {
  if (ev.source !== window) return;
  const d = ev.data as { source?: string; type?: string } | undefined;
  if (d?.source !== 'chromatika-content' || d?.type !== 'chromatika-x402-enable') return;
  window.removeEventListener('message', onEnableX402);
  installX402FetchWrapper(postToExtension);
});

// --- EventEmitter ---

const listeners = new Map<string, Set<EventHandler>>();

function on(event: string, handler: EventHandler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(handler);
}

function removeListener(event: string, handler: EventHandler) {
  listeners.get(event)?.delete(handler);
}

function emit(event: string, ...args: unknown[]) {
  listeners.get(event)?.forEach((h) => {
    try {
      h(...args);
    } catch (err) {
      // dapp listener threw, never let it break our event loop, but surface in dev so we can spot misbehaving integrations
      if (import.meta.env.DEV) console.warn('[chromatika] dapp listener threw on', event, err);
    }
  });
}

type AptosAccountEvent = { address: string } | null;
type AptosNetworkEvent = { name: string; chainId: string; url: string };
const aptosAccountListeners = new Set<(a: AptosAccountEvent) => void>();
const aptosNetworkListeners = new Set<(n: AptosNetworkEvent) => void>();

// relay events pushed by background -> content script -> page
window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const d = ev.data as { source?: string; type?: string; event?: string; data?: unknown };
  if (d?.source !== 'chromatika-content' || d?.type !== 'chromatika-event') return;
  if (d.event === 'aptosAccountChange') {
    const ev = d.data as AptosAccountEvent;
    aptosAccountListeners.forEach((h) => {
      try {
        h(ev);
      } catch {
        /* ignore */
      }
    });
    void dispatchAptosWalletStandardAccount(postToExtension, ev);
  }
  if (d.event === 'aptosNetworkChange') {
    const nev = d.data as AptosNetworkEvent;
    aptosNetworkListeners.forEach((h) => {
      try {
        h(nev);
      } catch {
        /* ignore */
      }
    });
    dispatchAptosWalletStandardNetwork(nev);
  }
  if (d.event) emit(d.event, d.data);
});

// --- EIP-1193 provider ---

const provider = {
  isMetaMask: false,
  isChromatika: true,
  request: (args: { method: string; params?: unknown[] }) =>
    postToExtension({ method: args.method, params: args.params }),
  on,
  removeListener,
};

// --- EIP-6963 ---

const eip6963Info = Object.freeze({
  uuid: 'c4e4e9a1-8cc0-4b77-b87b-d76c12f23b13',
  name: 'Chromatika',
  icon: EIP6963_ICON_DATA_URI,
  rdns: 'xyz.ika.chromatika',
});

function announceProvider() {
  window.dispatchEvent(
    new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info: eip6963Info, provider }),
    }),
  );
}

window.addEventListener('eip6963:requestProvider', announceProvider);
announceProvider();

// --- window.solana (Phantom-compatible) ---
// dApps detect wallets via window.solana.isPhantom / connect().
// all calls proxy through the existing postToExtension bridge;
// background routes solana_* methods to the ED25519 dWallet via signMessageSol.

type SolanaPublicKey = { toBase58(): string; toString(): string };

let solanaPublicKey: SolanaPublicKey | null = null;

const solanaProvider = {
  isPhantom: false,
  isChromatika: true,
  get publicKey() { return solanaPublicKey; },

  connect: async (opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: SolanaPublicKey }> => {
    const result = await postToExtension({ method: 'solana_connect', params: opts ? [opts] : [] }) as { address: string };
    const addr = result.address;
    solanaPublicKey = { toBase58: () => addr, toString: () => addr };
    emit('connect', solanaPublicKey);
    return { publicKey: solanaPublicKey };
  },

  disconnect: async (): Promise<void> => {
    solanaPublicKey = null;
    emit('disconnect');
  },

  signMessage: async (message: Uint8Array, _encoding?: string): Promise<{ signature: Uint8Array; publicKey: SolanaPublicKey }> => {
    const hex = Array.from(message, (b) => b.toString(16).padStart(2, '0')).join('');
    const result = await postToExtension({ method: 'solana_signMessage', params: [hex] }) as { signature: string };
    const sig = Uint8Array.from(
      result.signature.replace(/^0x/i, '').match(/.{1,2}/g)!.map((b) => parseInt(b, 16)),
    );
    return { signature: sig, publicKey: solanaPublicKey! };
  },

  signTransaction: async (tx: unknown): Promise<Transaction | VersionedTransaction> => {
    const payload = solanaTxToWirePayload(tx);
    const result = (await postToExtension({
      method: 'solana_signTransaction',
      params: [payload],
    })) as { wire: number[] };
    return wirePayloadToSolanaTx(result.wire);
  },

  signAllTransactions: async (txs: unknown[]): Promise<Array<Transaction | VersionedTransaction>> => {
    const payloads = txs.map(solanaTxToWirePayload);
    const results = (await postToExtension({
      method: 'solana_signAllTransactions',
      params: [payloads],
    })) as { wire: number[] }[];
    return results.map((r) => wirePayloadToSolanaTx(r.wire));
  },

  on,
  removeListener,
};

// --- window.sui (Mysten-compatible) ---
// minimal shim + Wallet Standard (`registerChromatikaWalletStandard`) for dApp Kit discovery.

const suiProvider = {
  isChromatika: true,

  connect: (): Promise<{ address: string }> =>
    postToExtension({ method: 'sui_connect' }) as Promise<{ address: string }>,

  disconnect: (): Promise<void> => {
    emit('sui:disconnect');
    return Promise.resolve();
  },

  getAccounts: async (): Promise<string[]> => {
    const result = await postToExtension({ method: 'sui_getAccounts' }) as { accounts: string[] };
    return result.accounts ?? [];
  },

  /** returns { bytes: base64, signature: hex }, bytes = base64 of original message. */
  signPersonalMessage: (params: { message: Uint8Array | number[] }): Promise<{ bytes: string; signature: string }> => {
    const arr = params.message instanceof Uint8Array ? params.message : Uint8Array.from(params.message);
    const hex = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    return postToExtension({ method: 'sui_signPersonalMessage', params: [{ message: hex }] }) as Promise<{ bytes: string; signature: string }>;
  },

  signTransaction: (params: unknown): Promise<unknown> =>
    postToExtension({ method: 'sui_signTransaction', params: [params] }),

  signAndExecuteTransaction: (params: unknown): Promise<unknown> =>
    postToExtension({ method: 'sui_signAndExecuteTransaction', params: [params] }),

  on,
  removeListener,
};

// --- window.aptos (Petra-compatible) ---

const aptosProvider = {
  isAptosWallet: true,
  isChromatika: true,
  connect: (): Promise<unknown> => postToExtension({ method: 'aptos_connect' }),
  disconnect: (): Promise<unknown> => postToExtension({ method: 'aptos_disconnect' }),
  isConnected: (): Promise<unknown> => postToExtension({ method: 'aptos_isConnected' }),
  account: (): Promise<unknown> => postToExtension({ method: 'aptos_account' }),
  network: (): Promise<unknown> => postToExtension({ method: 'aptos_network' }),
  signMessage: (payload: { message: string; nonce: string }): Promise<unknown> =>
    postToExtension({ method: 'aptos_signMessage', params: [payload] }),
  signAndSubmitTransaction: (transaction: unknown): Promise<unknown> =>
    postToExtension({ method: 'aptos_signAndSubmitTransaction', params: [transaction] }),
  onAccountChange: (cb: (account: AptosAccountEvent) => void) => {
    aptosAccountListeners.add(cb);
    return () => aptosAccountListeners.delete(cb);
  },
  onNetworkChange: (cb: (network: AptosNetworkEvent) => void) => {
    aptosNetworkListeners.add(cb);
    return () => aptosNetworkListeners.delete(cb);
  },
};

// --- window.bitcoin (Xverse / Unisat-compatible) ---
// exposes both P2WPKH (bc1q) and P2TR (bc1p) addresses.
// signMessage routes through dapp-bridge -> signMessageBtc (SECP256K1 / ECDSA / DoubleSHA256).

type BtcAddress = { address: string; publicKey: string; purpose: 'payment' | 'ordinals' };

const bitcoinProvider = {
  isChromatika: true,

  requestAccounts: async (): Promise<BtcAddress[]> => {
    const result = await postToExtension({ method: 'bitcoin_requestAccounts' }) as { addresses: BtcAddress[] };
    return result.addresses;
  },

  getAccounts: async (): Promise<BtcAddress[]> => {
    const result = await postToExtension({ method: 'bitcoin_requestAccounts' }) as { addresses: BtcAddress[] };
    return result.addresses;
  },

  getNetwork: async (): Promise<'Mainnet' | 'Testnet'> => {
    const result = await postToExtension({ method: 'bitcoin_getNetwork' }) as { network: string };
    return result.network === 'testnet' ? 'Testnet' : 'Mainnet';
  },

  signMessage: async (address: string, message: string): Promise<{ signature: string; address: string }> => {
    const hex = Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('');
    const result = await postToExtension({ method: 'bitcoin_signMessage', params: [address, hex] }) as { signature: string };
    return { signature: result.signature, address };
  },

  on,
  removeListener,
};

// --- global declarations ---

declare global {
  interface Window {
    chromatika?: { version: string };
    ethereum?: typeof provider;
    solana?: typeof solanaProvider;
    sui?: typeof suiProvider;
    bitcoin?: typeof bitcoinProvider;
    aptos?: typeof aptosProvider;
  }
}

// another wallet extension may have already locked window.ethereum (or friends)
// as a getter-only property. direct assignment throws, which used to abort the
// whole inject script and drop window.solana / window.sui / etc. wrap each one
// so a single lost slot does not kill the rest, EIP-6963 announce + Wallet
// Standard registration still work regardless.
function safeAssign<K extends keyof Window>(key: K, value: Window[K]): void {
  try {
    (window as unknown as Record<string, unknown>)[key as string] = value;
  } catch {
    try {
      Object.defineProperty(window, key as string, { value, configurable: true, writable: true });
    } catch { /* another wallet owns this slot, leave it alone, EIP-6963 still works */ }
  }
}

safeAssign('chromatika', { version: '0.1.1' });
safeAssign('ethereum', provider);
safeAssign('solana', solanaProvider);
safeAssign('sui', suiProvider);
safeAssign('bitcoin', bitcoinProvider);
safeAssign('aptos', aptosProvider);

registerChromatikaWalletStandard(postToExtension);

window.dispatchEvent(
  new CustomEvent('chromatika#initialized', { detail: { version: '0.1.1' } }),
);
