import { computeAddress } from 'ethers';
import { getDwalletSecpPublicKey } from './bitcoin';
import { chainAddressesForDwalletId } from '@/background/chains/dwallet-derived-addresses';
import { resolveSecpDwalletIdForDapp } from '@/background/dapp-dwallet-resolve';

/**
 * EIP-55 Ethereum address from a specific Active SECP256K1 dWallet object id.
 */
export async function getEvmAddressForDwalletId(dwalletId: string): Promise<string> {
  const pack = await chainAddressesForDwalletId(dwalletId);
  const evm = pack.addresses.evm;
  if (!evm) {
    throw new Error(
      `No EVM address for this dWallet (curve ${pack.curve}, status ${pack.status} - need Active SECP256K1)`,
    );
  }
  return evm;
}

/**
 * EVM address for a dapp origin: uses per-site `selectedDwalletId` when set, else vault default.
 */
export async function getEvmAddressForOrigin(origin: string | undefined): Promise<string> {
  const id = await resolveSecpDwalletIdForDapp(origin);
  return getEvmAddressForDwalletId(id);
}

/**
 * EIP-55 Ethereum address from the vault-default SECP256K1 dWallet (meta / discover).
 */
export async function getEvmAddress(): Promise<string> {
  const pubkey = await getDwalletSecpPublicKey();
  const hex = '0x' + Array.from(pubkey, (b) => b.toString(16).padStart(2, '0')).join('');
  return computeAddress(hex);
}
