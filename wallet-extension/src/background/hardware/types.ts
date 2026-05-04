/** supported hardware wallet vendors */
export type HardwareVendor = 'ledger' | 'trezor' | 'mwa' | 'walletconnect';

/** per-account descriptor stored after user connects a device */
export type HardwareAccount = {
  id: string;            // e.g. "ledger-0"
  vendor: HardwareVendor;
  chain: 'evm' | 'bitcoin' | 'solana' | 'sui';
  derivationPath: string; // m/44'/60'/0'/0/0
  address: string;       // derived on-device
  /** Sui Ledger fee payer: raw Ed25519 pubkey (32 bytes) as base64 - required for serialized tx signatures. */
  ed25519PublicKeyB64?: string;
  addedAtMs: number;
};

/** a sign request parked while we wait for the popup to open + user confirm */
export type PendingHardwareSign = {
  id: string;
  vendor: HardwareVendor;
  chain: 'evm' | 'bitcoin' | 'sui' | 'solana';
  derivationPath: string;
  /** hex-encoded bytes to sign (no `0x` prefix; evm/sui/solana enqueue sites strip it). */
  payloadHex: string;
  /**
   * evm: personal_sign / eth_sign / typedData preimage, or raw RLP tx.
   * sui: hex-encoded TransactionData BCS (Ledger Sui app signs the same payload Mysten uses).
   * solana: hex-encoded serialized transaction bytes for Ledger Solana app.
   * bitcoin: hex-encoded serialized PSBT bytes for Ledger Bitcoin app.
   */
  kind: 'message' | 'tx' | 'typedData' | 'suiTx' | 'solanaTx' | 'solanaOffchain' | 'btcTx';
  /** MWA: override reflector URL (falls back to MWA_REFLECTOR_URL constant). */
  mwaReflectorUrl?: string;
  /** MWA: which transport the signer popup should use - Android intent vs wss reflector + QR. */
  mwaTransport?: 'local' | 'remote';
  /** MWA remote: opaque `auth_token` from prior `wallet.authorize()` to skip QR rescan. */
  mwaAuthToken?: string;
  /** MWA remote: host authority pinned at pairing time, e.g. `reflect.solanamobile.com`. */
  mwaReflectorHost?: string;
  /** WalletConnect: relay session topic from the original pair, used to route subsequent signs. */
  wcSessionTopic?: string;
  /** WalletConnect: CAIP-2 chain id frozen at pair time (mainnet vs devnet). */
  wcChainId?: string;
  /** WalletConnect: base58 Solana pubkey the wallet authorized at pair time. */
  wcAccountAddress?: string;
  /**
   * Solana cluster label (`'mainnet'`, `'devnet'`, …) the request will broadcast to.
   * surfaced on the WC / MWA sign popup so the user can see whether they're about
   * to sign a mainnet vs devnet transaction. populated by every Solana enqueue
   * site from the active session's `solanaNetworkId`; absent for non-Solana
   * sign requests (evm/btc/sui/aptos), in which case popups don't render it.
   */
  solanaCluster?: string;
  /**
   * Bitcoin network id (`'btc-mainnet'` or `'btc-testnet'`). required for the Trezor
   * `btcTx` path so the signer can pass the right `coin: 'btc' | 'test'` to
   * `TrezorConnect.signTransaction` and decode output addresses under the right network.
   * optional for Ledger (Ledger uses `signPsbtBuffer` which network-detects internally).
   */
  bitcoinNetworkId?: 'btc-mainnet' | 'btc-testnet';
  /**
   * Esplora base URL for the Trezor `btcTx` path. the signer popup fetches refTxs
   * (prev tx hex per input) from this endpoint to feed Trezor's verification step.
   * populated by the BTC enqueue site from the active network registry.
   */
  bitcoinEsploraBase?: string;
  /** Sui: fee payer Ed25519 pubkey base64 (32 bytes) for `toSerializedSignature`. */
  ed25519PublicKeyB64?: string;
  /** resolves with hex signature or rejects */
  resolve: (sig: string) => void;
  reject: (err: Error) => void;
};
