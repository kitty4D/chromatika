import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getSuiFeePayerSigningContext, getSuiFeePayerSuiAddress } from '@/background/sui/sui-fee-payer-signing';
import type { SessionState } from '@/background/session';

describe('getSuiFeePayerSigningContext', () => {
  it('returns signer and matching fee payer address', () => {
    const kp = Ed25519Keypair.generate();
    const session = { suiKeypair: kp } as unknown as SessionState;
    const ctx = getSuiFeePayerSigningContext(session);
    expect(ctx.signer).toBe(kp);
    expect(ctx.feePayerAddress).toBe(kp.toSuiAddress());
  });

  it('uses Ledger fee address when suiLedgerFee is set', () => {
    const kp = Ed25519Keypair.generate();
    const ledgerAddr = '0x' + 'ab'.repeat(32);
    const session = {
      suiKeypair: kp,
      suiLedgerFee: {
        derivationPath: "m/44'/784'/0'/0'/0'",
        publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        feePayerAddress: ledgerAddr,
      },
    } as unknown as SessionState;
    expect(getSuiFeePayerSuiAddress(session)).toBe(ledgerAddr);
    expect(getSuiFeePayerSigningContext(session).feePayerAddress).toBe(ledgerAddr);
  });
});
