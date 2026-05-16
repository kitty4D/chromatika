package xyz.chromatika.seeker.vault

import android.util.Base64
import com.lambdapioneer.argon2kt.Argon2Kt
import com.lambdapioneer.argon2kt.Argon2Mode
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * crypto primitives for the chromatika seeker vault. mirrors
 * `wallet-extension/src/background/vault.ts` byte-for-byte:
 *
 *  - argon2id (RFC 9106 §4 second option) via argon2kt - same params as extension.
 *  - AES-GCM 256 via javax.crypto - same algo + same 12-byte IV + same auth tag.
 *  - HKDF-SHA256 via bouncycastle for non-password KEKs (passkey-prf, wallet-signature,
 *    recovery-words) - same `info` strings as the extension's `ENVELOPE_KEK_INFO_*`.
 *
 * unlike the extension we don't bind to a non-extractable `CryptoKey` opaque handle (web crypto
 * only). instead we hold raw `SecretKeySpec` bytes inside the kotlin process and zero them
 * after every use. callers should follow the same pattern: wrap operations in `try / finally`
 * with `keyBytes.fill(0)` in the finally block.
 */
object VaultCrypto {

    private const val ALGO = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128

    private val rng = SecureRandom()

    /* ----------------------------------------------------------------------------
     * randomness helpers
     * ---------------------------------------------------------------------------- */

    /** 16 random salt bytes for a fresh password envelope (or v3 blob). */
    fun freshSalt(): ByteArray = ByteArray(Argon2idParams.SALT_LEN).also(rng::nextBytes)

    /** 12 random IV bytes for a fresh AES-GCM operation. */
    fun freshIv(): ByteArray = ByteArray(Argon2idParams.IV_LEN).also(rng::nextBytes)

    /** 32 random bytes for a fresh v4 master key. */
    fun freshMasterKeyBytes(): ByteArray = ByteArray(Argon2idParams.DK_LEN).also(rng::nextBytes)

    /* ----------------------------------------------------------------------------
     * argon2id KDF
     * ---------------------------------------------------------------------------- */

    /**
     * run argon2id over [password] + [kdfMeta]. returns the raw 32-byte derived key. caller
     * must zero the bytes after use (`fill(0)`).
     */
    fun deriveArgon2id(password: CharArray, kdfMeta: KdfMeta): ByteArray {
        require(kdfMeta.kdf == "argon2id") { "Unsupported vault KDF: ${kdfMeta.kdf}" }
        val salt = Base64.decode(kdfMeta.salt, Base64.NO_WRAP)
        val argon2Kt = Argon2Kt()
        val passwordBytes = charArrayToUtf8(password)
        return try {
            argon2Kt.hash(
                mode = Argon2Mode.ARGON2_ID,
                password = passwordBytes,
                salt = salt,
                tCostInIterations = kdfMeta.t,
                mCostInKibibyte = kdfMeta.m,
                parallelism = kdfMeta.p,
                hashLengthInBytes = Argon2idParams.DK_LEN,
            ).rawHashAsByteArray()
        } finally {
            passwordBytes.fill(0)
        }
    }

    /**
     * UTF-8 encode a `CharArray` without going through `String` (so the password never lands
     * in the String constant pool). mirrors the extension's `new TextEncoder().encode(password)`.
     */
    private fun charArrayToUtf8(chars: CharArray): ByteArray {
        val charBuffer = java.nio.CharBuffer.wrap(chars)
        val byteBuffer = Charsets.UTF_8.encode(charBuffer)
        val bytes = ByteArray(byteBuffer.remaining())
        byteBuffer.get(bytes)
        return bytes
    }

    /* ----------------------------------------------------------------------------
     * HKDF for non-password KEKs
     * ---------------------------------------------------------------------------- */

    /**
     * HKDF-SHA256 with empty salt and the given [info] string. mirrors
     * `hkdfDeriveKek` in `wallet-extension/src/background/vault.ts`. returns 32 raw bytes; caller
     * must zero them after use.
     */
    fun hkdfKekBytes(ikm: ByteArray, info: String): ByteArray {
        require(ikm.isNotEmpty()) { "HKDF input keying material must be non-empty" }
        val hkdf = HKDFBytesGenerator(SHA256Digest())
        hkdf.init(HKDFParameters(ikm, ByteArray(0), info.toByteArray(Charsets.UTF_8)))
        val out = ByteArray(Argon2idParams.DK_LEN)
        hkdf.generateBytes(out, 0, out.size)
        return out
    }

    /* ----------------------------------------------------------------------------
     * AES-GCM encrypt / decrypt
     * ---------------------------------------------------------------------------- */

    /** AES-GCM encrypt [plaintext] with [keyBytes] (32 bytes) and a fresh IV. */
    fun encryptGcm(keyBytes: ByteArray, plaintext: ByteArray): GcmResult {
        require(keyBytes.size == Argon2idParams.DK_LEN) {
            "AES key must be ${Argon2idParams.DK_LEN} bytes, got ${keyBytes.size}"
        }
        val iv = freshIv()
        val cipher = Cipher.getInstance(ALGO)
        val key: SecretKey = SecretKeySpec(keyBytes, "AES")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
        val ct = cipher.doFinal(plaintext)
        return GcmResult(iv = iv, ciphertextAndTag = ct)
    }

    /** AES-GCM encrypt [plaintext] with [keyBytes] and an externally-provided IV. */
    fun encryptGcmWithIv(keyBytes: ByteArray, iv: ByteArray, plaintext: ByteArray): ByteArray {
        require(iv.size == Argon2idParams.IV_LEN) { "GCM IV must be ${Argon2idParams.IV_LEN} bytes" }
        require(keyBytes.size == Argon2idParams.DK_LEN) { "AES key must be 32 bytes" }
        val cipher = Cipher.getInstance(ALGO)
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        return cipher.doFinal(plaintext)
    }

    /** AES-GCM decrypt [ciphertextAndTag] with [keyBytes] (32 bytes) and the given [iv]. */
    fun decryptGcm(keyBytes: ByteArray, iv: ByteArray, ciphertextAndTag: ByteArray): ByteArray {
        require(keyBytes.size == Argon2idParams.DK_LEN) {
            "AES key must be ${Argon2idParams.DK_LEN} bytes, got ${keyBytes.size}"
        }
        require(iv.size == Argon2idParams.IV_LEN) { "GCM IV must be ${Argon2idParams.IV_LEN} bytes" }
        val cipher = Cipher.getInstance(ALGO)
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(GCM_TAG_BITS, iv))
        return cipher.doFinal(ciphertextAndTag)
    }

    data class GcmResult(val iv: ByteArray, val ciphertextAndTag: ByteArray) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is GcmResult) return false
            return iv.contentEquals(other.iv) && ciphertextAndTag.contentEquals(other.ciphertextAndTag)
        }

        override fun hashCode(): Int = iv.contentHashCode() * 31 + ciphertextAndTag.contentHashCode()
    }
}

/* ----------------------------------------------------------------------------
 * base64 helpers (NO_WRAP - matches `btoa` / `atob`)
 * ---------------------------------------------------------------------------- */

internal fun ByteArray.toBase64NoWrap(): String = Base64.encodeToString(this, Base64.NO_WRAP)

internal fun String.fromBase64NoWrap(): ByteArray = Base64.decode(this, Base64.NO_WRAP)
