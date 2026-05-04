/** wallet-style labels for dWallets in approvals and cards */

export function dwalletTailHex(id: string): string {
  const hex = id.startsWith('0x') ? id.slice(2) : id;
  return hex.slice(-4).toLowerCase();
}

export function truncateAddress(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

/** last `tail` chars with ellipsis prefix, e.g. …a0bc (for aligned narrow columns). */
export function truncateAddressTail(addr: string, tail = 4): string {
  if (!addr) return '';
  if (addr.length <= tail + 1) return addr;
  return `…${addr.slice(-tail)}`;
}

/** "EVM Wallet [...ae9b] - 0x0aaa...bbbb" */
export function evmWalletStyleLabel(dwalletId: string, evmAddress?: string | null): string {
  const tail = dwalletTailHex(dwalletId);
  const addrPart = evmAddress ? truncateAddress(evmAddress) : '…';
  return `EVM Wallet [...${tail}] - ${addrPart}`;
}

/** Sui / Solana / Aptos dapp connect picker (ED25519 dWallet). */
export function ed25519DappWalletStyleLabel(dwalletId: string, suiAddress?: string | null): string {
  const tail = dwalletTailHex(dwalletId);
  const addrPart = suiAddress ? truncateAddress(suiAddress) : truncateAddress(dwalletId, 10, 6);
  return `dWallet [...${tail}] - ${addrPart}`;
}
