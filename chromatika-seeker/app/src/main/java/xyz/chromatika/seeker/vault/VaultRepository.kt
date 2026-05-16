package xyz.chromatika.seeker.vault

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import xyz.chromatika.seeker.chains.solana.Base58
import java.security.SecureRandom
import java.util.UUID

/**
 * high-level orchestrator for vault create / unlock / lock. wraps the storage + crypto
 * layers and keeps the in-memory unlocked session under a single owner so we don't
 * accidentally hold master-key bytes in multiple places.
 *
 * threading: all suspending entry points hop to [Dispatchers.Default] so argon2id (~250-500ms
 * on a phone) doesn't block the main thread. callers can invoke from any context.
 */
class VaultRepository(private val context: Context) {

    private val store = VaultStore(context)
    private val sessionFlow = MutableStateFlow<UnlockSession?>(null)
    private val rng = SecureRandom()

    /** observed unlock state. `null` = locked or no vault, non-null = unlocked. */
    val session: StateFlow<UnlockSession?> = sessionFlow.asStateFlow()

    /** true if there's a persisted vault blob at all (regardless of unlock state). */
    val hasVaultFlow: Flow<Boolean> = store.blobFlow.map { it != null }

    suspend fun hasVault(): Boolean = withContext(Dispatchers.IO) { store.read() != null }

    /**
     * create a brand-new vault with a single password envelope + a freshly-generated in-vault
     * ed25519 seed. the wallet home immediately has a real solana address to display.
     *
     * the seed is stored encrypted at rest (it's inside the payload, which itself is encrypted
     * by the v4 blob's master key). while unlocked, the seed lives in [UnlockSession] memory.
     */
    suspend fun createPasswordOnlyVault(password: CharArray): UnlockSession =
        withContext(Dispatchers.Default) {
            val now = System.currentTimeMillis()
            val seed = ByteArray(32).also(rng::nextBytes)
            try {
                val pub = Ed25519PrivateKeyParameters(seed, 0).generatePublicKey().encoded
                val account = AccountRecord(
                    id = "acct-${UUID.randomUUID()}",
                    label = "in-vault account",
                    source = AccountSource.InVault,
                    solanaAddressBase58 = Base58.encode(pub),
                    solanaPublicKeyB64 = pub.toBase64NoWrap(),
                    createdAtEpochMs = now,
                )
                val payload = VaultPayload(
                    createdAtEpochMs = now,
                    accounts = listOf(account),
                    activeAccountId = account.id,
                    inVaultEd25519SeedB64 = seed.toBase64NoWrap(),
                )
                writeAndUnlock(payload, password)
            } finally {
                seed.fill(0)
            }
        }

    /**
     * create a vault that combines a password envelope + a wallet-signature envelope (seed
     * vault on seeker). both envelopes wrap the same master key; the user can later unlock
     * via either.
     *
     * accounts are stamped as [AccountSource.SeedVault] - signing requires
     * `SeedVaultSdkBinding`, not the in-vault seed path.
     */
    suspend fun createSeederVault(
        password: CharArray,
        seedVaultSignature: ByteArray,
        seedVaultAddress: String,
        seedVaultPublicKey: ByteArray,
    ): UnlockSession = withContext(Dispatchers.Default) {
        val now = System.currentTimeMillis()
        require(seedVaultPublicKey.size == 32) { "seed vault solana pubkey must be 32 bytes" }
        val account = AccountRecord(
            id = "acct-${UUID.randomUUID()}",
            label = "seeker",
            source = AccountSource.SeedVault,
            solanaAddressBase58 = seedVaultAddress,
            solanaPublicKeyB64 = seedVaultPublicKey.toBase64NoWrap(),
            createdAtEpochMs = now,
        )
        val payload = VaultPayload(
            createdAtEpochMs = now,
            accounts = listOf(account),
            activeAccountId = account.id,
        )
        val masterKey = VaultCrypto.freshMasterKeyBytes()
        try {
            val pwEnv = VaultEncryption.buildPasswordEnvelope(masterKey, password)
            val sigEnv = VaultEncryption.buildWalletSignatureEnvelope(
                masterKeyBytes = masterKey,
                signature = seedVaultSignature,
                source = VaultEncryption.WalletSignatureSource.Seeker,
                address = seedVaultAddress,
                label = "seeker",
            )
            val blob = VaultEncryption.buildBlobV4(
                envelopes = listOf(pwEnv, sigEnv),
                masterKeyBytes = masterKey,
                payloadJson = payload.toJson(),
            )
            store.write(VaultBlobJson.encode(blob))
            val sess = UnlockSession(payload = payload, masterKeyBytes = masterKey.copyOf())
            sessionFlow.value = sess
            sess
        } finally {
            masterKey.fill(0)
        }
    }

    /** unlock the persisted vault with a password. caller owns lifecycle of the returned session. */
    suspend fun unlockWithPassword(password: CharArray): UnlockSession = withContext(Dispatchers.Default) {
        val blobJson = store.read() ?: throw IllegalStateException("no vault to unlock")
        val blob = VaultBlobJson.decodeV4(blobJson)
        val result = VaultEncryption.unlockWithPassword(blob, password)
        try {
            val payload = VaultPayload.fromJson(result.payloadJson)
            val sess = UnlockSession(payload = payload, masterKeyBytes = result.masterKeyBytes.copyOf())
            sessionFlow.value = sess
            sess
        } finally {
            result.masterKeyBytes.fill(0)
        }
    }

    /** unlock via a seed-vault signature over the canonical USK derivation message. */
    suspend fun unlockWithSeederSignature(signature: ByteArray): UnlockSession =
        withContext(Dispatchers.Default) {
            val blobJson = store.read() ?: throw IllegalStateException("no vault to unlock")
            val blob = VaultBlobJson.decodeV4(blobJson)
            val result = VaultEncryption.unlockWithWalletSignature(
                blob = blob,
                signature = signature,
                source = VaultEncryption.WalletSignatureSource.Seeker,
            )
            try {
                val payload = VaultPayload.fromJson(result.payloadJson)
                val sess = UnlockSession(payload = payload, masterKeyBytes = result.masterKeyBytes.copyOf())
                sessionFlow.value = sess
                sess
            } finally {
                result.masterKeyBytes.fill(0)
            }
        }

    /** zero the in-memory session. does not touch persisted state. */
    fun lock() {
        sessionFlow.value?.close()
        sessionFlow.value = null
    }

    /** wipe the persisted vault (and lock if needed). used for "remove vault" flows. */
    suspend fun wipe() {
        lock()
        withContext(Dispatchers.IO) { store.clear() }
    }

    /* ----------------------------------------------------------------------------
     * internal helpers
     * ---------------------------------------------------------------------------- */

    private suspend fun writeAndUnlock(
        payload: VaultPayload,
        password: CharArray,
    ): UnlockSession {
        val masterKey = VaultCrypto.freshMasterKeyBytes()
        return try {
            val envelope = VaultEncryption.buildPasswordEnvelope(masterKey, password)
            val blob = VaultEncryption.buildBlobV4(
                envelopes = listOf(envelope),
                masterKeyBytes = masterKey,
                payloadJson = payload.toJson(),
            )
            store.write(VaultBlobJson.encode(blob))
            val sess = UnlockSession(payload = payload, masterKeyBytes = masterKey.copyOf())
            sessionFlow.value = sess
            sess
        } finally {
            masterKey.fill(0)
        }
    }
}
