/** ika 0.3.x may surface DWalletCap object id in multiple shapes (`id`, nested `{id}`, or `address`). */

export function dwalletCapObjectId(cap: { id?: unknown; address?: unknown; dwallet_id?: string }): string {
  const id = cap.id;
  if (typeof id === 'string') return id;
  if (id && typeof id === 'object' && id !== null && 'id' in id && typeof (id as { id: string }).id === 'string') {
    return (id as { id: string }).id;
  }
  const address = cap.address;
  if (typeof address === 'string') return address;
  if (
    address
    && typeof address === 'object'
    && address !== null
    && 'address' in address
    && typeof (address as { address: string }).address === 'string'
  ) {
    return (address as { address: string }).address;
  }
  throw new Error('DWalletCap missing object id');
}
