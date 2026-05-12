# `@noble/*` and `@scure/*` crypto libraries

chromatika's crypto primitives come from Paul Miller's two npm scopes: `@noble/*` (curves + hashes + ed25519 / secp256k1) and `@scure/*` (BIP39 / BIP32 / base encodings). both are audit-grade, dep-free, and browser-compatible. they replace older bundles that historically had supply-chain risk.

## the libs

| package | version | what |
|---------|---------|------|
| `@noble/ed25519` | ^3.1.0 | ed25519 keypair gen, sign, verify (RFC 8032) |
| `@noble/secp256k1` | ^3.1.0 | secp256k1 keypair gen, sign, verify, recover |
| `@noble/hashes` | ^2.2.0 | SHA-2, SHA-3 (Keccak), BLAKE2b, HMAC, PBKDF2, etc. |
| `@scure/bip39` | ^2.2.0 | BIP39 mnemonic gen, validate, seed derive |
| `@scure/bip32` | ^2.2.0 | BIP32 HD derivation (secp256k1 hardened + non-hardened) |
| `@scure/base` | ^2.2.0 | base58, base64, bech32, bech32m, hex |

## why noble / scure

historically, browser crypto came from:
- `tweetnacl` for ed25519 (small, but limited)
- `elliptic` for secp256k1 (lots of deps, audit issues)
- `bip39`, `hdkey`, `secp256k1` (separate packages, varying quality)

noble + scure consolidate. design principles:
- **zero dependencies** at runtime (no transitive supply chain)
- **TypeScript native** (no `@types/*` wrappers)
- **audit-grade** (paid audits + ongoing review)
- **constant-time** where it matters (resists timing side channels)
- **modular** (import only what you need; tree-shakes well)

bundle size: noble libs are ~5-15 KB minified per primitive. tweetnacl is ~25 KB for ed25519 alone. elliptic was ~80 KB. noble wins on every axis.

## what chromatika uses each for

### `@noble/ed25519`

```ts
import * as ed from '@noble/ed25519';

const pubkey = await ed.getPublicKeyAsync(secretKey32);
const sig = await ed.signAsync(message, secretKey32);
const valid = await ed.verifyAsync(sig, message, pubkey);
```

primarily used **internally** by `@solana/web3.js` Keypair, `@mysten/sui` Ed25519Keypair, and chromatika's seed-derivation paths. chromatika rarely imports noble/ed25519 directly - it goes through higher-level wrappers.

### `@noble/secp256k1`

```ts
import * as secp from '@noble/secp256k1';

const pubkey = secp.getPublicKey(secretKey32, true);          // compressed
const sig = secp.sign(messageHash, secretKey32);
const valid = secp.verify(sig, messageHash, pubkey);
const recovered = secp.recoverPublicKey(messageHash, sig.toCompactRawBytes(), recoveryBit);
```

used by `bitcoinjs-lib` internally and by chromatika for any direct secp256k1 math (rare since ika MPC handles signing; noble used for verification only).

### `@noble/hashes`

```ts
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { blake2b } from '@noble/hashes/blake2b';
import { hmac } from '@noble/hashes/hmac';
import { pbkdf2 } from '@noble/hashes/pbkdf2';

const digest = keccak_256(preimage);                           // 32 bytes
const blakeDigest = blake2b(input, { dkLen: 32 });             // BLAKE2b-256
const hmacOut = hmac(sha512, key, message);
const seed = pbkdf2(sha512, password, salt, { c: 2048, dkLen: 64 });
```

used **everywhere** in chromatika:
- `keccak256` for ika seed derivation, EVM digest, EVM address
- `blake2b256` for Sui address derivation, Sui intent digest
- `sha512` inside ed25519 / BIP32 / SLIP10 derivations
- `pbkdf2` inside BIP39 (mnemonic → seed)

### `@scure/bip39`

```ts
import { generateMnemonic, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const phrase = generateMnemonic(wordlist, 128);                // 12 words from 128-bit entropy
const isValid = validateMnemonic(phrase, wordlist);
const seed = mnemonicToSeedSync(phrase, '');                   // 64-byte BIP39 seed via PBKDF2
```

chromatika uses for:
- generating mnemonics at vault create time
- validating mnemonics on import
- deriving the 64-byte BIP39 seed that feeds BIP32 / SLIP10

### `@scure/bip32`

```ts
import { HDKey } from '@scure/bip32';

const root = HDKey.fromMasterSeed(bip39Seed);
const child = root.derive("m/44'/60'/0'/0/0");
const pubkey = child.publicKey;                                // 33-byte compressed secp256k1
const privkey = child.privateKey;                              // 32-byte secret
```

used for EVM (`m/44'/60'/...`) and Bitcoin (`m/84'/0'/...`, `m/86'/0'/...`) derivation. for ed25519 (Sui / Solana / Aptos), chromatika uses an internal SLIP10 helper instead since BIP32 is secp256k1-only.

### `@scure/base`

```ts
import { base58, base64, hex, bech32, bech32m } from '@scure/base';

const b58 = base58.encode(bytes);
const decoded = base58.decode(b58Str);
const bech = bech32.encode('bc', words);
```

used by Bitcoin (bech32 / bech32m for segwit / taproot addresses), Solana (base58), and various encoding paths. modular: only import the formats you need.

## the security stance

noble's threat model: protect against **timing attacks** + **algorithmic correctness** + **supply chain integrity**. paid audits (Cure53, others). actively maintained.

scure inherits the same principles. both are sponsored by the broader Ethereum / wallet ecosystem (gitcoin grants, direct funding from major wallets).

chromatika's choice to standardize on noble / scure is a **deliberate move away from older crypto libs** with checkered audit / supply-chain history.

## library

- per package above
- internal: chromatika imports specific modules per file rather than re-exporting from a single helper. e.g. `keyring/hd.ts` imports `keccak_256`, `mnemonicToSeedSync`, `HDKey` directly

## related

- [bip39-mnemonic.md](/library/tech/bip39-mnemonic) - the BIP39 path
- [bip44-slip10-derivation.md](/library/tech/bip44-slip10-derivation) - the HD derivation paths
- [keccak256-uses.md](/library/tech/keccak256-uses) - keccak usage
- [sha512-and-blake2b.md](/library/tech/sha512-and-blake2b) - SHA-512 / BLAKE2b usage
- [secp256k1-ecdsa.md](/library/tech/secp256k1-ecdsa), [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - signing curves
