package xyz.chromatika.seeker.vault

/**
 * high-level vault encryption / decryption helpers. wrap the primitives in [VaultCrypto] with
 * the same envelope semantics as the extension: a v4 blob carries a list of envelopes; any one
 * envelope unwraps the same master key; the master key decrypts the payload.
 *
 * none of these functions persist anything. [VaultStore] handles persistence; this file is
 * pure encrypt/decrypt/build/unwrap math against [VaultBlob] data classes.
 */
object VaultEncryption {

    /* ----------------------------------------------------------------------------
     * payload encrypt / decrypt under the master key
     * ---------------------------------------------------------------------------- */

    /** encrypt [payloadJson] under the v4 master key. returns the iv + ciphertext for the blob. */
    fun encryptPayload(masterKeyBytes: ByteArray, payloadJson: String): EncryptedPayload {
        val res = VaultCrypto.encryptGcm(masterKeyBytes, payloadJson.toByteArray(Charsets.UTF_8))
        return EncryptedPayload(iv = res.iv.toBase64NoWrap(), data = res.ciphertextAndTag.toBase64NoWrap())
    }

    /** decrypt a v4 blob's payload bytes back into the original JSON. throws on tag mismatch. */
    fun decryptPayload(masterKeyBytes: ByteArray, blob: VaultBlob.V4): String {
        val plain = VaultCrypto.decryptGcm(
            keyBytes = masterKeyBytes,
            iv = blob.iv.fromBase64NoWrap(),
            ciphertextAndTag = blob.data.fromBase64NoWrap(),
        )
        return plain.toString(Charsets.UTF_8)
    }

    data class EncryptedPayload(val iv: String, val data: String)

    /* ----------------------------------------------------------------------------
     * master key wrap / unwrap per envelope
     * ---------------------------------------------------------------------------- */

    /** wrap [masterKeyBytes] under a KEK derived from the given [kekBytes]. */
    fun wrapMasterKey(masterKeyBytes: ByteArray, kekBytes: ByteArray): WrappedKey {
        require(masterKeyBytes.size == Argon2idParams.DK_LEN) { "master key must be 32 bytes" }
        val res = VaultCrypto.encryptGcm(kekBytes, masterKeyBytes)
        return WrappedKey(wrapIv = res.iv.toBase64NoWrap(), wrappedMasterKey = res.ciphertextAndTag.toBase64NoWrap())
    }

    /** unwrap the master key from an envelope using a KEK. throws on tag mismatch (wrong KEK). */
    fun unwrapMasterKey(envelope: VaultEnvelope, kekBytes: ByteArray): ByteArray {
        val mk = VaultCrypto.decryptGcm(
            keyBytes = kekBytes,
            iv = envelope.wrapIv.fromBase64NoWrap(),
            ciphertextAndTag = envelope.wrappedMasterKey.fromBase64NoWrap(),
        )
        require(mk.size == Argon2idParams.DK_LEN) { "unwrapped master key has wrong length: ${mk.size}" }
        return mk
    }

    data class WrappedKey(val wrapIv: String, val wrappedMasterKey: String)

    /* ----------------------------------------------------------------------------
     * envelope builders (one per kind)
     * ---------------------------------------------------------------------------- */

    /**
     * build a password envelope. derives a fresh-salt argon2id KEK, wraps the master key, and
     * zeroes the KEK bytes before returning.
     */
    fun buildPasswordEnvelope(
        masterKeyBytes: ByteArray,
        password: CharArray,
        opts: PasswordEnvelopeOptions = PasswordEnvelopeOptions(),
    ): VaultEnvelope.Password {
        val kdfMeta = opts.reuseKdfMeta ?: KdfMeta(salt = VaultCrypto.freshSalt().toBase64NoWrap())
        val kekBytes = VaultCrypto.deriveArgon2id(password, kdfMeta)
        val wrapped = try {
            wrapMasterKey(masterKeyBytes, kekBytes)
        } finally {
            kekBytes.fill(0)
        }
        return VaultEnvelope.Password(
            id = opts.id ?: "env-pw-${System.currentTimeMillis()}",
            label = opts.label ?: "password",
            addedAtEpochMs = opts.addedAtEpochMs ?: System.currentTimeMillis(),
            kdf = "argon2id",
            salt = kdfMeta.salt,
            t = kdfMeta.t,
            m = kdfMeta.m,
            p = kdfMeta.p,
            wrapIv = wrapped.wrapIv,
            wrappedMasterKey = wrapped.wrappedMasterKey,
        )
    }

