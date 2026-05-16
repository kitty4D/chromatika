package xyz.chromatika.seeker.identity

import org.bouncycastle.crypto.digests.KeccakDigest
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * canonical, chromatika-scoped, version-tagged domain string the seeker wallet signs to seed
 * the user's ika `UserShareEncryptionKeys`. MUST byte-match the constant in
 * `wallet-extension/src/background/keyring/hd.ts:117` `IKA_USK_DOMAIN`. when the seeker app
 * and the extension both ask seed vault to sign these exact UTF-8 bytes, RFC 8032 ed25519
 * determinism guarantees identical signatures, identical seeds, identical dWallet IDs.
 */
const val IKA_USK_DOMAIN: String = "ika.chromatika.user-share-encryption-key.v1"

/** UTF-8 bytes of [IKA_USK_DOMAIN] — what we hand to seed vault / MWA `signMessages`. */
val IKA_USK_DERIVATION_MESSAGE: ByteArray = IKA_USK_DOMAIN.toByteArray(Charsets.UTF_8)

/**
 * the fee-payer keypair index. index 0 is reserved for the ika
 * `UserShareEncryptionKeys` root seed, so reusing 0 here would collide and leak.
 */
const val IKA_FEE_PAYER_DERIVATION_INDEX: Int = 1

/**
 * keccak256 of `(signature || index_le_4bytes)`. mirrors
 * `ikaRootSeedFromMwaSignature` in `wallet-extension/src/background/keyring/hd.ts:131` byte-for-byte.
 *
 * preconditions:
 *  - `signature` is the raw 64-byte ed25519 signature returned by seed vault / MWA for the
 *    [IKA_USK_DERIVATION_MESSAGE] payload. any non-empty signature is accepted to match the
 *    extension's behavior, but in practice this is always 64 bytes.
 *  - `encryptionKeyIndex` is `>= 0`. 0 is the canonical ika root index.
 *
 * @return 32-byte seed suitable for `UserShareEncryptionKeys.fromRootSeedKey` on the JS side.
 */
fun ikaRootSeedFromMwaSignature(
    signature: ByteArray,
    encryptionKeyIndex: Int = 0,
): ByteArray {
    require(signature.isNotEmpty()) { "ika MWA root seed derivation expects a non-empty signature" }
    require(encryptionKeyIndex >= 0) { "encryptionKeyIndex must be a non-negative integer" }

    val indexLe = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(encryptionKeyIndex).array()
    val preimage = ByteArray(signature.size + indexLe.size).also {
        System.arraycopy(signature, 0, it, 0, signature.size)
        System.arraycopy(indexLe, 0, it, signature.size, indexLe.size)
    }
    return keccak256(preimage)
}

/**
 * deterministic 64-byte solana secret key derived from a wallet signature, keyed by [index].
 * mirrors `solanaFeeKeypairFromWalletSignature` in
 * `wallet-extension/src/background/keyring/hd.ts:154`.
 *
 * use this for the in-app solana fee payer that pays ika `approve_message` gRPC fees. derived
 * from the same wallet signature as the ika root seed but at a different index, so its address
 * is stable across reinstalls and any SOL on the prior install survives the move.
 *
 * @throws IllegalArgumentException for the reserved index `0` and for non-positive indices,
 * matching the extension's runtime guard.
 */
fun solanaFeeKeypairFromWalletSignature(
    signature: ByteArray,
    index: Int = IKA_FEE_PAYER_DERIVATION_INDEX,
): SolanaKeypair {
    require(signature.isNotEmpty()) { "solana fee-payer derivation expects a non-empty signature" }
    require(index >= 0) { "index must be a non-negative integer" }
    require(index != 0) { "index 0 is reserved for the ika UserShareEncryptionKeys root seed" }

    val indexLe = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(index).array()
    val preimage = ByteArray(signature.size + indexLe.size).also {
        System.arraycopy(signature, 0, it, 0, signature.size)
        System.arraycopy(indexLe, 0, it, signature.size, indexLe.size)
    }
    val seed = keccak256(preimage)
    return SolanaKeypair.fromSeed(seed)
}

internal fun keccak256(bytes: ByteArray): ByteArray {
    val digest = KeccakDigest(256)
    digest.update(bytes, 0, bytes.size)
    val out = ByteArray(32)
    digest.doFinal(out, 0)
    return out
}

/**
 * a solana ed25519 keypair in the same `[ 32-byte seed | 32-byte pubkey ]` layout that
 * `@solana/web3.js` `Keypair.secretKey` produces. shape-compatible with phantom / solflare
 * exports, with `solana-keygen` JSON, and with the extension's
 * `ikaRootSeedFromSolanaKeypair` 64-byte secret-key contract.
 */
class SolanaKeypair private constructor(
    val secretKey: ByteArray,
    val publicKey: ByteArray,
) {
    init {
        require(secretKey.size == 64) { "solana secret key must be 64 bytes" }
        require(publicKey.size == 32) { "solana public key must be 32 bytes" }
    }

    companion object {
        fun fromSeed(seed32: ByteArray): SolanaKeypair {
            require(seed32.size == 32) { "ed25519 seed must be 32 bytes" }
            val priv = Ed25519PrivateKeyParameters(seed32, 0)
            val pub = priv.generatePublicKey().encoded
            val secretKey = ByteArray(64).also {
                System.arraycopy(seed32, 0, it, 0, 32)
                System.arraycopy(pub, 0, it, 32, 32)
            }
            return SolanaKeypair(secretKey, pub)
        }
    }
}
