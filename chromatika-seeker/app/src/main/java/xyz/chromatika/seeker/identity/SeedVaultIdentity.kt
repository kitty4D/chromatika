package xyz.chromatika.seeker.identity

/**
 * boundary over the device's primary signing surface. on the seeker / saga this is backed by
 * the seed vault SDK; on a non-seeker dev device it is backed by a mnemonic-derived in-process
 * keypair (the seed vault simulator is a development helper that lives behind the same
 * interface). every call that signs the ika derivation message goes through this contract so
 * the rest of the codebase doesn't care which device path produced the signature.
 */
interface SeedVaultIdentity {

    /** the base58 solana address corresponding to this identity. */
    suspend fun solanaAddressBase58(): String

    /** raw 32-byte solana public key bytes. */
    suspend fun solanaPublicKey(): ByteArray

    /**
     * ask the underlying signer (seed vault, simulator, or fallback) to produce an ed25519
     * signature over `message`. RFC 8032 deterministic, so same wallet + same message →
     * identical bytes on any device.
     */
    suspend fun signMessage(message: ByteArray): ByteArray

    /**
     * convenience: derive the canonical 32-byte ika `UserShareEncryptionKeys` root seed by
     * signing [IKA_USK_DERIVATION_MESSAGE] and threading the result through
     * [ikaRootSeedFromMwaSignature]. callers should cache the returned seed in session memory
     * only, never on disk.
     */
    suspend fun deriveIkaRootSeed(encryptionKeyIndex: Int = 0): ByteArray {
        val signature = signMessage(IKA_USK_DERIVATION_MESSAGE)
        return ikaRootSeedFromMwaSignature(signature, encryptionKeyIndex)
    }

    /**
     * convenience: derive the in-app solana fee-payer keypair from the same wallet signature
     * the ika root seed uses, at the reserved fee-payer index. deterministic per wallet.
     */
    suspend fun deriveFeePayer(): SolanaKeypair {
        val signature = signMessage(IKA_USK_DERIVATION_MESSAGE)
        return solanaFeeKeypairFromWalletSignature(signature, IKA_FEE_PAYER_DERIVATION_INDEX)
    }
}