    /** build a wallet-signature envelope. KEK = HKDF(signature, [EnvelopeKekInfo.WALLET_SIG]). */
    fun buildWalletSignatureEnvelope(
        masterKeyBytes: ByteArray,
        signature: ByteArray,
        source: WalletSignatureSource,
        address: String,
        hint: String? = null,
        label: String? = null,
        id: String? = null,
    ): VaultEnvelope.WalletSignature {
        val kek = VaultCrypto.hkdfKekBytes(signature, EnvelopeKekInfo.WALLET_SIG)
        val wrapped = try {
            wrapMasterKey(masterKeyBytes, kek)
        } finally {
            kek.fill(0)
        }
        return VaultEnvelope.WalletSignature(
            id = id ?: "env-${source.wire}-${System.currentTimeMillis()}",
            label = label ?: source.wire,
            addedAtEpochMs = System.currentTimeMillis(),
            wrapIv = wrapped.wrapIv,
            wrappedMasterKey = wrapped.wrappedMasterKey,
            source = source.wire,
            address = address,
            hint = hint,
        )
    }

    /** build a passkey-prf envelope. KEK = HKDF(prfSecret, [EnvelopeKekInfo.PASSKEY]). */
    fun buildPasskeyPrfEnvelope(
        masterKeyBytes: ByteArray,
        prfSecret: ByteArray,
        credentialIdB64Url: String,
        rpId: String,
        prfSaltB64: String,
        label: String? = null,
        id: String? = null,
    ): VaultEnvelope.PasskeyPrf {
        val kek = VaultCrypto.hkdfKekBytes(prfSecret, EnvelopeKekInfo.PASSKEY)
        val wrapped = try {
            wrapMasterKey(masterKeyBytes, kek)
        } finally {
            kek.fill(0)
        }
        return VaultEnvelope.PasskeyPrf(
            id = id ?: "env-passkey-${System.currentTimeMillis()}",
            label = label ?: "passkey",
            addedAtEpochMs = System.currentTimeMillis(),
            wrapIv = wrapped.wrapIv,
            wrappedMasterKey = wrapped.wrappedMasterKey,
            credentialIdB64Url = credentialIdB64Url,
            rpId = rpId,
            prfSaltB64 = prfSaltB64,
        )
    }

    /** build a recovery-words envelope. KEK = HKDF(bip39Seed, [EnvelopeKekInfo.RECOVERY]). */
    fun buildRecoveryWordsEnvelope(
        masterKeyBytes: ByteArray,
        bip39Seed: ByteArray,
        wordCount: Int,
        label: String? = null,
        id: String? = null,
    ): VaultEnvelope.RecoveryWords {
        require(wordCount == 12 || wordCount == 24) { "wordCount must be 12 or 24" }
        val kek = VaultCrypto.hkdfKekBytes(bip39Seed, EnvelopeKekInfo.RECOVERY)
        val wrapped = try {
            wrapMasterKey(masterKeyBytes, kek)
        } finally {
            kek.fill(0)
        }
        return VaultEnvelope.RecoveryWords(
            id = id ?: "env-recovery-${System.currentTimeMillis()}",
            label = label ?: "$wordCount-word phrase",
            addedAtEpochMs = System.currentTimeMillis(),
            wrapIv = wrapped.wrapIv,
            wrappedMasterKey = wrapped.wrappedMasterKey,
            wordCount = wordCount,
        )
    }

    data class PasswordEnvelopeOptions(
        val id: String? = null,
        val label: String? = null,
        val addedAtEpochMs: Long? = null,
        val reuseKdfMeta: KdfMeta? = null,
    )

