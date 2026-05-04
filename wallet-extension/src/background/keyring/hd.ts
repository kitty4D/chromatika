import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { Keypair, type Keypair as SolanaKeypair } from '@solana/web3.js';
import { slip10Ed25519DerivePath } from '@/background/keyring/slip10-ed25519-path';
import { decodeSuiPrivateKey, SIGNATURE_SCHEME_TO_FLAG } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getPublicKey, hashes as edHashes } from '@noble/ed25519';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

/** noble-ed25519 v3 sync APIs require a sha512 implementation. */
edHashes.sha512 = sha512;

export const SUI_PATH_PREFIX = "m/44'/784'/0'/0'";

/**
 * Sui Ed25519 accounts use SLIP-0010 at m/44'/784'/... (see Mysten `Ed25519Keypair.deriveKeypair`).
 * do not use @scure/bip32 here, that is secp256k1 BIP32 and produces different keys than Slush / Sui Wallet.
 */

export function newMnemonic(words: 12 | 24 = 12): string {
  return generateMnemonic(wordlist, words === 12 ? 128 : 256);
}

export function validateWords(mnemonic: string): boolean {
  return validateMnemonic(mnemonic, wordlist);
}

export function deriveSuiKeypair(mnemonic: string, accountIndex: number): Ed25519Keypair {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Invalid mnemonic');
  const path = `${SUI_PATH_PREFIX}/${accountIndex}'`;
  return Ed25519Keypair.deriveKeypair(mnemonic, path);
}

/** standard Solana path: m/44'/501'/account'/0' (Phantom / Solflare compatible). */
export function deriveSolanaKeypair(mnemonic: string, accountIndex = 0): Keypair {
  if (!validateMnemonic(mnemonic, wordlist)) throw new Error('Invalid mnemonic');
  const path = `m/44'/501'/${accountIndex}'/0'`;
  const seedHex = bytesToHex(mnemonicToSeedSync(mnemonic));
  const derived = slip10Ed25519DerivePath(path, seedHex);
  return Keypair.fromSeed(derived.key.slice(0, 32));
}

/**
 * 32-byte root seed for `UserShareEncryptionKeys.fromRootSeedKey`, aligned with ika CLI
 * `resolve_seed` (address-based): `keccak256(sui_keypair.to_bytes() || index.to_le_bytes())`.
 * `to_bytes()` is Mysten `SuiKeyPair::to_bytes` (scheme flag + private key bytes); for Ed25519 that is 33 bytes.
 *
 * used for **Sui-base** ika vaults so a CLI run (`ika dwallet register-encryption-key` / `create`)
 * with the same fee-payer keypair derives the same encryption key.
 *
 * for Solana-base vaults use `ikaRootSeedFromSolanaKeypair`: the ika CLI has no Solana base path,
 * so we do not owe it parity and skip the Sui dependency entirely.
 * @see skills/ika-cli/references/commands.md (SeedArgs)
 */
export function ikaRootSeedFromFeeKeypair(
  feePayerKeypair: Ed25519Keypair,
  encryptionKeyIndex = 0,
): Uint8Array {
  const { scheme, secretKey } = decodeSuiPrivateKey(feePayerKeypair.getSecretKey());
  if (scheme !== 'ED25519') {
    throw new Error('ika root seed derivation expects an Ed25519 fee payer key');
  }
  const flag = SIGNATURE_SCHEME_TO_FLAG[scheme];
  const keypairBytes = new Uint8Array(1 + secretKey.length);
  keypairBytes[0] = flag;
  keypairBytes.set(secretKey, 1);
  const indexLe = new Uint8Array(4);
  new DataView(indexLe.buffer).setUint32(0, encryptionKeyIndex, true);
  const preimage = new Uint8Array(keypairBytes.length + indexLe.length);
  preimage.set(keypairBytes, 0);
  preimage.set(indexLe, keypairBytes.length);
  return keccak_256(preimage);
}

