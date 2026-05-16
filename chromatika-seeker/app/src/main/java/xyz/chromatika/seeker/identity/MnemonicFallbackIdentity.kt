package xyz.chromatika.seeker.identity

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import xyz.chromatika.seeker.chains.solana.Base58

/**
 * non-seeker dev fallback. holds a 32-byte ed25519 seed in process memory and signs
 * deterministically per RFC 8032, so derivations from this identity reproduce the same
 * dWallet IDs that a "real" seeker session would produce, given the same seed.
 *
 * **never ship this as the primary identity on a release build** - it puts secret material
 * in the kotlin heap. the [SeedVaultIdentityFactory.isAvailable] gate routes users to seed
 * vault on the seeker / saga / simulator; this fallback exists so:
 *  1. dev work proceeds on non-seeker emulators without dragging in seed vault simulator.
 *  2. unit + instrumented tests can exercise the identity contract without seed vault.
 *  3. the mnemonic / imported-privkey setup paths have a place to land before the
 *     mnemonic-backed identity ships.
 *
 * the 32-byte seed is whatever the caller provides - a SLIP-10 ed25519 derived child for
 * mnemonic flows, or a directly pasted 64-byte privkey's first 32 bytes for raw imports.
 *
 * note: shape-identical to [InVaultIdentity] today; they're kept separate so the rest of the
 * codebase can branch on intent (vault-backed signing vs test fallback) without inspecting
 * a config flag.
 */
class MnemonicFallbackIdentity private constructor(
    private val seed32: ByteArray,
    private val pubkey: ByteArray,
) : SeedVaultIdentity {

    override suspend fun solanaPublicKey(): ByteArray = pubkey.copyOf()

    override suspend fun solanaAddressBase58(): String = Base58.encode(pubkey)

    override suspend fun signMessage(message: ByteArray): ByteArray {
        val priv = Ed25519PrivateKeyParameters(seed32, 0)
        val signer = Ed25519Signer()
        signer.init(true, priv)
        signer.update(message, 0, message.size)
        return signer.generateSignature()
    }

    companion object {
        /** build a fallback identity from a 32-byte ed25519 seed. caller owns key hygiene. */
        fun fromSeed(seed32: ByteArray): MnemonicFallbackIdentity {
            require(seed32.size == 32) { "ed25519 seed must be 32 bytes" }
            val priv = Ed25519PrivateKeyParameters(seed32, 0)
            val pub = priv.generatePublicKey().encoded
            return MnemonicFallbackIdentity(seed32.copyOf(), pub)
        }
    }
}
