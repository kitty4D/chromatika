package xyz.chromatika.seeker.vault

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator

/**
 * vault blob data classes. wire-compatible with `wallet-extension/src/background/vault.ts`:
 *  - v3 = legacy single-password envelope. one password, one argon2id KEK, one AES-GCM ciphertext.
 *  - v4 = multi-envelope. random master key encrypts the payload. each envelope wraps a copy of
 *    the master key under a method-specific KEK (password, passkey-prf, wallet-signature,
 *    recovery-words). any envelope unwraps the same master key.
 *
 * the seeker app issues v4 blobs by default because seed vault is the primary identity path
 * and `wallet-signature` envelopes need v4. v3 is supported for parity and for accepting blobs
 * minted by a v3-only extension build; it is **never written** by the seeker app.
 *
 * canonical JSON encoding lives in [VaultBlobJson] (kotlinx.serialization). values that travel
 * over the wire are base64-encoded byte strings.
 */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
sealed interface VaultBlob {

    @Serializable
    data class V3(
        val v: Int = 3,
        val kdf: String = "argon2id",
        /** base64, 16 bytes */
        val salt: String,
        /** argon2id time cost (passes) */
        val t: Int,
        /** argon2id memory cost in KiB */
        val m: Int,
        /** argon2id parallelism */
        val p: Int,
        /** base64, 12 bytes */
        val iv: String,
        /** base64 ciphertext + GCM tag */
        val data: String,
    ) : VaultBlob {
        init {
            require(v == 3) { "v3 blob requires v == 3" }
            require(kdf == "argon2id") { "v3 blob requires argon2id KDF" }
        }
    }

    @Serializable
    data class V4(
        val v: Int = 4,
        val envelopes: List<VaultEnvelope>,
        /** base64, 12 bytes */
        val iv: String,
        /** base64 ciphertext + GCM tag (master-key-encrypted vault payload) */
        val data: String,
    ) : VaultBlob {
        init {
            require(v == 4) { "v4 blob requires v == 4" }
            require(envelopes.isNotEmpty()) { "v4 blob requires at least one envelope" }
        }
    }
}

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("kind")
sealed interface VaultEnvelope {

    /** unique within the blob, e.g. `env-pw-1`, `env-passkey-1`. UI uses this for selection. */
    val id: String

    /** human label shown on the unlock screen. */
    val label: String

    /** ms timestamp the envelope was added; UI sorts oldest-first. */
    val addedAtEpochMs: Long

    /** base64 12-byte AES-GCM IV used to wrap the master key under this envelope's KEK. */
    val wrapIv: String

    /** base64 ciphertext: AES-GCM(KEK, masterKeyBytes) + GCM tag. */
    val wrappedMasterKey: String

    @Serializable
    @SerialName("password")
    data class Password(
        override val id: String,
        override val label: String,
        override val addedAtEpochMs: Long,
        override val wrapIv: String,
        override val wrappedMasterKey: String,
        val kdf: String = "argon2id",
        /** base64 16-byte salt, stable per envelope. */
        val salt: String,
        val t: Int,
        val m: Int,
        val p: Int,
    ) : VaultEnvelope

    @Serializable
    @SerialName("passkey-prf")
    data class PasskeyPrf(
        override val id: String,
        override val label: String,
        override val addedAtEpochMs: Long,
        override val wrapIv: String,
        override val wrappedMasterKey: String,
        /** base64url(credential.rawId). passed to passkey provider for credential scoping. */
        val credentialIdB64Url: String,
        /** rpId at registration. for the seeker app, the app package name. */
        val rpId: String,
        /** base64 32-byte salt fed to the webauthn `prf.eval.first` extension. */
        val prfSaltB64: String,
    ) : VaultEnvelope

    @Serializable
    @SerialName("wallet-signature")
    data class WalletSignature(
        override val id: String,
        override val label: String,
        override val addedAtEpochMs: Long,
        override val wrapIv: String,
        override val wrappedMasterKey: String,
        /** which protocol the unlock UI should drive to reproduce the signature. */
        val source: String,
        /** sui address (waap) or solana address (seeker / wc). UI hint + signer selection. */
        val address: String,
        val hint: String? = null,
    ) : VaultEnvelope

    @Serializable
    @SerialName("recovery-words")
    data class RecoveryWords(
        override val id: String,
        override val label: String,
        override val addedAtEpochMs: Long,
        override val wrapIv: String,
        override val wrappedMasterKey: String,
        val wordCount: Int,
    ) : VaultEnvelope {
        init {
            require(wordCount == 12 || wordCount == 24) { "recovery-words: wordCount must be 12 or 24" }
        }
    }
}

/**
 * stable HKDF info strings. **NEVER change these** without bumping the envelope kind: clients
 * in the field rely on the exact byte values. they match the extension's
 * [`vault.ts`](../../wallet-extension/src/background/vault.ts) `ENVELOPE_KEK_INFO_*` constants.
 */
object EnvelopeKekInfo {
    const val PASSKEY: String = "chromatika.envelope.passkey-prf.v1"
    const val WALLET_SIG: String = "chromatika.envelope.wallet-signature.v1"
    const val RECOVERY: String = "chromatika.envelope.recovery-words.v1"
}

/**
 * argon2id parameters used by every password envelope chromatika ever mints. **never weaken**
 * without bumping the envelope version: a weaker KEK on the same envelope kind silently makes
 * old vault blobs less crack-resistant.
 *
 *  - t = 3 (time cost in passes)
 *  - m = 65536 KiB (64 MiB memory)
 *  - p = 4 (parallelism lanes)
 *  - dkLen = 32 bytes (AES-256 key length)
 *
 * RFC 9106 §4 "second option" (memory-light). takes ~250-500 ms on a modern phone.
 */
object Argon2idParams {
    const val T: Int = 3
    const val M_KIB: Int = 65_536
    const val P: Int = 4
    const val DK_LEN: Int = 32
    const val SALT_LEN: Int = 16
    const val IV_LEN: Int = 12
    const val KEY_LEN_BITS: Int = 256
}