/**
 * 32-byte root seed for `UserShareEncryptionKeys.fromRootSeedKey` derived from the **Solana** fee
 * payer keypair: `keccak256(secretKey64 || index.to_le_bytes())`.
 *
 * `secretKey64` is `Keypair.secretKey` (64 bytes; the 32-byte Ed25519 seed concatenated with the
 * 32-byte public key). this is the canonical Solana wallet export shape (Phantom / Solflare /
 * `solana-keygen` JSON), so a user pasting their Solana keypair back later derives the same seed.
 *
 * **why Solana-only:** ika's protocol only needs *some* deterministic 32-byte seed; the choice of
 * preimage is a client decision. using the Sui formula on Solana-base vaults would force users
 * onto a Sui-shaped fee key they never use. the Solana-base CLI does not exist yet, so there is
 * nothing to match here: when it ships, we can verify and adjust if needed (pre-release).
 */
export function ikaRootSeedFromSolanaKeypair(
  solanaKeypair: SolanaKeypair,
  encryptionKeyIndex = 0,
): Uint8Array {
  const secretKey = solanaKeypair.secretKey;
  if (secretKey.length !== 64) {
    throw new Error('ika Solana root seed derivation expects a 64-byte Solana secret key');
  }
  const indexLe = new Uint8Array(4);
  new DataView(indexLe.buffer).setUint32(0, encryptionKeyIndex, true);
  const preimage = new Uint8Array(secretKey.length + indexLe.length);
  preimage.set(secretKey, 0);
  preimage.set(indexLe, secretKey.length);
  return keccak_256(preimage);
}

/**
 * domain string the wallet (Seeker / Phantom Android / Solflare Android via MWA) signs to seed
 * the user's ika `UserShareEncryptionKeys`. versioned + chromatika-scoped so the derivation can
 * rotate without colliding with any other ika integrator that might also use the same Seeker.
 *
 * the "wallet-signature-derived" pattern is the recommended browser-extension flow per
 * `skills/ika-solana-prealpha/references/user-share-encryption-keys.md` ("nothing secret needs
 * to live in extension storage; re-derive on demand"). Ed25519 is deterministic per RFC 8032,
 * so the same Seeker signing the same message yields the same signature on any device, that
 * property is what makes Seeker-only restore possible.
 */
export const IKA_USK_DOMAIN = 'ika.chromatika.user-share-encryption-key.v1';

/** bytes the MWA wallet signs (UTF-8 of `IKA_USK_DOMAIN`). */
export const IKA_USK_DERIVATION_MESSAGE: Uint8Array = new TextEncoder().encode(IKA_USK_DOMAIN);

/**
 * 32-byte ika `UserShareEncryptionKeys` seed derived from an MWA wallet signature over the
 * `IKA_USK_DOMAIN` message: `keccak256(signature || index_le)`. the signature comes from
 * `wallet.signMessages([IKA_USK_DERIVATION_MESSAGE])` during pairing: Seed Vault on Seeker
 * (or any MWA-compliant Android wallet) signs without ever exposing secret bytes.
 *
 * same derivation, same Seeker, any device -> same seed -> same dWallet (provided the wallet
 * implements deterministic Ed25519, which is the spec).
 */
export function ikaRootSeedFromMwaSignature(
  signature: Uint8Array,
  encryptionKeyIndex = 0,
): Uint8Array {
  if (!(signature instanceof Uint8Array) || signature.length === 0) {
    throw new Error('ika MWA root seed derivation expects a non-empty signature');
  }
  const indexLe = new Uint8Array(4);
  new DataView(indexLe.buffer).setUint32(0, encryptionKeyIndex, true);
  const preimage = new Uint8Array(signature.length + indexLe.length);
  preimage.set(signature, 0);
  preimage.set(indexLe, signature.length);
  return keccak_256(preimage);
}

/**
 * index used by `solanaFeeKeypairFromWalletSignature` so the fee-payer keypair is
 * derived independently from the ika root seed at index 0. **never reuse 0** for fee
 * payer derivation - that would key-collide with the ika UserShareEncryptionKeys seed.
 */
