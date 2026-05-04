/**
 * EIP-191 personal_sign preimage for EVM.
 * ika `requestSign` with Hash.KECCAK256 hashes these bytes once, that digest must match
 * `ethers.hashMessage` so `verifyMessage` / `recoverAddress` agree with other wallets.
 */

import { concat, getBytes, isHexString, MessagePrefix, toUtf8Bytes } from 'ethers';

/** body bytes for the signed payload (before the \\x19Ethereum prefix). */
export function personalSignMessageBody(param: string): Uint8Array {
  const s = param.trim();
  if (isHexString(s, true) && s.length > 2) {
    return getBytes(s);
  }
  return toUtf8Bytes(s);
}

/** bytes ika should treat as the preimage for KECCAK256 before ECDSA (same inner layout as ethers `hashMessage`). */
export function eip191EthereumSignedMessagePreimage(messageBody: Uint8Array): Uint8Array {
  return getBytes(
    concat([
      toUtf8Bytes(MessagePrefix),
      toUtf8Bytes(String(messageBody.length)),
      messageBody,
    ]),
  );
}
