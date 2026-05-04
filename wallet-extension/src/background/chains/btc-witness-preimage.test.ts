import { describe, expect, it } from 'vitest';
import { crypto, networks, payments, Psbt, Transaction } from 'bitcoinjs-lib';
import { witnessV0Preimage } from '@/background/chains/btc-witness-preimage';

describe('witnessV0Preimage', () => {
  it('matches bitcoinjs hashForWitnessV0 (hash256 of preimage)', () => {
    const net = networks.testnet;
    const pubkey = Uint8Array.from(
      Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'),
    );
    const pay = payments.p2wpkh({ pubkey, network: net });
    if (!pay.output || !pay.address) throw new Error('no payment');
    const p2pkh = payments.p2pkh({ hash: pay.output.slice(2), network: net }).output!;

    const psbt = new Psbt({ network: net });
    psbt.addInput({
      hash: '0000000000000000000000000000000000000000000000000000000000000001',
      index: 0,
      witnessUtxo: { script: pay.output, value: 50_000n },
    });
    psbt.addOutput({ address: pay.address, value: 40_000n });

    const tx = (psbt.data.globalMap.unsignedTx as unknown as { tx: InstanceType<typeof Transaction> }).tx;
    const preimage = witnessV0Preimage(tx, 0, p2pkh, 50_000n, Transaction.SIGHASH_ALL);
    const expected = tx.hashForWitnessV0(0, p2pkh, 50_000n, Transaction.SIGHASH_ALL);
    expect(crypto.hash256(preimage)).toEqual(expected);
  });
});
