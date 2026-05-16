package xyz.chromatika.seeker.identity

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import xyz.chromatika.seeker.chains.solana.Base58

/**
 * [SeedVaultIdentity] backed by an Ed25519 seed held in process memory. used by the
 * password-only vault path: when the vault unlocks, the in-vault seed is loaded into one of
 * these and lives for the duration of the unlock session, then zeroed.
 *
 * **trust note**: the seed bytes live in JVM heap while the wallet is unlocked. that is the
 * same trust property as the chrome extension's session-resident ika fee key + MWA-derived
 * solana keypair. on a real seeker, prefer the seed vault path so the secret never enters the
 * app's address space at all.
 *
 * deterministic per RFC 8032: same seed bytes produce the same signature for the same message
 * on any device, which is the contract the rest of the codebase relies on.
 */
class InVaultIdentity private constructor(
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

    /** zero the held seed bytes. once called, sign / pubkey access throws. */
    fun zero() {
        seed32.fill(0)
    }

    companion object {
        /** derive a fresh identity from a 32-byte ed25519 seed. caller owns key hygiene. */
        fun fromSeed(seed32: ByteArray): InVaultIdentity {
            require(seed32.size == 32) { "ed25519 seed must be 32 bytes" }
            val priv = Ed25519PrivateKeyParameters(seed32, 0)
            val pub = priv.generatePublicKey().encoded
            return InVaultIdentity(seed32.copyOf(), pub)
        }
    }
}