export const IKA_FEE_PAYER_DERIVATION_INDEX = 1;

/**
 * deterministic Solana `Keypair` derived from a wallet signature over `IKA_USK_DERIVATION_MESSAGE`,
 * keyed by `index` so it lives in a separate slot from the ika seed at index 0.
 *
 * why deterministic: the in-extension fee-payer keypair pays ika `approve_message` gRPC fees.
 * if we generated it randomly per install (the previous design), restoring on a new device
 * would land on a fresh address and any SOL on the prior device's fee payer would be stranded.
 * deterministic from the wallet signature means same Seeker on any device -> same fee-payer
 * address -> SOL persists across reinstalls. trust model is unchanged: anyone who can prompt
 * the wallet to sign `IKA_USK_DERIVATION_MESSAGE` could already derive the dWallet share
 * encryption keys, so producing the fee payer keypair from the same source adds no new
 * surface.
 *
 * `Keypair.fromSeed` accepts any 32 bytes as the Ed25519 seed; we hash the (signature, index)
 * pair so a future caller picking a different index can't collide with the ika root.
 */
export function solanaFeeKeypairFromWalletSignature(
  signature: Uint8Array,
  index: number = IKA_FEE_PAYER_DERIVATION_INDEX,
): SolanaKeypair {
  if (!(signature instanceof Uint8Array) || signature.length === 0) {
    throw new Error('Solana fee keypair derivation expects a non-empty signature');
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Solana fee keypair derivation index must be a non-negative integer');
  }
  if (index === 0) {
    // defensive: ika UserShareEncryptionKeys seed lives at index 0. refuse to reuse it for
    // fee-payer derivation so callers can't accidentally key-collide.
    throw new Error('Solana fee keypair derivation must not use index 0 (reserved for ika root seed)');
  }
  const indexLe = new Uint8Array(4);
  new DataView(indexLe.buffer).setUint32(0, index, true);
  const preimage = new Uint8Array(signature.length + indexLe.length);
  preimage.set(signature, 0);
  preimage.set(indexLe, signature.length);
  const seed = keccak_256(preimage);
  return Keypair.fromSeed(seed);
}

/**
 * 32-byte ika `UserShareEncryptionKeys` seed derived from a webauthn prf hmac-secret output:
 * `keccak256(prfOutput || index_le)`. used by the **sui passkey** vault.
 *
 * webauthn prf gives us a deterministic 32-byte secret per `(credential, salt)` pair. with
 * chromatika's salt fixed to a constant via `chromatikaPrfSaltB64()`, the prf output depends
 * only on the per-credential authenticator secret (which lives on-device + survives platform
 * passkey sync). same passkey credential = same prf output = same ika seed across reinstalls
 * and synced devices = same dWallet. on extension reinstall the existing dwallet caps owned by
 * the recovered passkey sui address are auto-discovered via `kickDiscoveryForVault`, so a fresh
 * "create with passkey" flow effectively restores the prior vault when the same passkey is
 * selected.
 *
 * `encryptionKeyIndex` is bip44-style: index 0 is the default first vault for a credential,
 * index 1 is a sibling "second account" on the SAME credential. different credentials produce
 * different prf outputs even at the same index.
 *
 * the wrapper around `BrowserPasskeyProvider` lives in `src/ui/passkey/passkey-provider-with-prf.ts`
 * and opts into `extensions: { prf: { eval: { first: prfSalt } } }` on both create and get; the
 * 32 bytes come back at `credential.getClientExtensionResults().prf.results.first`.
 */
