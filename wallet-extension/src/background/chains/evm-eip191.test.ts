import { describe, expect, it } from 'vitest';
import { hashMessage, keccak256, verifyMessage, Wallet } from 'ethers';
import {
  eip191EthereumSignedMessagePreimage,
  personalSignMessageBody,
} from '@/background/chains/evm-eip191';

describe('eip191EthereumSignedMessagePreimage', () => {
  it('matches ethers hashMessage digest for utf-8 string body', () => {
    const body = personalSignMessageBody('hello');
    const preimage = eip191EthereumSignedMessagePreimage(body);
    expect(keccak256(preimage)).toBe(hashMessage('hello'));
  });

  it('matches ethers hashMessage for hex-encoded body bytes', () => {
    const body = personalSignMessageBody('0xdeadbeef');
    const preimage = eip191EthereumSignedMessagePreimage(body);
    expect(keccak256(preimage)).toBe(hashMessage(body));
  });

  it('aligns with verifyMessage after Wallet.signMessage', async () => {
    const w = Wallet.createRandom();
    const msg = 'chromatika eip-191 vector';
    const sig = await w.signMessage(msg);
    expect(verifyMessage(msg, sig)).toBe(w.address);
  });
});
