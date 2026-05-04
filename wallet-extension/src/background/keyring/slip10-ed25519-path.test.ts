import { describe, expect, it } from 'vitest';
import { mnemonicToSeedSync } from '@scure/bip39';
import { bytesToHex } from '@noble/hashes/utils.js';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { slip10Ed25519DerivePath } from '@/background/keyring/slip10-ed25519-path';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('slip10Ed25519DerivePath', () => {
  it('matches Mysten Ed25519Keypair.deriveKeypair for m/44\'/784\'/…', () => {
    const path = "m/44'/784'/0'/0'/0'";
    const suiKp = Ed25519Keypair.deriveKeypair(TEST_MNEMONIC, path);
    const { secretKey } = decodeSuiPrivateKey(suiKp.getSecretKey());
    const seedHex = bytesToHex(mnemonicToSeedSync(TEST_MNEMONIC));
    const got = slip10Ed25519DerivePath(path, seedHex);
    expect(Buffer.from(got.key).equals(Buffer.from(secretKey))).toBe(true);
  });
});