export function ikaRootSeedFromPasskeyPRF(
  prfOutput: Uint8Array,
  encryptionKeyIndex = 0,
): Uint8Array {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) {
    throw new Error('ika passkey root seed derivation expects a 32-byte prf hmac-secret output');
  }
  const indexLe = new Uint8Array(4);
  new DataView(indexLe.buffer).setUint32(0, encryptionKeyIndex, true);
  const preimage = new Uint8Array(prfOutput.length + indexLe.length);
  preimage.set(prfOutput, 0);
  preimage.set(indexLe, prfOutput.length);
  return keccak_256(preimage);
}

/**
 * 32-byte ika seed derived from a bip39 recovery phrase: bip39 → 64-byte seed →
 * `keccak256(seed || index_le)`. universal fallback for any vault kind whose `seedSource ===
 * 'recovery-words'`, covers the case where the platform-native deterministic source (passkey
 * prf, waap signature, lazor session-key prf) is not available or the user explicitly opted
 * into a phrase-based backup.
 *
 * **independent of any chain-specific keypair derivation.** the same 24 words can re-anchor
 * a sui-passkey, waap, or lazor vault: the ika seed is the same; the chain-side identity
 * (passkey credential / waap account / lazor pda) is rebound on top via the vault-kind
 * recovery flow (e.g., guardian rotation for lazor).
 */
export function ikaRootSeedFromRecoveryWords(
  words: string,
  encryptionKeyIndex = 0,
): Uint8Array {
  if (!validateMnemonic(words, wordlist)) {
    throw new Error('ika recovery-words seed derivation expects a valid bip39 phrase');
  }
  const seed = mnemonicToSeedSync(words);
  const indexLe = new Uint8Array(4);
  new DataView(indexLe.buffer).setUint32(0, encryptionKeyIndex, true);
  const preimage = new Uint8Array(seed.length + indexLe.length);
  preimage.set(seed, 0);
  preimage.set(indexLe, seed.length);
  return keccak_256(preimage);
}

/**
 * deterministic solana `Keypair` for use as a **lazor session key**, derived from a webauthn prf
 * hmac-secret output via `Keypair.fromSeed(prfOutput.slice(0, 32))`. the same lazor passkey on
 * a synced device produces the same prf output → same session keypair → same on-chain session
 * pda authority → same ika fee payer / seed source.
 *
 * pair this with `ikaRootSeedFromSolanaKeypair(sessionKey, index)` to get the ika
 * `UserShareEncryptionKeys` seed for a lazor vault. mirrors how seeker / mwa hardware vaults
 * derive their ika seed from the wallet's Ed25519 signature, but with a deterministic-by-prf
 * keypair instead of a deterministic-by-RFC8032 signature.
 */
export function lazorSessionKeyFromPasskeyPRF(prfOutput: Uint8Array): SolanaKeypair {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) {
    throw new Error('lazor session key derivation expects a 32-byte prf hmac-secret output');
  }
  return Keypair.fromSeed(prfOutput);
}

export function suiAddressFromMnemonic(mnemonic: string, accountIndex = 0): string {
  const kp = deriveSuiKeypair(mnemonic, accountIndex);
  return kp.toSuiAddress();
}

export function evmAddressFromEd25519Pubkey(pub32: Uint8Array): `0x${string}` {
  const pk = getPublicKey(pub32.slice(0, 32));
  const hash = keccak_256(pk.slice(1));
  return (`0x${bytesToHex(hash.slice(-20))}`) as `0x${string}`;
}

// ─── X25519 inbox key (for cross-recipient `DirectEd25519Backend` decrypt) ───────
//
// per `docs/ENCRYPTION_BACKEND.md` option-b: each user has a separate HD-derived X25519
// keypair, distinct from the dWallet ed25519 identity, used only as their cross-recipient
// inbox key. decouples ECDH-decrypt from MPC; the dWallet ed25519 stays purely for chain
// signing.
//
// derivation: `keccak256(IKA_USK_DERIVATION_MESSAGE_BYTES || INBOX_X25519_DOMAIN_BYTES ||
// rootSecret || index_le)` -> 32-byte raw X25519 secret. we re-derive on every read; chromatika
// never persists the secret separately. the `rootSecret` shape varies by vault kind:
//   - hd: bip39 mnemonic seed (64 bytes)
//   - hardware (mwa/seeker): wallet signature over IKA_USK_DERIVATION_MESSAGE
//   - passkey: prf hmac-secret output (32 bytes)
// matching the same source used for the ika UserShareEncryptionKeys seed, but with a
// different domain string so the two keys cannot collide.