    /** which protocol the unlock UI drives to reproduce a wallet-signature envelope. */
    enum class WalletSignatureSource(val wire: String) {
        Seeker("seeker"),
        Waap("waap"),
        WalletConnect("walletconnect"),
    }

    /* ----------------------------------------------------------------------------
     * full encrypt / unlock convenience
     * ---------------------------------------------------------------------------- */

    /** build a fresh v4 blob from [envelopes] + an encrypted [payloadJson]. */
    fun buildBlobV4(
        envelopes: List<VaultEnvelope>,
        masterKeyBytes: ByteArray,
        payloadJson: String,
    ): VaultBlob.V4 {
        require(envelopes.isNotEmpty()) { "v4 blob requires at least one envelope" }
        val payload = encryptPayload(masterKeyBytes, payloadJson)
        return VaultBlob.V4(v = 4, envelopes = envelopes, iv = payload.iv, data = payload.data)
    }

    /**
     * unlock a v4 blob using a password envelope. derives the KEK via argon2id, unwraps the
     * master key, and decrypts the payload. zeroes the KEK and master key bytes before throwing
     * or returning. **callers must zero the returned master key bytes** when they are done.
     */
    fun unlockWithPassword(blob: VaultBlob.V4, password: CharArray): UnlockResult {
        val pw = blob.envelopes.filterIsInstance<VaultEnvelope.Password>().firstOrNull()
            ?: throw IllegalArgumentException("blob has no password envelope")
        val kdfMeta = KdfMeta(salt = pw.salt, t = pw.t, m = pw.m, p = pw.p)
        val kekBytes = VaultCrypto.deriveArgon2id(password, kdfMeta)
        val masterKeyBytes = try {
            unwrapMasterKey(pw, kekBytes)
        } catch (e: Throwable) {
            throw IllegalArgumentException("Wrong password", e)
        } finally {
            kekBytes.fill(0)
        }
        val payloadJson = try {
            decryptPayload(masterKeyBytes, blob)
        } catch (e: Throwable) {
            masterKeyBytes.fill(0)
            throw e
        }
        return UnlockResult(payloadJson = payloadJson, masterKeyBytes = masterKeyBytes)
    }

    /** unlock a v4 blob using a wallet-signature envelope (seeker / waap / walletconnect). */
    fun unlockWithWalletSignature(
        blob: VaultBlob.V4,
        signature: ByteArray,
        source: WalletSignatureSource,
    ): UnlockResult {
        val env = blob.envelopes
            .filterIsInstance<VaultEnvelope.WalletSignature>()
            .firstOrNull { it.source == source.wire }
            ?: throw IllegalArgumentException("blob has no ${source.wire} wallet-signature envelope")
        val kek = VaultCrypto.hkdfKekBytes(signature, EnvelopeKekInfo.WALLET_SIG)
        val masterKeyBytes = try {
            unwrapMasterKey(env, kek)
        } catch (e: Throwable) {
            throw IllegalArgumentException("wallet-signature envelope unlock failed", e)
        } finally {
            kek.fill(0)
        }
        val payloadJson = try {
            decryptPayload(masterKeyBytes, blob)
        } catch (e: Throwable) {
            masterKeyBytes.fill(0)
            throw e
        }
        return UnlockResult(payloadJson = payloadJson, masterKeyBytes = masterKeyBytes)
    }

    /**
     * payload JSON + the unwrapped master key bytes. caller MUST zero [masterKeyBytes] after
     * the session ends. typical pattern:
     *
     * ```kotlin
     * val r = VaultEncryption.unlockWithPassword(blob, password)
     * try {
     *     // use r.payloadJson + r.masterKeyBytes in session
     * } finally {
     *     r.masterKeyBytes.fill(0)
     * }
     * ```
     */
    data class UnlockResult(val payloadJson: String, val masterKeyBytes: ByteArray) {
        override fun equals(other: Any?): Boolean {
            if (this === other) return true
            if (other !is UnlockResult) return false
            return payloadJson == other.payloadJson && masterKeyBytes.contentEquals(other.masterKeyBytes)
        }

        override fun hashCode(): Int = payloadJson.hashCode() * 31 + masterKeyBytes.contentHashCode()
    }
}
