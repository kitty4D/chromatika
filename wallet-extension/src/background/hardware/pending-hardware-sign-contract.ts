/**
 * Background ↔ popup contract for `PendingHardwareSign` (P2-9).
 * Keep payload rules stable; `LedgerSigner` and enqueue sites must match.
 */

import type { PendingHardwareSign } from './types';

/** Queue entry without Promise handlers (what `getPendingHardwareSignMeta` exposes). */
export type HardwareSignRequestMeta = Omit<PendingHardwareSign, 'resolve' | 'reject'>;

const HEX_NO_PREFIX = /^[0-9a-f]+$/i;

function strip0x(hex: string): string {
  return hex.replace(/0x/gi, '');
}

function assertHexPayloadNo0x(label: string, payloadHex: string, requireEven = true): void {
  if (!payloadHex || typeof payloadHex !== 'string') {
    throw new Error(`${label}: payloadHex required`);
  }
  const trimmed = payloadHex.trim();
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    throw new Error(`${label}: payloadHex must not include 0x prefix (use raw hex)`);
  }
  if (!HEX_NO_PREFIX.test(trimmed)) {
    throw new Error(`${label}: payloadHex must be lowercase/uppercase hex digits only`);
  }
  if (requireEven && trimmed.length % 2 !== 0) {
    throw new Error(`${label}: payloadHex must have even length (full bytes)`);
  }
}

/** EVM typedData passes `hashDomain + hashStruct` which may concatenate two `0x…` strings from ethers. */
function assertEvmPayloadHex(label: string, payloadHex: string): void {
  if (!payloadHex || typeof payloadHex !== 'string') {
    throw new Error(`${label}: payloadHex required`);
  }
  const digits = strip0x(payloadHex.trim());
  if (!digits || !HEX_NO_PREFIX.test(digits)) {
    throw new Error(`${label}: payloadHex must be hex (0x prefixes stripped for validation)`);
  }
  if (digits.length % 2 !== 0) {
    throw new Error(`${label}: payloadHex must represent full bytes after normalizing`);
  }
}

/**
 * Validates a pending hardware sign request before enqueue (fail fast in background).
 */
export function validateHardwareSignRequestPayload(
  req: Omit<PendingHardwareSign, 'id' | 'resolve' | 'reject'>,
): void {
  if (
    req.vendor !== 'ledger'
    && req.vendor !== 'trezor'
    && req.vendor !== 'mwa'
    && req.vendor !== 'walletconnect'
  ) {
    throw new Error('validateHardwareSignRequestPayload: vendor invalid');
  }

  // MWA is Solana-only
  if (req.vendor === 'mwa') {
    if (req.chain !== 'solana') {
      throw new Error('validateHardwareSignRequestPayload: mwa vendor only supports solana chain');
    }
    if (req.kind !== 'solanaTx' && req.kind !== 'solanaOffchain') {
      throw new Error('validateHardwareSignRequestPayload: mwa vendor requires kind solanaTx|solanaOffchain');
    }
    assertHexPayloadNo0x(req.kind, req.payloadHex, true);
    return;
  }

  // WalletConnect is Solana-only for now (matches the WC v2 surfaces we wire). The WC popup
  // re-uses the persisted relay session via `wcSessionTopic` (analog of MWA's `auth_token`),
  // so all three fields are required at enqueue time.
  if (req.vendor === 'walletconnect') {
    if (req.chain !== 'solana') {
      throw new Error('validateHardwareSignRequestPayload: walletconnect vendor only supports solana chain');
    }
    if (req.kind !== 'solanaTx' && req.kind !== 'solanaOffchain') {
      throw new Error('validateHardwareSignRequestPayload: walletconnect vendor requires kind solanaTx|solanaOffchain');
    }
    if (!req.wcSessionTopic?.trim()) {
      throw new Error('validateHardwareSignRequestPayload: walletconnect vendor requires wcSessionTopic');
    }
    if (!req.wcChainId?.trim()) {
      throw new Error('validateHardwareSignRequestPayload: walletconnect vendor requires wcChainId');
    }
    if (!req.wcAccountAddress?.trim()) {
      throw new Error('validateHardwareSignRequestPayload: walletconnect vendor requires wcAccountAddress');
    }
    assertHexPayloadNo0x(req.kind, req.payloadHex, true);
    return;
  }
  if (!req.derivationPath || typeof req.derivationPath !== 'string') {
    throw new Error('validateHardwareSignRequestPayload: derivationPath required');
  }

  if (req.chain === 'evm') {
    if (req.kind !== 'message' && req.kind !== 'tx' && req.kind !== 'typedData') {
      throw new Error('validateHardwareSignRequestPayload: evm chain requires kind message|tx|typedData');
    }
    if (req.kind === 'typedData') {
      assertEvmPayloadHex('evm.typedData', req.payloadHex);
    } else {
      assertHexPayloadNo0x('evm', req.payloadHex, true);
    }
    return;
  }

  if (req.chain === 'sui') {
    if (req.kind !== 'suiTx') {
      throw new Error('validateHardwareSignRequestPayload: sui chain requires kind suiTx');
    }
    assertHexPayloadNo0x('suiTx', req.payloadHex, true);
    if (!req.ed25519PublicKeyB64?.trim()) {
      throw new Error('validateHardwareSignRequestPayload: suiTx requires ed25519PublicKeyB64');
    }
    return;
  }

  if (req.chain === 'solana') {
    if (req.kind !== 'solanaTx' && req.kind !== 'solanaOffchain') {
      throw new Error('validateHardwareSignRequestPayload: solana chain requires kind solanaTx|solanaOffchain');
    }
    assertHexPayloadNo0x(req.kind, req.payloadHex, true);
    return;
  }

  if (req.chain === 'bitcoin') {
    if (req.kind !== 'btcTx') {
      throw new Error('validateHardwareSignRequestPayload: bitcoin chain requires kind btcTx');
    }
    assertHexPayloadNo0x('btcTx', req.payloadHex, true);
    return;
  }

  throw new Error('validateHardwareSignRequestPayload: unknown chain');
}

/** Strip handlers for JSON-safe / popup meta comparison. */
export function toHardwareSignMeta(entry: PendingHardwareSign): HardwareSignRequestMeta {
  const { resolve: _r, reject: _j, ...meta } = entry;
  return meta;
}