/** domain-separation tag for HD-derived X25519 inbox secret. */
export const INBOX_X25519_DOMAIN = 'chromatika.inbox-x25519.v1';
const INBOX_X25519_DOMAIN_BYTES = new TextEncoder().encode(INBOX_X25519_DOMAIN);

/**
 * hash-based deterministic X25519 inbox secret from a vault's root secret bytes.
 * returns the raw 32-byte X25519 secret; the public key is derived via
 * `x25519.getPublicKey(secret)` from `@noble/curves/ed25519`.
 *
 * v0 keeps `encryptionKeyIndex` available for sibling-vault parity (matches ika seed
 * derivation), but most use cases will pass 0.
 */
export function x25519InboxSecretFromBytes(
  rootSecret: Uint8Array,
  encryptionKeyIndex = 0,
): Uint8Array {
  if (!(rootSecret instanceof Uint8Array) || rootSecret.length === 0) {
    throw new Error('inbox X25519 derivation expects a non-empty root secret');
  }
  const indexLe = new Uint8Array(4);
  new DataView(indexLe.buffer).setUint32(0, encryptionKeyIndex, true);
  const preimage = new Uint8Array(
    INBOX_X25519_DOMAIN_BYTES.length + rootSecret.length + indexLe.length,
  );
  preimage.set(INBOX_X25519_DOMAIN_BYTES, 0);
  preimage.set(rootSecret, INBOX_X25519_DOMAIN_BYTES.length);
  preimage.set(indexLe, INBOX_X25519_DOMAIN_BYTES.length + rootSecret.length);
  const hashed = keccak_256(preimage);
  // X25519 secret keys are clamped per RFC 7748; @noble/curves does the clamping inside
  // getPublicKey + getSharedSecret so we can pass the raw 32 bytes.
  return hashed;
}

/**
 * X25519 inbox secret for an HD (mnemonic) vault.
 */
export function x25519InboxSecretFromRecoveryWords(
  words: string,
  encryptionKeyIndex = 0,
): Uint8Array {
  if (!validateMnemonic(words, wordlist)) {
    throw new Error('inbox X25519 derivation expects a valid bip39 phrase');
  }
  const seed = mnemonicToSeedSync(words);
  return x25519InboxSecretFromBytes(seed, encryptionKeyIndex);
}

/**
 * X25519 inbox secret for a hardware (MWA/Seeker) vault. source = wallet signature over
 * `IKA_USK_DERIVATION_MESSAGE`. same property as the ika seed: deterministic across devices
 * for the same Seeker pubkey, so inbox decrypts work after a fresh-device restore.
 */
export function x25519InboxSecretFromMwaSignature(
  signature: Uint8Array,
  encryptionKeyIndex = 0,
): Uint8Array {
  if (!(signature instanceof Uint8Array) || signature.length === 0) {
    throw new Error('inbox X25519 MWA derivation expects a non-empty signature');
  }
  return x25519InboxSecretFromBytes(signature, encryptionKeyIndex);
}

/**
 * X25519 inbox secret for a passkey vault. source = WebAuthn PRF hmac-secret output.
 */
export function x25519InboxSecretFromPasskeyPRF(
  prfOutput: Uint8Array,
  encryptionKeyIndex = 0,
): Uint8Array {
  if (!(prfOutput instanceof Uint8Array) || prfOutput.length !== 32) {
    throw new Error('inbox X25519 passkey derivation expects a 32-byte prf hmac-secret output');
  }
  return x25519InboxSecretFromBytes(prfOutput, encryptionKeyIndex);
}

export { bytesToHex, hexToBytes };
