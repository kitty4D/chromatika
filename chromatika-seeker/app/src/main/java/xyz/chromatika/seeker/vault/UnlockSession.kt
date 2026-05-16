package xyz.chromatika.seeker.vault

import xyz.chromatika.seeker.identity.InVaultIdentity
import xyz.chromatika.seeker.identity.SeedVaultIdentity

/**
 * the unlocked vault. holds:
 *  - parsed [VaultPayload] (typed account list + active id + in-vault seed b64).
 *  - master key bytes used to re-encrypt on any write.
 *  - lazily-materialized [SeedVaultIdentity] per account id so consumers don't re-decode
 *    seed bytes on every sign.
 *
 * the master key bytes + in-vault seed bytes both zero on [close]. callers should `use {}`
 * the session or scope it to the unlock lifetime managed by [VaultRepository] so memory
 * doesn't keep the secret material around past lock.
 */
class UnlockSession(
    val payload: VaultPayload,
    private val masterKeyBytes: ByteArray,
) : AutoCloseable {

    @Volatile
    private var zeroed: Boolean = false

    private val identityCache: MutableMap<String, InVaultIdentity> = mutableMapOf()

    /** convenience accessor for the active account record, or null when no accounts exist. */
    val activeAccount: AccountRecord? get() = payload.activeAccount()

    /**
     * return a [SeedVaultIdentity] for [accountId]. for [AccountSource.InVault] accounts we
     * derive on first call and cache; other sources need their own wiring (seed vault SDK
     * binding for [AccountSource.SeedVault], etc) and aren't reachable here yet.
     */
    fun identityFor(accountId: String): SeedVaultIdentity {
        check(!zeroed) { "unlock session is closed" }
        val account = payload.accounts.firstOrNull { it.id == accountId }
            ?: error("no account with id=$accountId in vault payload")
        return when (account.source) {
            AccountSource.InVault -> identityCache.getOrPut(accountId) {
                val seedB64 = payload.inVaultEd25519SeedB64
                    ?: error("vault payload has an in-vault account but no seed bytes")
                val seedBytes = seedB64.fromBase64NoWrap()
                require(seedBytes.size == 32) { "in-vault seed must be 32 bytes (got ${seedBytes.size})" }
                InVaultIdentity.fromSeed(seedBytes).also {
                    seedBytes.fill(0)
                }
            }
            AccountSource.SeedVault,
            AccountSource.Mnemonic,
            AccountSource.Imported,
            AccountSource.IkaDerived,
            -> error(
                "account ${account.id} source=${account.source} is not yet wired in UnlockSession. " +
                    "seed vault uses SeedVaultSdkBinding directly; the others land in subsequent phases.",
            )
        }
    }

    /** convenience: identity for the active account, or null when there are no accounts. */
    fun activeIdentity(): SeedVaultIdentity? = activeAccount?.let { identityFor(it.id) }

    /** read-only view of the master key bytes. `null` after [close]. */
    fun masterKeyBytesOrNull(): ByteArray? = if (zeroed) null else masterKeyBytes

    /** zero the master key + every cached identity's seed. idempotent. */
    override fun close() {
        if (zeroed) return
        masterKeyBytes.fill(0)
        identityCache.values.forEach { it.zero() }
        identityCache.clear()
        zeroed = true
    }
}
